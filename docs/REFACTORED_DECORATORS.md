# Refactored Prometheus Decorators

This document explains the refactored decorator system for Prometheus metrics tracking.

## 🔄 **What Changed**

### **Before (Old Decorators)**
- Code duplication between similar decorators
- Mixed concerns in single file
- Limited type safety
- Hard-coded behavior

### **After (Refactored Decorators)**
- ✅ **Eliminated Code Duplication**: Generic request tracker handles all API types
- ✅ **Better Organization**: Separated into focused modules
- ✅ **Enhanced Type Safety**: Proper TypeScript interfaces and types
- ✅ **Configurable Options**: Flexible decorator options
- ✅ **Extensible**: Easy to add new tracking decorators

## 📁 **New File Structure**

```
src/common/prometheus/
├── decorators/
│   ├── types.ts      # TypeScript interfaces and types
│   ├── utils.ts      # Utility functions and common logic
│   └── index.ts      # Main decorator exports
├── prometheus.service.ts  # Main service (now cleaner)
└── prometheus.constants.ts
```

## 🎯 **Usage Examples**

### **Request Tracking Decorators**

#### **TrackCLRequest (Consensus Layer)**
```typescript
import { TrackCLRequest } from '../prometheus';

class ConsensusService {
  @TrackCLRequest() // Note: Now requires parentheses
  async getBeaconHeader(blockId: string) {
    // Your implementation
  }

  // With custom options
  @TrackCLRequest({ 
    skipInCliMode: true,
    successCode: 200,
    extractLabels: (url, path) => ({ custom: 'label' })
  })
  async getState(stateId: string) {
    // Your implementation
  }
}
```

#### **TrackKeysAPIRequest**
```typescript
class KeysService {
  @TrackKeysAPIRequest()
  async getValidators() {
    // Your implementation
  }

  @TrackKeysAPIRequest({ successCode: 201 })
  async createValidator() {
    // Your implementation
  }
}
```

### **Task Tracking Decorators**

#### **TrackTask**
```typescript
class ProverService {
  @TrackTask('proof-generation')
  async generateProof() {
    // Your implementation
  }

  @TrackTask('validator-processing', {
    logProgress: true,
    logMemoryUsage: true,
    customLabels: { module: 'prover' }
  })
  async processValidators() {
    // Your implementation
  }
}
```

#### **TrackWorker**
```typescript
class WorkerService {
  @TrackWorker()
  async runWorker(workerName: string) {
    // Worker name automatically extracted from first argument
    // Becomes: 'run-worker-{workerName}'
  }

  @TrackWorker({ logMemoryUsage: false })
  async runLightWorker(workerName: string) {
    // Custom options
  }
}
```

### **Generic Metric Tracking**

#### **TrackMetric (New!)**
```typescript
class CustomService {
  @TrackMetric(
    'contractCallDuration',           // Duration metric name
    'contractCallCount',              // Count metric name
    (contractAddr, method) => ({      // Label extractor function
      contract: contractAddr,
      method: method
    }),
    {                                 // Options
      logProgress: true,
      successStatus: 'completed',
      errorStatus: 'failed'
    }
  )
  async callContract(contractAddr: string, method: string) {
    // Your implementation
  }
}
```

## 🔧 **Migration Guide**

### **Step 1: Update Decorator Usage**

**Before:**
```typescript
@TrackCLRequest
protected baseGet() { ... }
```

**After:**
```typescript
@TrackCLRequest()  // Add parentheses
protected baseGet() { ... }
```

### **Step 2: Update Task Decorators**

**Before:**
```typescript
@TrackTask('task-name')  // Already correct
async myTask() { ... }
```

**After:**
```typescript
@TrackTask('task-name')  // No change needed
async myTask() { ... }
```

### **Step 3: Leverage New Options**

**Add custom options:**
```typescript
@TrackCLRequest({ 
  skipInCliMode: false,  // Override default
  extractLabels: (url, path) => ({ 
    service: 'beacon',
    endpoint: path.split('/')[1] 
  })
})
```

## 🆕 **New Features**

### **1. Configurable Request Tracking**
```typescript
interface RequestTrackingOptions {
  skipInCliMode?: boolean;           // Skip in CLI mode
  successCode?: number;              // Custom success code
  extractLabels?: (url, path) => {}; // Custom label extraction
}
```

### **2. Configurable Task Tracking**
```typescript
interface TaskTrackingOptions {
  logProgress?: boolean;      // Enable/disable progress logging
  logMemoryUsage?: boolean;   // Enable/disable memory logging
  customLabels?: {};          // Add custom labels
}
```

### **3. Utility Functions**
```typescript
import { 
  getSizeRangeCategory,     // Categorize by size
  getDurationRangeCategory, // Categorize by duration
  requestLabels            // Extract request labels
} from '../prometheus/decorators';
```

### **4. Type Safety**
```typescript
interface TrackableClass {
  prometheus: PrometheusInstance;
  logger?: LoggerInstance;
  config?: ConfigInstance;
}
```

## 📊 **Performance Benefits**

1. **Reduced Bundle Size**: Eliminated duplicate code
2. **Better Tree Shaking**: Modular structure
3. **Improved Type Checking**: Compile-time error detection
4. **Easier Testing**: Isolated utility functions

## 🧪 **Testing Your Decorators**

### **Unit Test Example**
```typescript
import { TrackTask } from '../prometheus/decorators';

describe('TrackTask Decorator', () => {
  it('should track task execution', async () => {
    class TestService {
      prometheus = mockPrometheusService;
      logger = mockLogger;

      @TrackTask('test-task')
      async testMethod() {
        return 'success';
      }
    }

    const service = new TestService();
    await service.testMethod();

    expect(mockPrometheusService.taskDuration.startTimer).toHaveBeenCalled();
    expect(mockPrometheusService.taskCount.inc).toHaveBeenCalledWith({
      name: 'test-task',
      status: 'complete'
    });
  });
});
```

## 🔍 **Troubleshooting**

### **Common Issues**

1. **"prometheus property not found"**
   - Ensure your class implements `TrackableClass` interface
   - Inject `PrometheusService` in constructor

2. **TypeScript errors with custom metrics**
   - Update `PrometheusInstance` interface to include your metrics
   - Use the `[key: string]: any` index signature for dynamic access

3. **Decorator not working**
   - Make sure to call decorator functions: `@TrackCLRequest()` not `@TrackCLRequest`
   - Check that class has required properties (`prometheus`, `logger`, `config`)

### **Best Practices**

1. **Use Specific Decorators**: Prefer `@TrackCLRequest()` over generic `@TrackMetric()`
2. **Consistent Labels**: Use consistent label names across related metrics
3. **Performance**: Avoid high-cardinality labels
4. **Testing**: Mock prometheus service in unit tests

## 🚀 **Next Steps**

1. **Update Existing Code**: Migrate old decorator usage
2. **Add New Metrics**: Use `@TrackMetric()` for custom tracking
3. **Create Dashboards**: Build Grafana dashboards with new label structure
4. **Monitor Performance**: Track decorator overhead in production 