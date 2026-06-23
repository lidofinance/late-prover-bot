import { SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { hexlify } from 'ethers/lib/utils';

import { LastProcessedRoot, ProcessedRoot } from './last-processed-root';
import { ConfigService } from '../../common/config/config.service';
import { ExitRequestsContract } from '../../common/contracts/validator-exit-bus.service';
import { serializeError } from '../../common/logger/safe-error-format';
import { PrometheusService, TrackTask } from '../../common/prometheus';
import { getSizeRangeCategory } from '../../common/prometheus/decorators';
import { ProverService } from '../../common/prover/prover.service';
import { Consensus, SupportedFork } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse } from '../../common/providers/consensus/response.interface';

@Injectable()
export class RootsProcessor {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly lastProcessedRoot: LastProcessedRoot,
    protected readonly prover: ProverService,
    public readonly provider: SimpleFallbackJsonRpcBatchProvider,
    protected readonly exitRequests: ExitRequestsContract,
  ) {}

  /**
   * Process roots from PREV to LATEST.
   * This will:
   * 1. Process the PREV root
   * 2. Store it as last processed root
   *
   * Note: We only process one root at a time to ensure proper ordering
   * and to avoid processing too many roots at once.
   */
  @TrackTask('roots-processing')
  public async process(prev: BlockHeaderResponse, latest: BlockHeaderResponse): Promise<void> {
    this.logger.log(`Processing root [${prev.root}] at slot [${prev.header.message.slot}]`);

    try {
      await this.processBlockRoot(prev, latest);

      // Store the processed root
      await this.handleProcessingResult({
        root: latest.root,
        slot: Number(latest.header.message.slot),
      });
    } catch (error) {
      this.logger.error(`Failed to process root [${prev.root}]`, serializeError(error));
      throw error;
    }
  }

  /**
   * Process a single block root and return the result
   */
  private async processBlockRoot(prevHeader: BlockHeaderResponse, finalizedHeader: BlockHeaderResponse): Promise<void> {
    const processingStartTime = Date.now();
    const [prevElInfo, finalizedElInfo] = await Promise.all([
      this.resolveElBlockInfo(prevHeader),
      this.resolveElBlockInfo(finalizedHeader),
    ]);

    const prevBlockNumber = prevElInfo.blockNumber;
    const finalizedBlockNumber = finalizedElInfo.blockNumber;

    const blockRange = finalizedBlockNumber - prevBlockNumber;
    const rangeSizeCategory = getSizeRangeCategory(blockRange);

    // Track block range processing
    const stopBlockRangeTimer = this.prometheus.blockRangeProcessingDuration.startTimer({
      range_size_category: rangeSizeCategory,
    });

    // Track block range size
    this.prometheus.blockRangeSize.observe({ processing_type: 'daemon_processing' }, blockRange);

    this.logger.log(
      `Processing block range:` +
        `\n  From block: ${prevBlockNumber}` +
        `\n  To block: ${finalizedBlockNumber}` +
        `\n  Range size: ${blockRange} blocks`,
    );

    try {
      // Process the block
      await this.prover.handleBlock(prevBlockNumber, finalizedBlockNumber);

      const processingDuration = Date.now() - processingStartTime;

      this.logger.log(
        `✅ Block range processing completed:` +
          `\n  Range: ${prevBlockNumber} -> ${finalizedBlockNumber}` +
          `\n  Size: ${blockRange} blocks` +
          `\n  Duration: ${processingDuration}ms` +
          `\n  Avg per block: ${(processingDuration / blockRange).toFixed(2)}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process block range ${prevBlockNumber}-${finalizedBlockNumber}`,
        serializeError(error),
      );
      throw error;
    } finally {
      stopBlockRangeTimer();
    }
  }

  private async resolveElBlockInfo(header: BlockHeaderResponse): Promise<{ blockHash: string; blockNumber: number }> {
    const { block, forkName } = await this.consensus.getBlockInfo(header.root);

    if (forkName === SupportedFork.gloas) {
      return this.consensus.getStateElBlockInfo(header.header.message.state_root);
    }

    const blockHash = hexlify((block as any).body.executionPayload.blockHash);
    const blockNumber = (await this.provider.getBlock(blockHash)).number;
    return { blockHash, blockNumber };
  }

  /**
   * Handle the result of block processing
   */
  private async handleProcessingResult(processedRoot: ProcessedRoot): Promise<void> {
    await this.lastProcessedRoot.set(processedRoot);
    this.logger.log(`✅ Successfully processed root [${processedRoot.root}] at slot [${processedRoot.slot}]`);
  }
}
