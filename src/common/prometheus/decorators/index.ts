import { RequestTrackingOptions, TaskTrackingOptions, TrackableClass } from './types';
import { requestLabels, shouldSkipInCliMode, trackRequest, trackTask, validatePrometheusInstance } from './utils';

/**
 * Generic request tracking decorator
 */
function createRequestTracker(
  durationMetricName: keyof TrackableClass['prometheus'],
  countMetricName: keyof TrackableClass['prometheus'],
  options: RequestTrackingOptions = {},
) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
      const instance = this as TrackableClass;
      validatePrometheusInstance(instance, this.constructor.name);

      if (options.skipInCliMode && shouldSkipInCliMode(instance)) {
        return originalMethod.apply(this, args);
      }

      const [apiUrl, subUrl] = args;
      const labels = requestLabels(apiUrl, subUrl);
      const labelObj = options.extractLabels
        ? options.extractLabels(apiUrl, subUrl)
        : { name: labels[1], target: labels[0] };

      const durationMetric = instance.prometheus[durationMetricName] as any;
      const countMetric = instance.prometheus[countMetricName] as any;

      return trackRequest(
        instance,
        () => originalMethod.apply(this, args),
        durationMetric,
        countMetric,
        labelObj,
        options,
      );
    };

    return descriptor;
  };
}

/**
 * Tracks Consensus Layer requests
 */
export function TrackCLRequest(options: RequestTrackingOptions = {}) {
  return createRequestTracker('outgoingCLRequestsDuration', 'outgoingCLRequestsCount', {
    skipInCliMode: true,
    ...options,
  });
}

/**
 * Tracks task execution with timing and status
 */
export function TrackTask(taskName: string, options: TaskTrackingOptions = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
      const instance = this as TrackableClass;
      validatePrometheusInstance(instance, this.constructor.name);

      return trackTask(instance, taskName, () => originalMethod.apply(this, args), options);
    };

    return descriptor;
  };
}

/**
 * Tracks worker execution (specialized task tracker)
 */
export function TrackWorker(options: TaskTrackingOptions = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
      const instance = this as TrackableClass;
      validatePrometheusInstance(instance, this.constructor.name);

      const workerName = `run-worker-${args[0]}`;

      return trackTask(instance, workerName, () => originalMethod.apply(this, args), {
        logMemoryUsage: false,
        ...options,
      });
    };

    return descriptor;
  };
}

/**
 * Generic metric tracking decorator for custom metrics
 */
export function TrackMetric(
  durationMetricName: string,
  countMetricName: string,
  labelExtractor: (...args: any[]) => Record<string, string | number> = () => ({}),
  options: { logProgress?: boolean; successStatus?: string; errorStatus?: string } = {},
) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const instance = this as any;
      validatePrometheusInstance(instance, this.constructor.name);

      const labels = labelExtractor(...args);
      const durationMetric = instance.prometheus[durationMetricName];
      const countMetric = instance.prometheus[countMetricName];

      if (!durationMetric || !countMetric) {
        throw new Error(`Metrics '${durationMetricName}' or '${countMetricName}' not found`);
      }

      const stopTimer = durationMetric.startTimer(labels);

      if (options.logProgress && instance.logger?.debug) {
        instance.logger.debug(`${propertyKey} operation in progress`);
      }

      try {
        const result = await originalMethod.apply(this, args);

        countMetric.inc({
          ...labels,
          status: options.successStatus || 'success',
        });

        return result;
      } catch (error: any) {
        countMetric.inc({
          ...labels,
          status: options.errorStatus || 'error',
        });

        throw error;
      } finally {
        stopTimer();
      }
    };

    return descriptor;
  };
}

// Re-export types for convenience
export * from './types';
export * from './utils';
