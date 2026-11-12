import { Writable } from 'stream';

import { WinstonLogger } from 'nest-winston';
import * as winston from 'winston';

import { toWinstonLevel } from './winston-level';
import { LogLevel } from '../config/interfaces';

const visibleMessages = (level: LogLevel): string[] => {
  const messages: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      messages.push(JSON.parse(String(chunk)).message);
      done();
    },
  });
  const logger = new WinstonLogger(
    winston.createLogger({ level: toWinstonLevel(level), transports: [new winston.transports.Stream({ stream })] }),
  );

  logger.error('error');
  logger.warn('warn');
  logger.log('log');
  logger.debug?.('debug');

  return messages;
};

describe('toWinstonLevel', () => {
  it.each([
    [LogLevel.Error, ['error']],
    [LogLevel.Warning, ['error', 'warn']],
    [LogLevel.Notice, ['error', 'warn', 'log']],
    [LogLevel.Info, ['error', 'warn', 'log']],
    [LogLevel.Debug, ['error', 'warn', 'log', 'debug']],
  ])('LOG_LEVEL=%s shows %j', (level, expected) => {
    expect(visibleMessages(level)).toEqual(expected);
  });
});
