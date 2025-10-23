import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BigNumber, ethers } from 'ethers';

import { LidoLocatorContract } from './lido-locator.service';
import { ExitRequestsData } from './types';
import veboJson from '../contracts/abi/validator-exit-bus-oracle.json';
import vebJson from '../contracts/abi/validator-exit-bus.json';
import { getSizeRangeCategory } from '../prometheus/decorators';
import { PrometheusService } from '../prometheus/prometheus.service';
import { Execution } from '../providers/execution/execution';

interface ReportData {
  consensusVersion: number;
  refSlot: number;
  requestsCount: number;
  dataFormat: BigNumber;
  data: string;
}

interface ExitRequestsResult {
  exitRequestsData: ExitRequestsData;
  exitRequestsHash: string;
}

@Injectable()
export class ExitRequestsContract implements OnModuleInit {
  private veboContract: ethers.Contract;
  private readonly logger = new Logger(ExitRequestsContract.name);
  private exitBusAddress: string;
  private vebIface: ethers.utils.Interface;

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
      this.vebIface = new ethers.utils.Interface(vebJson);

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

      for (const event of events) {
        try {
          processedCount++;
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

          // Decode the submitReportData or submitExitRequestsData transaction
          let decodedData;
          let decodeMethod = '';
          try {
            decodedData = this.veboContract.interface.decodeFunctionData('submitReportData', tx.data);
            decodeMethod = 'submitReportData';
          } catch (e1) {
            try {
              decodedData = this.vebIface.decodeFunctionData('submitExitRequestsData', tx.data);
              decodeMethod = 'submitExitRequestsData';
            } catch (e2) {
              this.logger.error(`Failed to decode transaction data for ${txHash}:`, e1.message, e2.message);
              continue;
            }
          }

          // For submitExitRequestsData, the structure is different
          let reportData: ReportData;
          if (decodeMethod === 'submitExitRequestsData') {
            // Access the request struct from decodedData
            const requestStruct = decodedData.request || decodedData[0];
            if (!requestStruct || !requestStruct.data) {
              this.logger.error(
                `Request struct from ${decodeMethod} is invalid or missing 'data' property: ` +
                  JSON.stringify(
                    {
                      txHash,
                      decodeMethod,
                      requestStruct,
                      decodedDataKeys: Object.keys(decodedData),
                    },
                    null,
                    2,
                  ),
              );
              continue;
            }
            reportData = {
              consensusVersion: 0, // Not available in submitExitRequestsData
              refSlot: 0, // Not available in submitExitRequestsData
              requestsCount: 0, // Not available in submitExitRequestsData
              dataFormat: requestStruct.dataFormat,
              data: requestStruct.data,
            };
          } else {
            // For submitReportData, access data directly
            if (!decodedData || typeof decodedData !== 'object' || !('data' in decodedData)) {
              this.logger.error(
                `Decoded data from ${decodeMethod} is invalid or missing 'data' property: ` +
                  JSON.stringify(
                    {
                      txHash,
                      decodeMethod,
                      txData: tx.data,
                      decodedData,
                      decodedDataKeys: decodedData && typeof decodedData === 'object' ? Object.keys(decodedData) : null,
                    },
                    null,
                    2,
                  ),
              );
              continue;
            }
            reportData = decodedData.data as ReportData;
          }

          const exitRequestsData: ExitRequestsData = {
            data: reportData.data,
            dataFormat: reportData.dataFormat.toNumber(),
          };

          results.push({
            exitRequestsData,
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

      const totalDuration = Date.now() - startTime;
      this.logger.debug(
        `Exit requests processing completed:` +
          `\n  Block range: ${fromBlock}-${toBlock} (${blockRange} blocks)` +
          `\n  Events found: ${events.length}` +
          `\n  Successfully processed: ${processedCount}` +
          `\n  Errors: ${errorCount}` +
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
