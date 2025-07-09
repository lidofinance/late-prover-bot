export const APP_NAME = process.env.npm_package_name;
export const APP_DESCRIPTION = process.env.npm_package_description;

export const METRICS_URL = '/metrics';
export const METRICS_PREFIX = `${APP_NAME?.replace(/[- ]/g, '_')}_`;

export const METRIC_BUILD_INFO = `build_info`;

export const METRIC_OUTGOING_EL_REQUESTS_DURATION_SECONDS = `outgoing_el_requests_duration_seconds`;
export const METRIC_OUTGOING_EL_REQUESTS_COUNT = `outgoing_el_requests_count`;
export const METRIC_OUTGOING_CL_REQUESTS_DURATION_SECONDS = `outgoing_cl_requests_duration_seconds`;
export const METRIC_OUTGOING_CL_REQUESTS_COUNT = `outgoing_cl_requests_count`;
export const METRIC_TASK_DURATION_SECONDS = `task_duration_seconds`;
export const METRIC_TASK_RESULT_COUNT = `task_result_count`;

export const METRIC_HIGH_GAS_FEE_INTERRUPTIONS_COUNT = `high_gas_fee_interruptions_count`;
export const METRIC_TRANSACTION_COUNTER = `transaction_total`;

export const METRIC_DATA_ACTUALITY = `data_actuality`;
export const METRIC_LAST_PROCESSED_SLOT_NUMBER = `last_processed_slot_number`;

// Proof Generation Metrics
export const METRIC_PROOF_GENERATION_DURATION_SECONDS = `proof_generation_duration_seconds`;
export const METRIC_PROOF_GENERATION_COUNT = `proof_generation_count`;
export const METRIC_HISTORICAL_PROOF_GENERATION_COUNT = `historical_proof_generation_count`;
export const METRIC_CURRENT_PROOF_GENERATION_COUNT = `current_proof_generation_count`;

// Validator Processing Metrics
export const METRIC_VALIDATORS_PROCESSED_COUNT = `validators_processed_count`;
export const METRIC_VALIDATORS_SKIPPED_COUNT = `validators_skipped_count`;
export const METRIC_VALIDATORS_ELIGIBLE_COUNT = `validators_eligible_count`;
export const METRIC_VALIDATORS_PENALTY_APPLICABLE_COUNT = `validators_penalty_applicable_count`;
export const METRIC_VALIDATOR_PROCESSING_DURATION_SECONDS = `validator_processing_duration_seconds`;
export const METRIC_VALIDATOR_GROUP_PROCESSING_DURATION_SECONDS = `validator_group_processing_duration_seconds`;

// Contract Interaction Metrics
export const METRIC_CONTRACT_CALL_DURATION_SECONDS = `contract_call_duration_seconds`;
export const METRIC_CONTRACT_CALL_COUNT = `contract_call_count`;
export const METRIC_CONTRACT_VERIFICATION_COUNT = `contract_verification_count`;

// Block Processing Metrics
export const METRIC_BLOCK_RANGE_PROCESSING_DURATION_SECONDS = `block_range_processing_duration_seconds`;
export const METRIC_BLOCK_RANGE_SIZE = `block_range_size`;
export const METRIC_BATCH_PROCESSING_DURATION_SECONDS = `batch_processing_duration_seconds`;
export const METRIC_BATCH_SIZE = `batch_size`;
export const METRIC_EXIT_REQUESTS_FOUND_COUNT = `exit_requests_found_count`;
export const METRIC_EXIT_REQUESTS_PROCESSED_COUNT = `exit_requests_processed_count`;

// Storage and Cache Metrics
export const METRIC_VALIDATOR_STORAGE_SIZE = `validator_storage_size`;
export const METRIC_VALIDATOR_STORAGE_DEADLINE_SLOTS = `validator_storage_deadline_slots`;
export const METRIC_VALIDATOR_STORAGE_CLEANUP_COUNT = `validator_storage_cleanup_count`;
export const METRIC_MEMORY_USAGE_BYTES = `memory_usage_bytes`;

// Business Logic Metrics
export const METRIC_EXIT_ALREADY_PROCESSED_COUNT = `exit_already_processed_count`;
export const METRIC_EXIT_DEADLINE_MISSED_COUNT = `exit_deadline_missed_count`;
export const METRIC_EXIT_DEADLINE_FUTURE_COUNT = `exit_deadline_future_count`;
export const METRIC_BEACON_STATE_FETCH_DURATION_SECONDS = `beacon_state_fetch_duration_seconds`;
export const METRIC_BEACON_STATE_DESERIALIZATION_DURATION_SECONDS = `beacon_state_deserialization_duration_seconds`;

// Staking Module Metrics
export const METRIC_STAKING_MODULE_OPERATIONS_COUNT = `staking_module_operations_count`;
export const METRIC_NODE_OPERATOR_OPERATIONS_COUNT = `node_operator_operations_count`;

// Daemon Metrics
export const METRIC_DAEMON_CYCLE_DURATION_SECONDS = `daemon_cycle_duration_seconds`;
export const METRIC_DAEMON_SLEEP_COUNT = `daemon_sleep_count`;
export const METRIC_ROOTS_PROCESSING_DURATION_SECONDS = `roots_processing_duration_seconds`;
export const METRIC_ROOTS_SAME_COUNT = `roots_same_count`;

// Error and Warning Metrics
export const METRIC_SLOT_AGE_WARNINGS_COUNT = `slot_age_warnings_count`;
export const METRIC_STATE_DESERIALIZATION_ERRORS_COUNT = `state_deserialization_errors_count`;
export const METRIC_BEACON_HEADER_FETCH_ERRORS_COUNT = `beacon_header_fetch_errors_count`;
export const METRIC_CONTRACT_CALL_ERRORS_COUNT = `contract_call_errors_count`;
