import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import * as buildInfo from 'build-info';

import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import sleep from './utils/sleep';
import { ConfigService } from '../common/config/config.service';
import { APP_NAME, PrometheusService } from '../common/prometheus';
import { Consensus } from '../common/providers/consensus/consensus';

// Run once every 5 minutes
const SLEEP_TIME = 300000;

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
      // Track daemon cycle
      const stopCycleTimer = this.prometheus.daemonCycleDuration.startTimer({
        cycle_type: 'main_loop'
      });
      
      try {
        await this.baseRun();
      } catch (error) {
        this.logger.error('Error in daemon loop', error);
        
        // Track daemon sleep due to error
        this.prometheus.daemonSleepCount.inc({
          reason: 'error_recovery'
        });
        
        await sleep(SLEEP_TIME);
      } finally {
        stopCycleTimer();
        
        // Track memory usage
        const memoryUsage = process.memoryUsage();
        this.prometheus.memoryUsage.set(
          { memory_type: 'heap_used' },
          memoryUsage.heapUsed
        );
        this.prometheus.memoryUsage.set(
          { memory_type: 'heap_total' },
          memoryUsage.heapTotal
        );
        this.prometheus.memoryUsage.set(
          { memory_type: 'rss' },
          memoryUsage.rss
        );
      }
    }
  }

  private async baseRun() {
    const baseRunStartTime = Date.now();
    
    // Track roots provider operation
    const stopRootsProviderTimer = this.prometheus.rootsProcessingDuration.startTimer({
      processing_type: 'roots_fetch'
    });
    
    const roots = await this.rootsProvider.getRoots();
    stopRootsProviderTimer();
    
    if (!roots) {
      this.logger.log(`💤 Wait for the next finalized root`);
      
      // Track daemon sleep due to no roots
      this.prometheus.daemonSleepCount.inc({
        reason: 'no_new_roots'
      });
      
      await sleep(SLEEP_TIME);
      return;
    }

    // If PREV and LATEST are the same, we're caught up
    if (roots.prev.root === roots.latest.root) {
      this.logger.log(`Already at latest root [${roots.latest.root}]`);
      
      // Track when roots are the same (caught up)
      this.prometheus.rootsSameCount.inc();
      
      // Track daemon sleep due to being caught up
      this.prometheus.daemonSleepCount.inc({
        reason: 'caught_up'
      });
      
      await sleep(SLEEP_TIME);
      return;
    }

    // Track actual roots processing
    const stopRootsProcessorTimer = this.prometheus.rootsProcessingDuration.startTimer({
      processing_type: 'roots_processing'
    });
    
    try {
      await this.rootsProcessor.process(roots.prev, roots.latest);
      
      this.logger.log(
        `✅ Successfully processed roots transition:` +
        `\n  From: ${roots.prev.root} (slot ${roots.prev.header.message.slot})` +
        `\n  To: ${roots.latest.root} (slot ${roots.latest.header.message.slot})` +
        `\n  Processing time: ${Date.now() - baseRunStartTime}ms`
      );
      
    } catch (error) {
      this.logger.error('Failed to process roots', error);
      throw error;
    } finally {
      stopRootsProcessorTimer();
    }
  }
}
