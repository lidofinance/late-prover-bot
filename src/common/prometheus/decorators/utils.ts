import { join } from 'lodash';

import {
  MetricLabels,
  RequestStatus,
  RequestTrackingOptions,
  TaskStatus,
  TaskTrackingOptions,
  TrackableClass,
} from './types';
import { WorkingMode } from '../../config/env.validation';

/**
 * Extracts request labels from API URL and sub URL
 */
export function requestLabels(apiUrl: string, subUrl: string): [string, string] {
  const targetName = new URL(apiUrl).hostname;
  const reqName = join(
    subUrl
      .split('?')[0]
      .split('/')
      .map((p) => {
        if (p.includes('0x') || +p) return '{param}';
        return p;
      }),
    '/',
  );
  return [targetName, reqName];
}

/**
 * Validates that the class instance has the required prometheus property
 */
export function validatePrometheusInstance(instance: any, className: string): asserts instance is TrackableClass {
  if (!instance.prometheus) {
    throw new Error(`'${className}' class object must contain 'prometheus' property`);
  }
}

/**
 * Checks if the operation should be skipped in CLI mode
 */
export function shouldSkipInCliMode(instance: TrackableClass): boolean {
  return instance.config?.get('WORKING_MODE') === WorkingMode.CLI;
}

/**
 * Generic request tracking logic
 */
export async function trackRequest<T>(
  instance: TrackableClass,
  operation: () => Promise<T>,
  durationMetric: { startTimer: (labels: MetricLabels) => () => number },
  countMetric: { inc: (labels: MetricLabels) => void },
  labels: MetricLabels,
  options: RequestTrackingOptions = {},
): Promise<T> {
  const { successCode = 200 } = options;

  const stopTimer = durationMetric.startTimer(labels);

  try {
    const result = await operation();

    countMetric.inc({
      ...labels,
      status: RequestStatus.COMPLETE,
      code: successCode,
    });

    return result;
  } catch (error: any) {
    countMetric.inc({
      ...labels,
      status: RequestStatus.ERROR,
      code: error.statusCode || 500,
    });

    throw error;
  } finally {
    stopTimer();
  }
}

/**
 * Generic task tracking logic
 */
export async function trackTask<T>(
  instance: TrackableClass,
  taskName: string,
  operation: () => Promise<T>,
  options: TaskTrackingOptions = {},
): Promise<T> {
  const { logProgress = true, logMemoryUsage = true, customLabels = {} } = options;

  const labels = {
    name: taskName,
    ...customLabels,
  };

  const stopTimer = instance.prometheus.taskDuration.startTimer(labels);

  if (logProgress && instance.logger?.debug) {
    instance.logger.debug(`Task '${taskName}' in progress`);
  }

  try {
    const result = await operation();

    instance.prometheus.taskCount.inc({
      ...labels,
      status: TaskStatus.COMPLETE,
    });

    return result;
  } catch (error: any) {
    if (instance.logger?.error) {
      instance.logger.error(`Task '${taskName}' ended with an error`, error.stack);
    }

    instance.prometheus.taskCount.inc({
      ...labels,
      status: TaskStatus.ERROR,
    });

    throw error;
  } finally {
    const duration = stopTimer();

    if (logProgress && instance.logger?.debug) {
      let message = `Task '${taskName}' is complete. Duration: ${duration}`;

      if (logMemoryUsage) {
        const used = process.memoryUsage().heapUsed / 1024 / 1024;
        message += `. Used MB: ${used}`;
      }

      instance.logger.debug(message);
    }
  }
}

/**
 * Gets the size range category for grouping metrics
 */
export function getSizeRangeCategory(size: number): string {
  if (size <= 10) return 'small';
  if (size <= 100) return 'medium';
  if (size <= 1000) return 'large';
  return 'xlarge';
}

/**
 * Gets the duration range category for grouping metrics
 */
export function getDurationRangeCategory(durationMs: number): string {
  if (durationMs <= 1000) return 'fast';
  if (durationMs <= 10000) return 'medium';
  if (durationMs <= 60000) return 'slow';
  return 'very_slow';
}
