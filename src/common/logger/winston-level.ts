import { LogLevel } from '../config/interfaces';

/** `warning` and `notice` are syslog names that match no winston level: passed through unmapped,
 * the logger drops every line. */
const WINSTON_LEVELS: Record<LogLevel, string> = {
  [LogLevel.Error]: 'error',
  [LogLevel.Warning]: 'warn',
  [LogLevel.Notice]: 'info',
  [LogLevel.Info]: 'info',
  [LogLevel.Debug]: 'debug',
};

export function toWinstonLevel(level: LogLevel): string {
  return WINSTON_LEVELS[level] ?? 'info';
}
