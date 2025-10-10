import { LOGGER_PROVIDER, LoggerService } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { Metrics, getOrCreateMetric } from '@willsoto/nestjs-prometheus';

import { Metric, Options } from './interfaces';
import {
  METRICS_PREFIX,
  METRIC_BATCH_PROCESSING_DURATION_SECONDS,
  METRIC_BATCH_SIZE,
  METRIC_BEACON_HEADER_FETCH_ERRORS_COUNT,
  METRIC_BEACON_STATE_DESERIALIZATION_DURATION_SECONDS,
  METRIC_BEACON_STATE_FETCH_DURATION_SECONDS,
  METRIC_BLOCK_RANGE_PROCESSING_DURATION_SECONDS,
  METRIC_BLOCK_RANGE_SIZE,
  METRIC_BUILD_INFO,
  METRIC_CONTRACT_CALL_COUNT,
  METRIC_CONTRACT_CALL_DURATION_SECONDS,
  METRIC_CONTRACT_CALL_ERRORS_COUNT,
  METRIC_CONTRACT_VERIFICATION_COUNT,
  METRIC_CURRENT_PROOF_GENERATION_COUNT,
  METRIC_DAEMON_CYCLE_DURATION_SECONDS,
  METRIC_DAEMON_SLEEP_COUNT,
  METRIC_EXIT_ALREADY_PROCESSED_COUNT,
  METRIC_EXIT_DEADLINE_FUTURE_COUNT,
  METRIC_EXIT_DEADLINE_MISSED_COUNT,
  METRIC_EXIT_REQUESTS_FOUND_COUNT,
  METRIC_EXIT_REQUESTS_PROCESSED_COUNT,
  METRIC_HIGH_GAS_FEE_INTERRUPTIONS_COUNT,
  METRIC_HISTORICAL_PROOF_GENERATION_COUNT,
  METRIC_MEMORY_USAGE_BYTES,
  METRIC_NODE_OPERATOR_OPERATIONS_COUNT,
  METRIC_OUTGOING_CL_REQUESTS_COUNT,
  METRIC_OUTGOING_CL_REQUESTS_DURATION_SECONDS,
  METRIC_OUTGOING_EL_REQUESTS_COUNT,
  METRIC_OUTGOING_EL_REQUESTS_DURATION_SECONDS,
  METRIC_PROOF_GENERATION_COUNT,
  METRIC_PROOF_GENERATION_DURATION_SECONDS,
  METRIC_ROOTS_PROCESSING_DURATION_SECONDS,
  METRIC_ROOTS_SAME_COUNT,
  METRIC_SLOT_AGE_WARNINGS_COUNT,
  METRIC_STAKING_MODULE_OPERATIONS_COUNT,
  METRIC_STATE_DESERIALIZATION_ERRORS_COUNT,
  METRIC_TASK_DURATION_SECONDS,
  METRIC_TASK_RESULT_COUNT,
  METRIC_TRANSACTION_COUNTER,
  METRIC_VALIDATORS_ELIGIBLE_COUNT,
  METRIC_VALIDATORS_PENALTY_APPLICABLE_COUNT,
  METRIC_VALIDATORS_PROCESSED_COUNT,
  METRIC_VALIDATORS_SKIPPED_COUNT,
  METRIC_VALIDATOR_GROUP_PROCESSING_DURATION_SECONDS,
  METRIC_VALIDATOR_PROCESSING_DURATION_SECONDS,
  METRIC_VALIDATOR_STORAGE_CLEANUP_COUNT,
  METRIC_VALIDATOR_STORAGE_DEADLINE_SLOTS,
  METRIC_VALIDATOR_STORAGE_SIZE,
} from './prometheus.constants';

// Re-export from decorators for backward compatibility
export { RequestStatus, TaskStatus, requestLabels } from './decorators';

@Injectable()
export class PrometheusService {
  private prefix = METRICS_PREFIX;

  constructor(@Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService) {}

  public getOrCreateMetric<T extends Metrics, L extends string>(type: T, options: Options<L>): Metric<T, L> {
    const nameWithPrefix = this.prefix + options.name;

    return getOrCreateMetric(type, {
      ...options,
      name: nameWithPrefix,
    }) as Metric<T, L>;
  }

  public buildInfo = this.getOrCreateMetric('Gauge', {
    name: METRIC_BUILD_INFO,
    help: 'Build information',
    labelNames: [
      'name',
      'version',
      'commit',
      'branch',
      'env',
      'ACCOUNT',
      'WORKING_MODE',
      'START_ROOT',
      'START_SLOT',
      'START_EPOCH',
      'LIDO_LOCATOR_ADDRESS',
      'DAEMON_SLEEP_INTERVAL_MS',
      'TX_MIN_GAS_PRIORITY_FEE',
      'TX_MAX_GAS_PRIORITY_FEE',
      'TX_GAS_PRIORITY_FEE_PERCENTILE',
      'TX_GAS_FEE_HISTORY_DAYS',
      'TX_GAS_FEE_HISTORY_PERCENTILE',
      'TX_GAS_LIMIT',
      'TX_SKIP_GAS_ESTIMATION',
      'VALIDATOR_BATCH_SIZE',
      'MAX_TRANSACTION_SIZE_BYTES',
      'TX_MINING_WAITING_TIMEOUT_MS',
      'TX_CONFIRMATIONS',
      'HTTP_PORT',
      'LOG_LEVEL',
      'LOG_FORMAT',
      'DRY_RUN',
      'CHAIN_ID',
      'EL_RPC_RETRY_DELAY_MS',
      'EL_RPC_RESPONSE_TIMEOUT_MS',
      'EL_RPC_MAX_RETRIES',
      'CL_API_RETRY_DELAY_MS',
      'CL_API_RESPONSE_TIMEOUT_MS',
      'CL_API_MAX_RETRIES',
      'FORK_NAME',
    ],
  });

  public outgoingELRequestsDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_OUTGOING_EL_REQUESTS_DURATION_SECONDS,
    help: 'Duration of outgoing execution layer requests',
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 15, 30, 60],
    labelNames: ['name', 'target'] as const,
  });

  public outgoingELRequestsCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_OUTGOING_EL_REQUESTS_COUNT,
    help: 'Count of outgoing execution layer requests',
    labelNames: ['name', 'target', 'status'] as const,
  });

  public outgoingCLRequestsDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_OUTGOING_CL_REQUESTS_DURATION_SECONDS,
    help: 'Duration of outgoing consensus layer requests',
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 15, 30, 60],
    labelNames: ['name', 'target'] as const,
  });

  public outgoingCLRequestsCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_OUTGOING_CL_REQUESTS_COUNT,
    help: 'Count of outgoing consensus layer requests',
    labelNames: ['name', 'target', 'status', 'code'] as const,
  });

  public taskDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_TASK_DURATION_SECONDS,
    help: 'Duration of task execution',
    buckets: [5, 15, 30, 60, 120, 180, 240, 300, 400, 600],
    labelNames: ['name'],
  });

  public taskCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_TASK_RESULT_COUNT,
    help: 'Count of passed or failed tasks',
    labelNames: ['name', 'status'],
  });

  public highGasFeeInterruptionsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_HIGH_GAS_FEE_INTERRUPTIONS_COUNT,
    help: 'Count of high gas fee interruptions',
  });

  public transactionCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_TRANSACTION_COUNTER,
    help: 'Count of transactions',
    labelNames: ['status'],
  });

  // Proof Generation Metrics
  public proofGenerationDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_PROOF_GENERATION_DURATION_SECONDS,
    help: 'Duration of proof generation operations',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    labelNames: ['proof_type', 'slot_type'],
  });

  public proofGenerationCount = this.getOrCreateMetric('Counter', {
    name: METRIC_PROOF_GENERATION_COUNT,
    help: 'Total count of proof generation operations',
    labelNames: ['proof_type', 'slot_type', 'status'],
  });

  public historicalProofGenerationCount = this.getOrCreateMetric('Counter', {
    name: METRIC_HISTORICAL_PROOF_GENERATION_COUNT,
    help: 'Count of historical proof generations',
    labelNames: ['status'],
  });

  public currentProofGenerationCount = this.getOrCreateMetric('Counter', {
    name: METRIC_CURRENT_PROOF_GENERATION_COUNT,
    help: 'Count of current proof generations',
    labelNames: ['status'],
  });

  // Validator Processing Metrics
  public validatorsProcessedCount = this.getOrCreateMetric('Counter', {
    name: METRIC_VALIDATORS_PROCESSED_COUNT,
    help: 'Total count of validators processed',
    labelNames: ['module_id', 'processing_type'],
  });

  public validatorsSkippedCount = this.getOrCreateMetric('Counter', {
    name: METRIC_VALIDATORS_SKIPPED_COUNT,
    help: 'Total count of validators skipped',
    labelNames: ['module_id', 'reason'],
  });

  public validatorsEligibleCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_VALIDATORS_ELIGIBLE_COUNT,
    help: 'Current count of eligible validators',
    labelNames: ['module_id'],
  });

  public validatorsPenaltyApplicableCount = this.getOrCreateMetric('Counter', {
    name: METRIC_VALIDATORS_PENALTY_APPLICABLE_COUNT,
    help: 'Count of validators with penalty applicable',
    labelNames: ['module_id', 'applicable'],
  });

  public validatorProcessingDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_VALIDATOR_PROCESSING_DURATION_SECONDS,
    help: 'Duration of individual validator processing',
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10, 20],
    labelNames: ['module_id', 'processing_type'],
  });

  public validatorGroupProcessingDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_VALIDATOR_GROUP_PROCESSING_DURATION_SECONDS,
    help: 'Duration of validator group processing',
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1200],
    labelNames: ['deadline_slot', 'group_size_range'],
  });

  // Contract Interaction Metrics
  public contractCallDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_CONTRACT_CALL_DURATION_SECONDS,
    help: 'Duration of contract calls',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30],
    labelNames: ['contract_type', 'method'],
  });

  public contractCallCount = this.getOrCreateMetric('Counter', {
    name: METRIC_CONTRACT_CALL_COUNT,
    help: 'Total count of contract calls',
    labelNames: ['contract_type', 'method', 'status'],
  });

  public contractVerificationCount = this.getOrCreateMetric('Counter', {
    name: METRIC_CONTRACT_VERIFICATION_COUNT,
    help: 'Total count of contract verifications',
    labelNames: ['verification_type', 'status'],
  });

  // Block Processing Metrics
  public blockRangeProcessingDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_BLOCK_RANGE_PROCESSING_DURATION_SECONDS,
    help: 'Duration of block range processing',
    buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
    labelNames: ['range_size_category'],
  });

  public blockRangeSize = this.getOrCreateMetric('Histogram', {
    name: METRIC_BLOCK_RANGE_SIZE,
    help: 'Size of block ranges being processed',
    buckets: [1, 10, 100, 1000, 10000, 50000, 100000, 500000],
    labelNames: ['processing_type'],
  });

  public batchProcessingDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_BATCH_PROCESSING_DURATION_SECONDS,
    help: 'Duration of batch processing operations',
    buckets: [1, 5, 10, 30, 60, 120, 300, 600],
    labelNames: ['batch_size_range'],
  });

  public batchSize = this.getOrCreateMetric('Histogram', {
    name: METRIC_BATCH_SIZE,
    help: 'Size of batches being processed',
    buckets: [1, 10, 100, 1000, 10000, 50000, 100000],
    labelNames: ['processing_type'],
  });

  public exitRequestsFoundCount = this.getOrCreateMetric('Counter', {
    name: METRIC_EXIT_REQUESTS_FOUND_COUNT,
    help: 'Total count of exit requests found',
    labelNames: ['block_range_type'],
  });

  public exitRequestsProcessedCount = this.getOrCreateMetric('Counter', {
    name: METRIC_EXIT_REQUESTS_PROCESSED_COUNT,
    help: 'Total count of exit requests processed',
    labelNames: ['status'],
  });

  // Storage and Cache Metrics
  public validatorStorageSize = this.getOrCreateMetric('Gauge', {
    name: METRIC_VALIDATOR_STORAGE_SIZE,
    help: 'Current size of validator storage',
    labelNames: ['storage_type'],
  });

  public validatorStorageDeadlineSlots = this.getOrCreateMetric('Gauge', {
    name: METRIC_VALIDATOR_STORAGE_DEADLINE_SLOTS,
    help: 'Number of deadline slots in validator storage',
    labelNames: [],
  });

  public validatorStorageCleanupCount = this.getOrCreateMetric('Counter', {
    name: METRIC_VALIDATOR_STORAGE_CLEANUP_COUNT,
    help: 'Count of validator storage cleanup operations',
    labelNames: ['cleanup_type'],
  });

  public memoryUsage = this.getOrCreateMetric('Gauge', {
    name: METRIC_MEMORY_USAGE_BYTES,
    help: 'Current memory usage in bytes',
    labelNames: ['memory_type'],
  });

  // Business Logic Metrics
  public exitAlreadyProcessedCount = this.getOrCreateMetric('Counter', {
    name: METRIC_EXIT_ALREADY_PROCESSED_COUNT,
    help: 'Count of validators already processed for exit',
    labelNames: ['module_id'],
  });

  public exitDeadlineMissedCount = this.getOrCreateMetric('Counter', {
    name: METRIC_EXIT_DEADLINE_MISSED_COUNT,
    help: 'Count of missed exit deadlines',
    labelNames: ['module_id'],
  });

  public exitDeadlineFutureCount = this.getOrCreateMetric('Counter', {
    name: METRIC_EXIT_DEADLINE_FUTURE_COUNT,
    help: 'Count of future exit deadlines',
    labelNames: ['module_id'],
  });

  public beaconStateFetchDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_BEACON_STATE_FETCH_DURATION_SECONDS,
    help: 'Duration of beacon state fetch operations',
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    labelNames: ['state_type'],
  });

  public beaconStateDeserializationDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_BEACON_STATE_DESERIALIZATION_DURATION_SECONDS,
    help: 'Duration of beacon state deserialization',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30],
    labelNames: ['fork_name'],
  });

  // Staking Module Metrics
  public stakingModuleOperationsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_STAKING_MODULE_OPERATIONS_COUNT,
    help: 'Count of staking module operations',
    labelNames: ['module_id', 'operation_type', 'status'],
  });

  public nodeOperatorOperationsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_NODE_OPERATOR_OPERATIONS_COUNT,
    help: 'Count of node operator operations',
    labelNames: ['module_id', 'operation_type', 'status'],
  });

  // Daemon Metrics
  public daemonCycleDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_DAEMON_CYCLE_DURATION_SECONDS,
    help: 'Duration of daemon processing cycles',
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1200],
    labelNames: ['cycle_type'],
  });

  public daemonSleepCount = this.getOrCreateMetric('Counter', {
    name: METRIC_DAEMON_SLEEP_COUNT,
    help: 'Count of daemon sleep cycles',
    labelNames: ['reason'],
  });

  public rootsProcessingDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_ROOTS_PROCESSING_DURATION_SECONDS,
    help: 'Duration of roots processing operations',
    buckets: [5, 15, 30, 60, 120, 300, 600, 1200, 1800],
    labelNames: ['processing_type'],
  });

  public rootsSameCount = this.getOrCreateMetric('Counter', {
    name: METRIC_ROOTS_SAME_COUNT,
    help: 'Count of times prev and latest roots are the same',
    labelNames: [],
  });

  // Error and Warning Metrics
  public slotAgeWarningsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_SLOT_AGE_WARNINGS_COUNT,
    help: 'Count of slot age warnings',
    labelNames: ['warning_type'],
  });

  public stateDeserializationErrorsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_STATE_DESERIALIZATION_ERRORS_COUNT,
    help: 'Count of state deserialization errors',
    labelNames: ['fork_name'],
  });

  public beaconHeaderFetchErrorsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_BEACON_HEADER_FETCH_ERRORS_COUNT,
    help: 'Count of beacon header fetch errors',
    labelNames: ['error_type'],
  });

  public contractCallErrorsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_CONTRACT_CALL_ERRORS_COUNT,
    help: 'Count of contract call errors',
    labelNames: ['contract_type', 'method', 'error_type'],
  });

  public latestSlot = this.getOrCreateMetric('Gauge', {
    name: 'latest_slot_number',
    help: 'Latest beacon slot number observed',
    labelNames: [],
  });

  public balanceEth = this.getOrCreateMetric('Gauge', {
    name: 'balance_eth',
    help: 'Bot balance in ETH',
    labelNames: [],
  });

  public latestSuccessRun = this.getOrCreateMetric('Gauge', {
    name: 'latest_success_run_timestamp',
    help: 'Timestamp of the latest successful run',
    labelNames: [],
  });
}

// Export the refactored decorators
export { TrackCLRequest, TrackTask, TrackWorker, TrackMetric } from './decorators';
