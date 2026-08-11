import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { PrometheusService } from 'common/prometheus';

import { LastProcessedRoot } from './last-processed-root';
import { ConfigService } from '../../common/config/config.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse } from '../../common/providers/consensus/response.interface';

/**
 * Lowest slot the daemon may start from. Not zero: the genesis block carries a default-constructed
 * body, so its execution block hash is all zeroes and cannot be resolved into an execution anchor.
 */
const EARLIEST_ANCHORABLE_SLOT = 1;

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
    // On a chain younger than the lookback window the requested slot lands before genesis and the CL
    // rejects the negative slot with a 400 every cycle. Clamp to slot 1 rather than 0: the genesis
    // block body is default-constructed, so its execution block hash is zero and no EL node can
    // resolve it into an anchor. Slot 1 is the earliest usable one and still covers the whole chain.
    const lookbackSlot = Math.max(EARLIEST_ANCHORABLE_SLOT, this.consensus.timestampToSlot(lookbackTimestamp));

    try {
      // Scan forward: the lookback slot itself may never have been proposed, and asking for a missed
      // slot 404s. On a chain with frequent missed slots that would leave the daemon without a
      // starting root cycle after cycle.
      const { slot, header } = await this.consensus.findNextAvailableHeader(lookbackSlot);
      if (header) {
        this.logger.log(
          `Using lookback slot from ${lookbackDays} days ago:` +
            `\n  Requested slot: ${lookbackSlot}` +
            `\n  Slot: ${slot}` +
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
