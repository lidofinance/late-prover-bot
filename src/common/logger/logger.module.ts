import { LoggerModule as Logger } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import * as winston from 'winston';

import { sanitizerFormat } from './sanitizer.format';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';
import { LogFormat } from '../config/interfaces';

@Module({
  imports: [
    Logger.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const { secrets } = configService;
        const level = configService.get('LOG_LEVEL');
        const format = configService.get('LOG_FORMAT');
        const isJSON = format === LogFormat.JSON;

        // Create custom transport with our advanced sanitization
        const transport = new winston.transports.Console({
          format: isJSON
            ? winston.format.combine(
                sanitizerFormat(secrets), // Our advanced sanitizer
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.json(),
              )
            : winston.format.combine(
                winston.format.colorize({ all: true }),
                sanitizerFormat(secrets), // Our advanced sanitizer
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, context, stack, ...meta }) => {
                  const contextStr = context ? ` [${context}]` : '';
                  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
                  const stackStr = stack ? `\n${stack}` : '';
                  return `${timestamp} ${level}${contextStr}: ${message}${metaStr}${stackStr}`;
                }),
              ),
        });

        return { level, transports: [transport] };
      },
    }),
  ],
})
export class LoggerModule {}
