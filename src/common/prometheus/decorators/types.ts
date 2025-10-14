export interface MetricLabels {
  [key: string]: string | number;
}

export interface RequestMetrics {
  durationMetric: {
    startTimer: (labels: MetricLabels) => () => number;
  };
  countMetric: {
    inc: (labels: MetricLabels) => void;
  };
}

export interface TaskMetrics {
  durationMetric: {
    startTimer: (labels: MetricLabels) => () => number;
  };
  countMetric: {
    inc: (labels: MetricLabels) => void;
  };
}

export interface PrometheusInstance {
  outgoingCLRequestsDuration: RequestMetrics['durationMetric'];
  outgoingCLRequestsCount: RequestMetrics['countMetric'];
  outgoingKeysAPIRequestsDuration: RequestMetrics['durationMetric'];
  outgoingKeysAPIRequestsCount: RequestMetrics['countMetric'];
  taskDuration: TaskMetrics['durationMetric'];
  taskCount: TaskMetrics['countMetric'];
  [key: string]: any; // Allow dynamic property access for custom metrics
}

export interface LoggerInstance {
  debug?: (message: string) => void;
  error: (message: string, stack?: string) => void;
}

export interface ConfigInstance {
  get: (key: string) => any;
}

export interface TrackableClass {
  prometheus: PrometheusInstance;
  logger?: LoggerInstance;
  config?: ConfigInstance;
}

export enum RequestStatus {
  COMPLETE = 'complete',
  ERROR = 'error',
}

export enum TaskStatus {
  COMPLETE = 'complete',
  ERROR = 'error',
}

export type RequestTrackingOptions = {
  skipInCliMode?: boolean;
  successCode?: number;
  extractLabels?: (apiUrl: string, subUrl: string) => MetricLabels;
};

export type TaskTrackingOptions = {
  logProgress?: boolean;
  logMemoryUsage?: boolean;
  customLabels?: MetricLabels;
};
