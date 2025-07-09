# New Prometheus Metrics for Late Proof Verifier

This document outlines the new metrics that have been added to the late proof verifier system. These metrics provide comprehensive monitoring of the proof generation, validator processing, and contract interaction workflows.

## Metrics Overview

### 1. Proof Generation Metrics

#### `proof_generation_duration_seconds` (Histogram)
- **Purpose**: Measures the time taken to generate proofs
- **Labels**: `proof_type`, `slot_type`
- **Buckets**: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120]
- **Usage**: Track performance of proof generation operations

#### `proof_generation_count` (Counter)
- **Purpose**: Counts total proof generation operations
- **Labels**: `proof_type`, `slot_type`, `status`
- **Usage**: Monitor proof generation success/failure rates

#### `historical_proof_generation_count` (Counter)
- **Purpose**: Counts historical proof generations
- **Labels**: `status`
- **Usage**: Track historical vs current proof processing

#### `current_proof_generation_count` (Counter)
- **Purpose**: Counts current proof generations
- **Labels**: `status`
- **Usage**: Track current slot proof processing

### 2. Validator Processing Metrics

#### `validators_processed_count` (Counter)
- **Purpose**: Counts validators successfully processed
- **Labels**: `module_id`, `processing_type`
- **Usage**: Monitor validator processing throughput per staking module

#### `validators_skipped_count` (Counter)
- **Purpose**: Counts validators skipped during processing
- **Labels**: `module_id`, `reason`
- **Usage**: Track why validators are being skipped (already exited, penalty not applicable, etc.)

#### `validators_eligible_count` (Gauge)
- **Purpose**: Current count of eligible validators
- **Labels**: `module_id`
- **Usage**: Monitor validator eligibility across staking modules

#### `validators_penalty_applicable_count` (Counter)
- **Purpose**: Counts validators with penalty applicable
- **Labels**: `module_id`, `applicable`
- **Usage**: Track penalty application decisions

#### `validator_processing_duration_seconds` (Histogram)
- **Purpose**: Duration of individual validator processing
- **Labels**: `module_id`, `processing_type`
- **Buckets**: [0.01, 0.1, 0.5, 1, 2, 5, 10, 20]
- **Usage**: Monitor performance of validator processing

#### `validator_group_processing_duration_seconds` (Histogram)
- **Purpose**: Duration of validator group processing
- **Labels**: `deadline_slot`, `group_size_range`
- **Buckets**: [1, 5, 10, 30, 60, 120, 300, 600, 1200]
- **Usage**: Track performance of batch validator processing

### 3. Contract Interaction Metrics

#### `contract_call_duration_seconds` (Histogram)
- **Purpose**: Duration of contract calls
- **Labels**: `contract_type`, `method`
- **Buckets**: [0.1, 0.5, 1, 2, 5, 10, 20, 30]
- **Usage**: Monitor contract call performance

#### `contract_call_count` (Counter)
- **Purpose**: Count of contract calls
- **Labels**: `contract_type`, `method`, `status`
- **Usage**: Track contract interaction success/failure rates

#### `contract_penalty_check_duration_seconds` (Histogram)
- **Purpose**: Duration of contract penalty checks
- **Labels**: `module_id`
- **Buckets**: [0.1, 0.5, 1, 2, 5, 10, 20]
- **Usage**: Monitor penalty check performance

#### `contract_verification_duration_seconds` (Histogram)
- **Purpose**: Duration of contract verification operations
- **Labels**: `verification_type`, `validator_count_range`
- **Buckets**: [1, 5, 10, 30, 60, 120, 300, 600]
- **Usage**: Track verification performance by validator batch size

#### `contract_verification_count` (Counter)
- **Purpose**: Count of contract verifications
- **Labels**: `verification_type`, `status`
- **Usage**: Monitor verification success rates

### 4. Block Processing Metrics

#### `block_range_processing_duration_seconds` (Histogram)
- **Purpose**: Duration of block range processing
- **Labels**: `range_size_category`
- **Buckets**: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600]
- **Usage**: Monitor block processing performance by range size

#### `block_range_size` (Histogram)
- **Purpose**: Size of block ranges being processed
- **Labels**: `processing_type`
- **Buckets**: [1, 10, 100, 1000, 10000, 50000, 100000, 500000]
- **Usage**: Track block range sizes

#### `batch_processing_duration_seconds` (Histogram)
- **Purpose**: Duration of batch processing operations
- **Labels**: `batch_size_range`
- **Buckets**: [1, 5, 10, 30, 60, 120, 300, 600]
- **Usage**: Monitor batch processing performance

#### `batch_size` (Histogram)
- **Purpose**: Size of batches being processed
- **Labels**: `processing_type`
- **Buckets**: [1, 10, 100, 1000, 10000, 50000, 100000]
- **Usage**: Track batch sizes

#### `exit_requests_found_count` (Counter)
- **Purpose**: Count of exit requests found
- **Labels**: `block_range_type`
- **Usage**: Monitor exit request discovery

#### `exit_requests_processed_count` (Counter)
- **Purpose**: Count of exit requests processed
- **Labels**: `status`
- **Usage**: Track exit request processing success

### 5. Storage and Cache Metrics

#### `validator_storage_size` (Gauge)
- **Purpose**: Current size of validator storage
- **Labels**: `storage_type`
- **Usage**: Monitor validator storage usage

#### `validator_storage_deadline_slots` (Gauge)
- **Purpose**: Number of deadline slots in validator storage
- **Labels**: []
- **Usage**: Track deadline slot accumulation

#### `validator_storage_cleanup_count` (Counter)
- **Purpose**: Count of validator storage cleanup operations
- **Labels**: `cleanup_type`
- **Usage**: Monitor storage cleanup efficiency

#### `memory_usage_bytes` (Gauge)
- **Purpose**: Current memory usage in bytes
- **Labels**: `memory_type`
- **Usage**: Monitor memory consumption

### 6. Business Logic Metrics

#### `exit_eligibility_check_duration_seconds` (Histogram)
- **Purpose**: Duration of exit eligibility checks
- **Labels**: `check_type`
- **Buckets**: [0.001, 0.01, 0.1, 0.5, 1, 2, 5]
- **Usage**: Monitor eligibility check performance

#### `exit_already_processed_count` (Counter)
- **Purpose**: Count of validators already processed for exit
- **Labels**: `module_id`
- **Usage**: Track already processed validators

#### `exit_deadline_missed_count` (Counter)
- **Purpose**: Count of missed exit deadlines
- **Labels**: `module_id`
- **Usage**: Monitor deadline adherence

#### `exit_deadline_future_count` (Counter)
- **Purpose**: Count of future exit deadlines
- **Labels**: `module_id`
- **Usage**: Track future deadline planning

#### `beacon_state_fetch_duration_seconds` (Histogram)
- **Purpose**: Duration of beacon state fetch operations
- **Labels**: `state_type`
- **Buckets**: [0.5, 1, 2, 5, 10, 20, 30, 60, 120]
- **Usage**: Monitor beacon state fetching performance

#### `beacon_state_deserialization_duration_seconds` (Histogram)
- **Purpose**: Duration of beacon state deserialization
- **Labels**: `fork_name`
- **Buckets**: [0.1, 0.5, 1, 2, 5, 10, 20, 30]
- **Usage**: Monitor deserialization performance by fork

### 7. Staking Module Metrics

#### `staking_module_operations_count` (Counter)
- **Purpose**: Count of staking module operations
- **Labels**: `module_id`, `operation_type`, `status`
- **Usage**: Monitor staking module health

#### `staking_module_load_duration_seconds` (Histogram)
- **Purpose**: Duration of staking module loading
- **Labels**: `module_count_range`
- **Buckets**: [0.1, 0.5, 1, 2, 5, 10, 20]
- **Usage**: Monitor module loading performance

#### `node_operator_operations_count` (Counter)
- **Purpose**: Count of node operator operations
- **Labels**: `module_id`, `operation_type`, `status`
- **Usage**: Monitor node operator interactions

### 8. Daemon Metrics

#### `daemon_cycle_duration_seconds` (Histogram)
- **Purpose**: Duration of daemon processing cycles
- **Labels**: `cycle_type`
- **Buckets**: [1, 5, 10, 30, 60, 120, 300, 600, 1200]
- **Usage**: Monitor daemon processing performance

#### `daemon_sleep_count` (Counter)
- **Purpose**: Count of daemon sleep cycles
- **Labels**: `reason`
- **Usage**: Track daemon idle periods

#### `roots_processing_duration_seconds` (Histogram)
- **Purpose**: Duration of roots processing operations
- **Labels**: `processing_type`
- **Buckets**: [5, 15, 30, 60, 120, 300, 600, 1200, 1800]
- **Usage**: Monitor roots processing performance

#### `roots_same_count` (Counter)
- **Purpose**: Count of times prev and latest roots are the same
- **Labels**: []
- **Usage**: Track daemon catch-up status

### 9. Error and Warning Metrics

#### `slot_age_warnings_count` (Counter)
- **Purpose**: Count of slot age warnings
- **Labels**: `warning_type`
- **Usage**: Monitor slot age issues

#### `state_deserialization_errors_count` (Counter)
- **Purpose**: Count of state deserialization errors
- **Labels**: `fork_name`
- **Usage**: Track deserialization issues

#### `beacon_header_fetch_errors_count` (Counter)
- **Purpose**: Count of beacon header fetch errors
- **Labels**: `error_type`
- **Usage**: Monitor beacon header fetching issues

#### `contract_call_errors_count` (Counter)
- **Purpose**: Count of contract call errors
- **Labels**: `contract_type`, `method`, `error_type`
- **Usage**: Track contract interaction errors

## Implementation Guidelines

### 1. Adding Metrics to Your Code

To use these metrics in your services, inject the `PrometheusService` and use the metric instances:

```typescript
import { PrometheusService } from '../prometheus/prometheus.service';

@Injectable()
export class YourService {
  constructor(private prometheus: PrometheusService) {}

  async someMethod() {
    // Start timer for duration metric
    const stopTimer = this.prometheus.validatorProcessingDuration.startTimer({
      module_id: '1',
      processing_type: 'eligibility_check'
    });

    try {
      // Your business logic here
      
      // Increment success counter
      this.prometheus.validatorsProcessedCount.inc({
        module_id: '1',
        processing_type: 'eligibility_check'
      });
    } catch (error) {
      // Increment error counter
      this.prometheus.validatorsSkippedCount.inc({
        module_id: '1',
        reason: 'processing_error'
      });
    } finally {
      // Stop timer
      stopTimer();
    }
  }
}
```

### 2. Metric Naming Conventions

- Use descriptive metric names that clearly indicate what is being measured
- Include units in the metric name (e.g., `_seconds`, `_bytes`, `_count`)
- Use consistent label names across related metrics
- Group related metrics with common prefixes

### 3. Label Usage Best Practices

- Use labels to add dimensions to your metrics
- Keep label cardinality reasonable (avoid high-cardinality labels)
- Use consistent label values across metrics
- Consider using enums for label values to avoid typos

### 4. Grafana Dashboard Integration

These metrics are designed to work well with Grafana dashboards. Consider creating dashboards for:

- **Validator Processing Overview**: Track validator throughput and performance
- **Contract Interaction Health**: Monitor contract call success rates and performance
- **Block Processing Performance**: Track block range processing efficiency
- **System Resource Usage**: Monitor memory and storage usage
- **Error Monitoring**: Track various error types and their frequency

### 5. Alerting Recommendations

Set up alerts for:
- High error rates in contract calls
- Long processing times for critical operations
- Memory usage approaching limits
- High validator skip rates
- Missed exit deadlines

## Benefits of These Metrics

1. **Performance Monitoring**: Track the performance of key operations
2. **Error Detection**: Quickly identify and diagnose issues
3. **Resource Optimization**: Monitor resource usage and optimize accordingly
4. **Business Intelligence**: Understand validator processing patterns
5. **Operational Visibility**: Gain insights into daemon and batch processing
6. **Troubleshooting**: Detailed metrics help with debugging complex issues

## Next Steps

1. **Implement Metrics**: Add metric calls to your service methods
2. **Create Dashboards**: Build Grafana dashboards for visualization
3. **Set Up Alerts**: Configure alerts for critical metrics
4. **Monitor and Iterate**: Use metrics to improve system performance
5. **Documentation**: Keep this documentation updated as metrics evolve 