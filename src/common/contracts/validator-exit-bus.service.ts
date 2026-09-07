import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';

import { LidoLocatorContract } from './lido-locator.service';
import { ExitRequestsData } from './types';
import veboJson from '../contracts/abi/validator-exit-bus-oracle.json';
import { extractExitRequestsData } from '../helpers/exit-requests-calldata';
import { getSizeRangeCategory } from '../prometheus/decorators';
import { PrometheusService } from '../prometheus/prometheus.service';
import { Execution } from '../providers/execution/execution';

interface ExitRequestsResult {
  exitRequestsData: ExitRequestsData;
  exitRequestsHash: string;
}

@Injectable()
export class ExitRequestsContract implements OnModuleInit {
  private veboContract: ethers.Contract;
  private readonly logger = new Logger(ExitRequestsContract.name);
  private exitBusAddress: string;

  constructor(
    protected readonly execution: Execution,
    protected readonly lidoLocator: LidoLocatorContract,
    protected readonly prometheus: PrometheusService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Get ValidatorsExitBusOracle address from LidoLocator
      this.exitBusAddress = await this.lidoLocator.getValidatorsExitBusOracle();
      this.logger.log(`ValidatorsExitBusOracle address from LidoLocator: ${this.exitBusAddress}`);

      // Create interface from the ABI
      const veboIface = new ethers.utils.Interface(veboJson);

      this.veboContract = new ethers.Contract(this.exitBusAddress, veboIface, this.execution.provider);

      this.logger.log('ExitRequestsContract initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize ExitRequestsContract:', error.message);
      throw error;
    }
  }

  public async getExitRequestsFromBlock(fromBlock: number, toBlock: number): Promise<ExitRequestsResult[]> {
    const startTime = Date.now();
    const blockRange = toBlock - fromBlock;
    const rangeSizeCategory = getSizeRangeCategory(blockRange);

    // Track batch processing for exit requests
    const stopBatchTimer = this.prometheus.batchProcessingDuration.startTimer({
      batch_size_range: rangeSizeCategory,
    });

    // Track batch size
    this.prometheus.batchSize.observe({ processing_type: 'exit_requests_fetch' }, blockRange);

    try {
      // Check for invalid block range and skip processing if invalid
      if (fromBlock > toBlock) {
        this.logger.warn(`Skipping block range processing: fromBlock (${fromBlock}) > toBlock (${toBlock}).`);
        return [];
      }

      this.validateBlockRange(fromBlock, toBlock);

      this.logger.debug(`Fetching exit requests from block ${fromBlock} to ${toBlock}`);

      // Get all ExitDataProcessing events
      const events = await this.veboContract.queryFilter(
        this.veboContract.filters.ExitDataProcessing(),
        fromBlock,
        toBlock,
      );

      if (events.length === 0) {
        this.logger.debug('No exit data processing events found in the specified range');

        // Track zero exit requests found
        this.prometheus.exitRequestsFoundCount.inc(
          {
            block_range_type: rangeSizeCategory,
          },
          0,
        );

        return [];
      }

      this.logger.debug(`Found ${events.length} exit data processing events`);

      // Track exit requests found
      this.prometheus.exitRequestsFoundCount.inc(
        {
          block_range_type: rangeSizeCategory,
        },
        events.length,
      );

      const results: ExitRequestsResult[] = [];
      const transactionCache = new Map<string, ethers.providers.TransactionResponse>();

      let processedCount = 0;
      let errorCount = 0;
      let decodeErrorCount = 0;

      // Publish the series so an alert on them works before the first hit
      for (const status of ['success', 'error', 'decode_error']) {
        this.prometheus.exitRequestsProcessedCount.inc({ status }, 0);
      }

      for (const event of events) {
        try {
          // Process the transaction and get exit data
          const txHash = event.transactionHash;

          // Check cache first, then fetch if not cached
          let tx = transactionCache.get(txHash);
          if (!tx) {
            tx = await this.execution.provider.getTransaction(txHash);
            if (tx) {
              transactionCache.set(txHash, tx);
              this.logger.debug(`Cached transaction ${txHash}`);
            }
          } else {
            this.logger.debug(`Using cached transaction ${txHash}`);
          }

          if (!tx?.data) {
            this.logger.error(`Transaction ${txHash} not found or has no data`);
            continue;
          }

          // Check if transaction was successful
          const receipt = await this.execution.provider.getTransactionReceipt(txHash);
          if (!receipt || receipt.status !== 1) {
            this.logger.debug(`Skipping unsuccessful transaction ${txHash}, status: ${receipt?.status}`);
            continue;
          }

          // Get the exitRequestsHash from the event
          const exitRequestsHash = event.args?.exitRequestsHash;
          if (!exitRequestsHash) {
            this.logger.error('Exit requests hash not found in event');
            continue;
          }

          const extracted = extractExitRequestsData(tx.data, exitRequestsHash);
          if (!extracted) {
            decodeErrorCount++;
            this.logger.error(
              `Failed to extract exit requests data for ${txHash}:` +
                `\n  Exit requests hash: ${exitRequestsHash}` +
                `\n  Transaction target: ${tx.to}` +
                `\n  Calldata selector: ${ethers.utils.hexDataSlice(tx.data, 0, 4)}` +
                `\n  Calldata size: ${ethers.utils.hexDataLength(tx.data)} bytes`,
            );
            continue;
          }

          if (extracted.offset !== 0) {
            this.logger.debug(
              `Recovered ${extracted.method} payload nested at byte offset ${extracted.offset} in ${txHash}`,
            );
          }

          processedCount++;
          results.push({
            exitRequestsData: { data: extracted.data, dataFormat: extracted.dataFormat },
            exitRequestsHash,
          });
        } catch (error) {
          errorCount++;
          this.logger.error(`Failed to process event: ${error.message}`);
          continue;
        }
      }

      // Track processing results
      this.prometheus.exitRequestsProcessedCount.inc({ status: 'success' }, processedCount);

      if (errorCount > 0) {
        this.prometheus.exitRequestsProcessedCount.inc({ status: 'error' }, errorCount);
      }

      if (decodeErrorCount > 0) {
        this.prometheus.exitRequestsProcessedCount.inc({ status: 'decode_error' }, decodeErrorCount);
      }

      const totalDuration = Date.now() - startTime;
      this.logger.debug(
        `Exit requests processing completed:` +
          `\n  Block range: ${fromBlock}-${toBlock} (${blockRange} blocks)` +
          `\n  Events found: ${events.length}` +
          `\n  Successfully processed: ${processedCount}` +
          `\n  Errors: ${errorCount}` +
          `\n  Undecodable requests: ${decodeErrorCount}` +
          `\n  Total duration: ${totalDuration}ms` +
          `\n  Avg per event: ${events.length > 0 ? (totalDuration / events.length).toFixed(2) : 0}ms`,
      );

      return results;
    } catch (error) {
      this.logger.error(`Failed to fetch exit requests from blocks ${fromBlock}-${toBlock}:`, error);

      // Track error in exit requests processing
      this.prometheus.exitRequestsProcessedCount.inc({ status: 'fetch_error' }, 1);

      throw error;
    } finally {
      stopBatchTimer();
    }
  }

  public async getExitRequestDeliveryTimestamp(exitRequestsHash: string): Promise<number> {
    const startTime = Date.now();

    // Track veboContract call for delivery timestamp
    const stopContractTimer = this.prometheus.contractCallDuration.startTimer({
      contract_type: 'exit_bus',
      method: 'getDeliveryTimestamp',
    });

    try {
      const timestamp = await this.veboContract.getDeliveryTimestamp(exitRequestsHash);

      this.prometheus.contractCallCount.inc({
        contract_type: 'exit_bus',
        method: 'getDeliveryTimestamp',
        status: 'success',
      });

      const duration = Date.now() - startTime;
      if (duration > 2000) {
        // Log slow calls
        this.logger.debug(`Slow delivery timestamp fetch: ${duration}ms for hash ${exitRequestsHash}`);
      }

      return timestamp.toNumber();
    } catch (error) {
      this.prometheus.contractCallCount.inc({
        contract_type: 'exit_bus',
        method: 'getDeliveryTimestamp',
        status: 'error',
      });

      this.logger.error(`Failed to get delivery timestamp for ${exitRequestsHash}:`, error);
      throw error;
    } finally {
      stopContractTimer();
    }
  }

  private validateBlockRange(fromBlock: number, toBlock: number): void {
    if (fromBlock < 0 || toBlock < 0) {
      throw new Error('Block numbers must be non-negative');
    }

    if (toBlock - fromBlock > 100000) {
      this.logger.warn(`Large block range detected: ${toBlock - fromBlock} blocks`);
    }
  }
}
