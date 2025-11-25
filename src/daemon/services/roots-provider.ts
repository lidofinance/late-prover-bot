import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { PrometheusService } from 'common/prometheus';

import { LastProcessedRoot } from './last-processed-root';
import { ConfigService } from '../../common/config/config.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse } from '../../common/providers/consensus/response.interface';

@Injectable()
export class RootsProvider {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly prometheus: PrometheusService,
    protected readonly lastProcessedRoot: LastProcessedRoot,
  ) {}

  /**
   * Get both PREV and LATEST roots.
   * PREV is initialized from:
   * 1. Last processed root from memory
   * 2. Fallback to START_LOOKBACK_DAYS ago (configurable, default 7 days)
   *
   * LATEST is always the finalized root.
   *
   * Returns undefined if failed to get finalized header.
   */
  public async getRoots(): Promise<{ prev: BlockHeaderResponse; latest: BlockHeaderResponse } | undefined> {
    const prev = await this.getPrevRoot();
    if (!prev) {
      this.logger.warn('Failed to get previous root');
      return undefined;
    }

    const finalized = await this.consensus.getBeaconHeader('finalized');
    if (!finalized) {
      this.logger.warn('Failed to get finalized header');
      return undefined;
    }

    const latestSlot = finalized.header.message.slot;

    this.logger.debug?.('Roots:', {
      prev: prev.root,
      latest: finalized.root,
      prevSlot: prev.header.message.slot,
      latestSlot: latestSlot,
    });

    this.prometheus.latestSlot.set(Number(latestSlot));

    return {
      prev,
      latest: finalized,
    };
  }

  private async getPrevRoot(): Promise<BlockHeaderResponse | undefined> {
    // 1. Try to get last processed root from memory
    const lastProcessed = await this.lastProcessedRoot.get();
    if (lastProcessed) {
      const header = await this.consensus.getBeaconHeader(lastProcessed.root);
      if (header) {
        this.logger.log(`Using last processed root [${lastProcessed.root}]`);
        return header;
      }
    }

    // 2. Fallback to header from START_LOOKBACK_DAYS ago
    const lookbackDays = this.config.get('START_LOOKBACK_DAYS');
    const lookbackTimestamp = Math.floor(Date.now() / 1000) - lookbackDays * 24 * 60 * 60;
    const lookbackSlot = this.consensus.timestampToSlot(lookbackTimestamp);

    try {
      const header = await this.consensus.getBeaconHeader(lookbackSlot.toString());
      if (header) {
        this.logger.log(
          `Using lookback slot from ${lookbackDays} days ago:` +
            `\n  Slot: ${lookbackSlot}` +
            `\n  Root: [${header.root}]`,
        );
        return header;
      }
    } catch (error) {
      this.logger.warn(`Failed to get header for lookback slot [${lookbackSlot}]: ${error.message}`);
    }

    this.logger.warn('Failed to get previous root');
    return undefined;
  }
}
