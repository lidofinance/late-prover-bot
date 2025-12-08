import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { LabelValues } from 'prom-client';

import * as buildInfo from 'build-info';
import { Execution } from 'common/providers/execution/execution';

import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import sleep from './utils/sleep';
import { ConfigService } from '../common/config/config.service';
import { serializeError } from '../common/logger/safe-error-format';
import { APP_NAME, PrometheusService } from '../common/prometheus';
import { Consensus } from '../common/providers/consensus/consensus';

@Injectable()
export class DaemonService implements OnModuleInit {
  private account?: string;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly execution: Execution,
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
    const DAEMON_SLEEP_INTERVAL_MS = this.config.get('DAEMON_SLEEP_INTERVAL_MS');
    const WORKING_MODE = this.config.get('WORKING_MODE');
    const START_LOOKBACK_DAYS = this.config.get('START_LOOKBACK_DAYS');
    const LIDO_LOCATOR_ADDRESS = this.config.get('LIDO_LOCATOR_ADDRESS');
    const TX_SIGNER_PRIVATE_KEY = this.config.get('TX_SIGNER_PRIVATE_KEY');
    let account = 'None';
    if (TX_SIGNER_PRIVATE_KEY) {
      const address = new ethers.Wallet(TX_SIGNER_PRIVATE_KEY).address;
      account = address;
      this.account = address;
    }
    const TX_MIN_GAS_PRIORITY_FEE = this.config.get('TX_MIN_GAS_PRIORITY_FEE');
    const TX_MAX_GAS_PRIORITY_FEE = this.config.get('TX_MAX_GAS_PRIORITY_FEE');
    const TX_GAS_PRIORITY_FEE_PERCENTILE = this.config.get('TX_GAS_PRIORITY_FEE_PERCENTILE');
    const TX_GAS_FEE_HISTORY_DAYS = this.config.get('TX_GAS_FEE_HISTORY_DAYS');
    const TX_GAS_FEE_HISTORY_PERCENTILE = this.config.get('TX_GAS_FEE_HISTORY_PERCENTILE');
    const TX_GAS_LIMIT = this.config.get('TX_GAS_LIMIT');
    const VALIDATOR_BATCH_SIZE = this.config.get('VALIDATOR_BATCH_SIZE');
    const MAX_TRANSACTION_SIZE_BYTES = this.config.get('MAX_TRANSACTION_SIZE_BYTES');
    const TX_MINING_WAITING_TIMEOUT_MS = this.config.get('TX_MINING_WAITING_TIMEOUT_MS');
    const TX_CONFIRMATIONS = this.config.get('TX_CONFIRMATIONS');
    const HTTP_PORT = this.config.get('HTTP_PORT');
    const LOG_LEVEL = this.config.get('LOG_LEVEL');
    const LOG_FORMAT = this.config.get('LOG_FORMAT');
    const DRY_RUN = this.config.get('DRY_RUN');
    const CHAIN_ID = this.config.get('CHAIN_ID');
    const EL_RPC_RETRY_DELAY_MS = this.config.get('EL_RPC_RETRY_DELAY_MS');
    const EL_RPC_RESPONSE_TIMEOUT_MS = this.config.get('EL_RPC_RESPONSE_TIMEOUT_MS');
    const EL_RPC_MAX_RETRIES = this.config.get('EL_RPC_MAX_RETRIES');
    const CL_API_RETRY_DELAY_MS = this.config.get('CL_API_RETRY_DELAY_MS');
    const CL_API_RESPONSE_TIMEOUT_MS = this.config.get('CL_API_RESPONSE_TIMEOUT_MS');
    const CL_API_MAX_RETRIES = this.config.get('CL_API_MAX_RETRIES');
    const FORK_NAME = this.config.get('FORK_NAME');

    const buildInfoLabels: LabelValues<string> = {
      env: env,
      version: version,
      commit: commit,
      branch: branch,
      name: name,
      ACCOUNT: account,
      WORKING_MODE: WORKING_MODE,
      START_LOOKBACK_DAYS: START_LOOKBACK_DAYS.toString(),
      LIDO_LOCATOR_ADDRESS: LIDO_LOCATOR_ADDRESS,
      DAEMON_SLEEP_INTERVAL_MS: DAEMON_SLEEP_INTERVAL_MS.toString(),
      TX_MIN_GAS_PRIORITY_FEE: TX_MIN_GAS_PRIORITY_FEE.toString(),
      TX_MAX_GAS_PRIORITY_FEE: TX_MAX_GAS_PRIORITY_FEE.toString(),
      TX_GAS_PRIORITY_FEE_PERCENTILE: TX_GAS_PRIORITY_FEE_PERCENTILE.toString(),
      TX_GAS_FEE_HISTORY_DAYS: TX_GAS_FEE_HISTORY_DAYS.toString(),
      TX_GAS_FEE_HISTORY_PERCENTILE: TX_GAS_FEE_HISTORY_PERCENTILE.toString(),
      TX_GAS_LIMIT: TX_GAS_LIMIT.toString(),
      VALIDATOR_BATCH_SIZE: VALIDATOR_BATCH_SIZE.toString(),
      MAX_TRANSACTION_SIZE_BYTES: MAX_TRANSACTION_SIZE_BYTES.toString(),
      TX_MINING_WAITING_TIMEOUT_MS: TX_MINING_WAITING_TIMEOUT_MS.toString(),
      TX_CONFIRMATIONS: TX_CONFIRMATIONS.toString(),
      HTTP_PORT: HTTP_PORT.toString(),
      LOG_LEVEL: LOG_LEVEL,
      LOG_FORMAT: LOG_FORMAT,
      DRY_RUN: DRY_RUN.toString(),
      CHAIN_ID: CHAIN_ID.toString(),
      EL_RPC_RETRY_DELAY_MS: EL_RPC_RETRY_DELAY_MS.toString(),
      EL_RPC_RESPONSE_TIMEOUT_MS: EL_RPC_RESPONSE_TIMEOUT_MS.toString(),
      EL_RPC_MAX_RETRIES: EL_RPC_MAX_RETRIES.toString(),
      CL_API_RETRY_DELAY_MS: CL_API_RETRY_DELAY_MS.toString(),
      CL_API_RESPONSE_TIMEOUT_MS: CL_API_RESPONSE_TIMEOUT_MS.toString(),
      CL_API_MAX_RETRIES: CL_API_MAX_RETRIES.toString(),
      FORK_NAME: FORK_NAME,
    };

    this.prometheus.buildInfo.labels(buildInfoLabels).setToCurrentTime();
  }

  public async run() {
    while (true) {
      // Track daemon cycle
      const stopCycleTimer = this.prometheus.daemonCycleDuration.startTimer({
        cycle_type: 'main_loop',
      });
      if (this.account) {
        const botBalance = await this.execution.balanceOf(this.account);
        const balanceEth = ethers.utils.formatEther(botBalance);

        this.prometheus.balanceEth.set(parseFloat(balanceEth));
      }

      try {
        await this.baseRun();
      } catch (error) {
        this.logger.error('Error in daemon loop', serializeError(error));

        // Track daemon sleep due to error
        this.prometheus.daemonSleepCount.inc({
          reason: 'error_recovery',
        });

        await sleep(this.config.get('DAEMON_SLEEP_INTERVAL_MS'));
      } finally {
        stopCycleTimer();

        // Track memory usage
        const memoryUsage = process.memoryUsage();
        this.prometheus.memoryUsage.set({ memory_type: 'heap_used' }, memoryUsage.heapUsed);
        this.prometheus.memoryUsage.set({ memory_type: 'heap_total' }, memoryUsage.heapTotal);
        this.prometheus.memoryUsage.set({ memory_type: 'rss' }, memoryUsage.rss);
      }
    }
  }

  private async baseRun() {
    const baseRunStartTime = Date.now();

    // Track roots provider operation
    const stopRootsProviderTimer = this.prometheus.rootsProcessingDuration.startTimer({
      processing_type: 'roots_fetch',
    });

    const roots = await this.rootsProvider.getRoots();
    stopRootsProviderTimer();

    if (!roots) {
      this.logger.log(`💤 Wait for the next finalized root`);
      this.prometheus.latestSuccessRun.setToCurrentTime();

      // Track daemon sleep due to no roots
      this.prometheus.daemonSleepCount.inc({
        reason: 'no_new_roots',
      });

      await sleep(this.config.get('DAEMON_SLEEP_INTERVAL_MS'));
      return;
    }

    // If PREV and LATEST are the same, we're caught up
    if (roots.prev.root === roots.latest.root) {
      this.logger.log(`Already at latest root [${roots.latest.root}]`);
      this.prometheus.latestSuccessRun.setToCurrentTime();

      // Track when roots are the same (caught up)
      this.prometheus.rootsSameCount.inc();

      // Track daemon sleep due to being caught up
      this.prometheus.daemonSleepCount.inc({
        reason: 'caught_up',
      });

      await sleep(this.config.get('DAEMON_SLEEP_INTERVAL_MS'));
      return;
    }

    // Track actual roots processing
    const stopRootsProcessorTimer = this.prometheus.rootsProcessingDuration.startTimer({
      processing_type: 'roots_processing',
    });

    try {
      await this.rootsProcessor.process(roots.prev, roots.latest);
      this.prometheus.latestSuccessRun.setToCurrentTime();
      this.logger.log(
        `✅ Successfully processed roots transition:` +
          `\n  From: ${roots.prev.root} (slot ${roots.prev.header.message.slot})` +
          `\n  To: ${roots.latest.root} (slot ${roots.latest.header.message.slot})` +
          `\n  Processing time: ${Date.now() - baseRunStartTime}ms`,
      );
    } catch (error) {
      this.logger.error('Failed to process roots', serializeError(error));
      throw error;
    } finally {
      stopRootsProcessorTimer();
    }
  }
}
