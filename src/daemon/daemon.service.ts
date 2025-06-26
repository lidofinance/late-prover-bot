import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import * as buildInfo from 'build-info';

import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import sleep from './utils/sleep';
import { ConfigService } from '../common/config/config.service';
import { APP_NAME, PrometheusService } from '../common/prometheus';
import { Consensus } from '../common/providers/consensus/consensus';

@Injectable()
export class DaemonService implements OnModuleInit {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly rootsProvider: RootsProvider,
    protected readonly rootsProcessor: RootsProcessor,
  ) {}

  async onModuleInit() {
    this.logger.log('Working mode: DAEMON');
    const env = this.config.get('NODE_ENV');
    const version = buildInfo.version;
    const commit = buildInfo.commit;
    const branch = buildInfo.branch;
    const name = APP_NAME;

    this.prometheus.buildInfo.labels({ env, name, version, commit, branch }).inc();
  }

  public async run() {
    while (true) {
      try {
        await this.baseRun();
      } catch (error) {
        this.logger.error('Error in daemon loop', error);
        await sleep(12000);
      }
    }
  }

  private async baseRun() {
    const roots = await this.rootsProvider.getRoots();
    if (!roots) {
      this.logger.log(`💤 Wait for the next finalized root`);
      await sleep(12000);
      return;
    }

    // If PREV and LATEST are the same, we're caught up
    if (roots.prev.root === roots.latest.root) {
      this.logger.log(`Already at latest root [${roots.latest.root}]`);
      await sleep(12000);
      return;
    }

    await this.rootsProcessor.process(roots.prev, roots.latest);
  }
}
