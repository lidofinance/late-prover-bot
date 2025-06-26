import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { ConfigService } from '../../common/config/config.service';
import { Consensus } from "../../common/providers/consensus/consensus";
import { BlockHeaderResponse } from '../../common/providers/consensus/response.interface';
import { LastProcessedRoot } from './last-processed-root';

@Injectable()
export class RootsProvider {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly lastProcessedRoot: LastProcessedRoot,
  ) {}

  /**
   * Get both PREV and LATEST roots.
   * PREV is initialized from:
   * 1. Last processed root from file
   * 2. Fallback to START_ROOT from env
   * 3. Fallback to parent of finalized root
   * 
   * LATEST is always the finalized root.
   * 
   * Returns undefined if failed to get finalized header.
   */
  public async getRoots(): Promise<{ prev: BlockHeaderResponse; latest: BlockHeaderResponse } | undefined> {
    // Get finalized header first as we need it for both PREV and LATEST
    const finalized = await this.consensus.getBeaconHeader('finalized');
    if (!finalized) {
      this.logger.warn('Failed to get finalized header');
      return undefined;
    }

    // Get PREV root
    const prev = await this.getPrevRoot(finalized);
    if (!prev) {
      this.logger.warn('Failed to get previous root');
      return undefined;
    }
    
    this.logger.debug?.('Roots:', {
      prev: prev.root,
      latest: finalized.root,
      prevSlot: prev.header.message.slot,
      latestSlot: finalized.header.message.slot
    });

    return {
      prev,
      latest: finalized
    };
  }

  private async getPrevRoot(finalized: BlockHeaderResponse): Promise<BlockHeaderResponse | undefined> {
    // 1. Try to get last processed root from file
    const lastProcessed = await this.lastProcessedRoot.get();
    if (lastProcessed) {
      const header = await this.consensus.getBeaconHeader(lastProcessed.root);
      if (header) {
        this.logger.log(`Using last processed root [${lastProcessed.root}]`);
        return header;
      }
    }

    // 2. Try to get START_ROOT from env
    const startRoot = this.config.get('START_ROOT');
    if (startRoot) {
      const header = await this.consensus.getBeaconHeader(startRoot);
      if (header) {
        this.logger.log(`Using START_ROOT [${startRoot}]`);
        return header;
      }
    }

    // 3. Fallback to parent of finalized root
    const parentRoot = finalized.header.message.parent_root;
    if (parentRoot) {
      const header = await this.consensus.getBeaconHeader(parentRoot);
      if (header) {
        this.logger.log(`Using parent of finalized root [${parentRoot}]`);
        return header;
      }
    }

    this.logger.warn('Failed to get parent of finalized root');
    return undefined;
  }
}
