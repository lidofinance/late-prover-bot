import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { RootSlot, RootsStack } from './roots-stack';
import { PrometheusService, TrackTask } from '../../common/prometheus';
import { ProverService } from '../../common/prover/prover.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse } from '../../common/providers/consensus/response.interface';
import { hexlify } from 'ethers/lib/utils';
import { SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';

interface BlockProcessingResult {
  success: boolean;
  error?: Error;
  rootSlot: RootSlot;
}

@Injectable()
export class RootsProcessor {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly rootsStack: RootsStack,
    protected readonly prover: ProverService,
    public readonly provider: SimpleFallbackJsonRpcBatchProvider,
  ) { }

  /**
   * Process a block root and handle any associated validator exits
   * @param blockRootToProcess - The root of the block to process
   * @param finalizedHeader - The current finalized header
   */
  @TrackTask('process-root')
  public async process(header: BlockHeaderResponse): Promise<void> {
    try {
      this.logger.log(`🛃 Starting to process root [${header.root}]`);
      const finalizedHeader = await this.consensus.getBeaconHeader('finalized');

      const result = await this.processBlockRoot(header, finalizedHeader);

      if (!result.success) {
        this.logger.error(`Failed to process root [${header.root}]`, result.error);
        return;
      }

      await this.handleProcessingResult(result.rootSlot);

    } catch (error) {
      this.logger.error(`Unexpected error processing root [${header.root}]`, error);
      throw error;
    }
  }

  /**
   * Process a single block root and return the result
   */
  private async processBlockRoot(
    prevHeader: BlockHeaderResponse,
    finalizedHeader: BlockHeaderResponse,
  ): Promise<BlockProcessingResult> {
    try {
      // CL blocks handling
      const prevBlock = await this.consensus.getBlockInfo(prevHeader.root);
      const finalizedBlock = await this.consensus.getBlockInfo(finalizedHeader.root);
      const rootSlot: RootSlot = {
        blockRoot: prevHeader.root,
        slotNumber: prevBlock.slot,
      };
      const prevBlockHash = hexlify(prevBlock.body.executionPayload.blockHash)
      const finalizedBlockHash = hexlify(finalizedBlock.body.executionPayload.blockHash)
      // EL blocks handling
      const prevBlockNumber = (await this.provider.getBlock(prevBlockHash)).number
      const finalizedBlockNumber = (await this.provider.getBlock(finalizedBlockHash)).number
      // Add to stack first in case we need to reprocess
      await this.addToProcessingStack(rootSlot);

      // Process the block
      await this.prover.handleBlock(prevBlockNumber, finalizedBlockNumber);

      return { success: true, rootSlot };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        rootSlot: { blockRoot: finalizedHeader.root, slotNumber: 0 },
      };
    }
  }

  /**
   * Handle the result of block processing, including stack management
   */
  private async handleProcessingResult(rootSlot: RootSlot): Promise<void> {
    try {
      await this.updateLastProcessed(rootSlot);

      this.logger.log(
        `✅ Successfully processed root [${rootSlot.blockRoot}] at slot [${rootSlot.slotNumber}]`
      );

    } catch (error) {
      this.logger.error(
        `Failed to handle processing result for root [${rootSlot.blockRoot}]`,
        error
      );
      throw error;
    }
  }

  /**
   * Add a root to the processing stack
   */
  private async addToProcessingStack(rootSlot: RootSlot): Promise<void> {
    try {
      await this.rootsStack.push(rootSlot);
    } catch (error) {
      this.logger.error(`Failed to add root [${rootSlot.blockRoot}] to stack`, error);
      throw error;
    }
  }

  /**
   * Remove a root from the processing stack
   */
  private async purgeFromStack(rootSlot: RootSlot): Promise<void> {
    try {
      await this.rootsStack.purge(rootSlot);
    } catch (error) {
      this.logger.error(`Failed to purge root [${rootSlot.blockRoot}] from stack`, error);
      throw error;
    }
  }

  /**
   * Update the last processed root
   */
  private async updateLastProcessed(rootSlot: RootSlot): Promise<void> {
    try {
      await this.rootsStack.setLastProcessed(rootSlot);
    } catch (error) {
      this.logger.error(
        `Failed to update last processed root [${rootSlot.blockRoot}]`,
        error
      );
      throw error;
    }
  }
}
