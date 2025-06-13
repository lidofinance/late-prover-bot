import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { RootSlot, RootsStack } from './roots-stack';
import { ConfigService } from '../../common/config/config.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../common/providers/consensus/response.interface';

interface BeaconHeaders {
  data: BlockHeaderResponse[];
  finalized: boolean;
}

@Injectable()
export class RootsProvider {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly rootsStack: RootsStack,
  ) {}

  /**
   * Returns the next root to process in the following order:
   * 1. Any unprocessed roots from the stack
   * 2. Initial root (configured or finalized)
   * 3. Child of the last processed root
   * 
   * Returns undefined if:
   * - Failed to get finalized header
   * - Last processed root matches finalized root
   * - No next root found in the processing chain
   */
  public async getNext(): Promise<BlockHeaderResponse | undefined> {
    // Get finalized header first as it's needed for validation
    const finalized = await this.consensus.getBeaconHeader('finalized');
    if (!finalized) {
      this.logger.warn('Failed to get finalized header');
      return undefined;
    }

    // Check if we're already at the finalized root
    const lastProcessed = this.rootsStack.getLastProcessed();
    //if (lastProcessed?.blockRoot === finalized.root) {
    //  this.logger.log(`Already at finalized root [${finalized.root}]`);
    //  return undefined;
    //}

    // Try processing chain
    return this.processNextRoot(finalized);
  }

  private async processNextRoot(finalized: BlockHeaderResponse): Promise<BlockHeaderResponse | undefined> {
    // Try to get from stack first
    const fromStack = await this.getStackedRoot();
    if (fromStack) return fromStack;

    // If no last processed root, try initial root with finalized fallback
    const lastProcessed = this.rootsStack.getLastProcessed();
    if (!lastProcessed) {
      const initial = await this.getInitialRoot();
      return initial ?? finalized;
    }

    // Try to get child of last processed
    const childRoot = await this.tryGetChildRoot(lastProcessed);
    return childRoot ?? finalized;
  }

  private async getStackedRoot(): Promise<BlockHeaderResponse | undefined> {
    const stacked = this.rootsStack.getNextEligible();
    if (!stacked) {
      return undefined;
    }

    this.logger.warn(
      `⏭️ Next root to process [${stacked.blockRoot}]. Taken from 📚 stack of unprocessed roots`
    );
    return this.consensus.getBeaconHeader(stacked.slotNumber);
  }

  private async getInitialRoot(): Promise<BlockHeaderResponse | undefined> {
    const configuredRoot = this.config.get('START_ROOT');
    if (!configuredRoot) {
      return undefined;
    }

    this.logger.log(`No processed roots. Start from ⚙️ configured root [${configuredRoot}]`);
    return this.consensus.getBeaconHeader(configuredRoot);
  }

  private async tryGetChildRoot(
    lastProcessed: RootSlot,
  ): Promise<BlockHeaderResponse | undefined> {
    const childHeaders = await this.consensus.getBeaconHeadersByParentRoot(lastProcessed.blockRoot);
    if (!this.isValidChildHeader(childHeaders)) {
      this.logger.warn(`No finalized child header for [${lastProcessed.blockRoot}] yet`);
      return undefined;
    }

    const childRoot = childHeaders.data[0].root;
    this.logger.log(`⏭️ Next root to process [${childRoot}]. Child of last processed`);
    return this.consensus.getBeaconHeader(childRoot);
  }

  private isValidChildHeader(childHeaders: BeaconHeaders): boolean {
    return childHeaders.data.length > 0 && childHeaders.finalized;
  }
}
