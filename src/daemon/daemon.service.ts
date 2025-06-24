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

  public async loop() {
    while (true) {
      try {
        await this.baseRun();
      } catch (e) {
        this.logger.error(e);
      }
    }
  }

  private async baseRun() {
    const prevHeader = await this.rootsProvider.getNext();
    if (prevHeader) {
      await this.rootsProcessor.process(prevHeader);
      return;
    }
    this.logger.log(`💤 Wait for the next finalized root`);
    await sleep(12000);
  }
}
