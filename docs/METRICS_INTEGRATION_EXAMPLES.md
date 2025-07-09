# Metrics Integration Examples

This document provides practical examples of how to integrate the new metrics into your existing services.

## Overview

The new metrics cover 9 key areas:
1. **Proof Generation** - Track proof creation performance
2. **Validator Processing** - Monitor validator lifecycle operations
3. **Contract Interaction** - Track blockchain contract calls
4. **Block Processing** - Monitor block range processing
5. **Storage and Cache** - Track memory and storage usage
6. **Business Logic** - Monitor application-specific operations
7. **Staking Module** - Track staking module operations
8. **Daemon** - Monitor daemon cycle performance
9. **Error and Warning** - Track various error conditions

## Example Integrations

### 1. ProverService Integration

```typescript
// Import the required utilities
import { PrometheusService } from '../prometheus/prometheus.service';
import { getSizeRangeCategory, getDurationRangeCategory } from '../prometheus/decorators';

// In your constructor
constructor(
  // ... existing dependencies
  protected readonly prometheus: PrometheusService,
) {}

// Example: Track proof generation
private async generateProof(validatorIndex: number, stateView: any): Promise<any> {
  const startTime = Date.now();
  
  // Start timing the proof generation
  const stopTimer = this.prometheus.proofGenerationDuration.startTimer({
    proof_type: 'validator',
    slot_type: 'current'
  });
  
  try {
    const proof = generateValidatorProof(stateView, validatorIndex);
    
    // Track successful proof generation
    this.prometheus.proofGenerationCount.inc({
      proof_type: 'validator',
      slot_type: 'current',
      status: 'success'
    });
    
    return proof;
  } catch (error) {
    // Track failed proof generation
    this.prometheus.proofGenerationCount.inc({
      proof_type: 'validator',
      slot_type: 'current',
      status: 'error'
    });
    throw error;
  } finally {
    stopTimer();
  }
}

// Example: Track validator processing
private async processValidatorGroup(validators: any[]): Promise<void> {
  const groupSize = validators.length;
  const groupSizeRange = getSizeRangeCategory(groupSize);
  
  // Track validator group processing
  const stopTimer = this.prometheus.validatorGroupProcessingDuration.startTimer({
    deadline_slot: '12345',
    group_size_range: groupSizeRange
  });
  
  try {
    for (const validator of validators) {
      // Track individual validator processing
      this.prometheus.validatorsProcessedCount.inc({
        module_id: validator.moduleId.toString(),
        processing_type: 'proof_generation'
      });
    }
  } finally {
    stopTimer();
  }
}
```

### 2. DaemonService Integration

```typescript
// Track daemon cycles
public async run() {
  while (true) {
    const stopTimer = this.prometheus.daemonCycleDuration.startTimer({
      cycle_type: 'main_loop'
    });
    
    try {
      await this.baseRun();
    } catch (error) {
      this.prometheus.daemonSleepCount.inc({
        reason: 'error_recovery'
      });
      await sleep(SLEEP_TIME);
    } finally {
      stopTimer();
      
      // Track memory usage
      const memoryUsage = process.memoryUsage();
      this.prometheus.memoryUsage.set(
        { memory_type: 'heap_used' },
        memoryUsage.heapUsed
      );
    }
  }
}
```

### 3. Contract Service Integration

```typescript
// Track contract calls
public async callContract(method: string, params: any[]): Promise<any> {
  const stopTimer = this.prometheus.contractCallDuration.startTimer({
    contract_type: 'staking_router',
    method: method
  });
  
  try {
    const result = await this.contract[method](...params);
    
    this.prometheus.contractCallCount.inc({
      contract_type: 'staking_router',
      method: method,
      status: 'success'
    });
    
    return result;
  } catch (error) {
    this.prometheus.contractCallCount.inc({
      contract_type: 'staking_router',
      method: method,
      status: 'error'
    });
    throw error;
  } finally {
    stopTimer();
  }
}
```

### 4. Block Processing Integration

```typescript
// Track block range processing
public async processBlocks(fromBlock: number, toBlock: number): Promise<void> {
  const blockRange = toBlock - fromBlock;
  const rangeSizeCategory = getSizeRangeCategory(blockRange);
  
  const stopTimer = this.prometheus.blockRangeProcessingDuration.startTimer({
    range_size_category: rangeSizeCategory
  });
  
  try {
    // Track block range size
    this.prometheus.blockRangeSize.observe(
      { processing_type: 'daemon_processing' },
      blockRange
    );
    
    // Process blocks...
    
  } finally {
    stopTimer();
  }
}
```

### 5. Exit Request Processing

```typescript
// Track exit request discovery
public async getExitRequests(fromBlock: number, toBlock: number): Promise<any[]> {
  const blockRange = toBlock - fromBlock;
  const rangeSizeCategory = getSizeRangeCategory(blockRange);
  
  const stopTimer = this.prometheus.batchProcessingDuration.startTimer({
    batch_size_range: rangeSizeCategory
  });
  
  try {
    const events = await this.contract.queryFilter(
      this.contract.filters.ExitDataProcessing(),
      fromBlock,
      toBlock
    );
    
    // Track exit requests found
    this.prometheus.exitRequestsFoundCount.inc({
      block_range_type: rangeSizeCategory
    }, events.length);
    
    return events;
  } finally {
    stopTimer();
  }
}
```

### 6. Beacon State Operations

```typescript
// Track beacon state operations
public async getBeaconState(slot: number): Promise<any> {
  const stopTimer = this.prometheus.beaconStateFetchDuration.startTimer({
    state_type: 'deadline'
  });
  
  try {
    const state = await this.consensus.getState(slot);
    
    // Track deserialization
    const stopDeserializationTimer = this.prometheus.beaconStateDeserializationDuration.startTimer({
      fork_name: state.forkName
    });
    
    try {
      const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
      return stateView;
    } catch (error) {
      this.prometheus.stateDeserializationErrorsCount.inc({
        fork_name: state.forkName
      });
      throw error;
    } finally {
      stopDeserializationTimer();
    }
  } finally {
    stopTimer();
  }
}
```

### 7. Staking Module Operations

```typescript
// Track staking module operations
public async getStakingModules(): Promise<any[]> {
  try {
    const modules = await this.contract.getStakingModules();
    
    this.prometheus.stakingModuleOperationsCount.inc({
      module_id: 'all',
      operation_type: 'get_all_modules',
      status: 'success'
    });
    
    return modules;
  } catch (error) {
    this.prometheus.stakingModuleOperationsCount.inc({
      module_id: 'all',
      operation_type: 'get_all_modules',
      status: 'error'
    });
    throw error;
  }
}
```

### 8. Error Tracking

```typescript
// Track various error conditions
public async handleError(error: Error, context: string): Promise<void> {
  switch (context) {
    case 'contract_call':
      this.prometheus.contractCallErrorsCount.inc({
        contract_type: 'staking_router',
        method: 'getStakingModules',
        error_type: 'network_error'
      });
      break;
      
    case 'beacon_header':
      this.prometheus.beaconHeaderFetchErrorsCount.inc({
        error_type: 'timeout'
      });
      break;
      
    case 'slot_age':
      this.prometheus.slotAgeWarningsCount.inc({
        warning_type: 'stale_slot'
      });
      break;
  }
}
```

## Utility Functions

The metrics system includes several utility functions to help categorize values:

```typescript
import { getSizeRangeCategory, getDurationRangeCategory } from '../prometheus/decorators';

// Categorize sizes for consistent labeling
const size = 150;
const sizeCategory = getSizeRangeCategory(size); // Returns: "100-499"

// Categorize durations
const duration = 2500; // ms
const durationCategory = getDurationRangeCategory(duration); // Returns: "1000-4999"
```

## Best Practices

1. **Always use try/catch/finally** - Ensure timers are stopped even if errors occur
2. **Track both success and error cases** - Use consistent status labels
3. **Use appropriate metric types**:
   - **Counter** for cumulative values (requests, errors)
   - **Histogram** for distributions (durations, sizes)
   - **Gauge** for current values (memory usage, queue size)
4. **Categorize large ranges** - Use utility functions for consistent labeling
5. **Include relevant context** - Add module IDs, operation types, etc.
6. **Monitor performance impact** - Metrics collection should be lightweight

## Metric Label Reference

Common label patterns across metrics:

- **module_id**: Staking module identifier
- **operation_type**: Type of operation (get_all_modules, get_single_module, etc.)
- **status**: Operation result (success, error, timeout, etc.)
- **contract_type**: Contract identifier (staking_router, exit_bus, etc.)
- **method**: Contract method name
- **processing_type**: Processing context (daemon_processing, manual_processing, etc.)
- **proof_type**: Type of proof (validator, historical, etc.)
- **slot_type**: Slot context (current, historical, etc.)

This structured approach ensures consistent metrics collection across your application while providing detailed insights into performance and operational health. 