import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BigNumber, ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { LidoLocatorContract } from './lido-locator.service';
import { ExitRequestsData } from './types';
import { join } from 'path';

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
  private contract: ethers.Contract;
  private readonly logger = new Logger(ExitRequestsContract.name);
  private exitBusAddress: string;

  constructor(
    protected readonly execution: Execution,
    protected readonly lidoLocator: LidoLocatorContract,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Get ValidatorsExitBusOracle address from LidoLocator
      this.exitBusAddress = await this.lidoLocator.getValidatorsExitBusOracle();
      this.logger.log(`ValidatorsExitBusOracle address from LidoLocator: ${this.exitBusAddress}`);

      // Import the full ABI JSON
      const contractJson = require(join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'validator-exit-bus-oracle.json'));
      
      // Create interface from the ABI
      const iface = new ethers.utils.Interface(contractJson);
      
      this.contract = new ethers.Contract(
        this.exitBusAddress,
        iface,
        this.execution.provider,
      );

      this.logger.log('ExitRequestsContract initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize ExitRequestsContract:', error.message);
      throw error;
    }
  }

  public async getExitRequestsFromBlock(fromBlock: number, toBlock: number): Promise<ExitRequestsResult[]> {
    try {
      this.validateBlockRange(fromBlock, toBlock);

      this.logger.debug(`Fetching exit requests from block ${fromBlock} to ${toBlock}`);
      
      // Get all ExitDataProcessing events
      const events = await this.contract.queryFilter(
        this.contract.filters.ExitDataProcessing(),
        fromBlock,
        toBlock
      );

      if (events.length === 0) {
        this.logger.debug('No exit data processing events found in the specified range');
        return [];
      }

      this.logger.debug(`Found ${events.length} exit data processing events`);

      const results: ExitRequestsResult[] = [];

      // Process each event
      for (const event of events) {
        try {
          // Process the transaction and get exit data
          const txHash = event.transactionHash;
          const tx = await this.execution.provider.getTransaction(txHash);
          if (!tx?.data) {
            this.logger.error(`Transaction ${txHash} not found or has no data`);
            continue;
          }

          // Get the exitRequestsHash from the event
          const exitRequestsHash = event.args?.exitRequestsHash;
          if (!exitRequestsHash) {
            this.logger.error('Exit requests hash not found in event');
            continue;
          }

          // Decode the submitReportData transaction
          const decodedData = this.contract.interface.decodeFunctionData('submitReportData', tx.data);

          // Log the decoded data to inspect its structure
          const reportData = decodedData.data as ReportData;

          const exitRequestsData: ExitRequestsData = {
            data: reportData.data,
            dataFormat: reportData.dataFormat.toNumber(), // This might be causing the issue
          };

          results.push({
            exitRequestsData,
            exitRequestsHash,
          });
        } catch (error) {
          this.logger.error(`Failed to process event: ${error.message}`);
          continue;
        }
      }

      return results;

    } catch (error) {
      throw new Error(
        `Failed to get exit requests from blocks ${fromBlock}-${toBlock}: ${error.message}`
      );
    }
  }

  private validateBlockRange(fromBlock: number, toBlock: number): void {
    if (!Number.isInteger(fromBlock) || fromBlock < 0) {
      throw new Error(`Invalid fromBlock: ${fromBlock}`);
    }
    if (!Number.isInteger(toBlock) || toBlock < 0) {
      throw new Error(`Invalid toBlock: ${toBlock}`);
    }
    if (fromBlock > toBlock) {
      throw new Error(`fromBlock (${fromBlock}) is greater than toBlock (${toBlock}`);
    }
  }

  public async getExitRequestDeliveryTimestamp(exitRequestsHash: string): Promise<number> {
    const timestamp = await this.contract.getDeliveryTimestamp(exitRequestsHash);
    return timestamp.toNumber();
  }
}