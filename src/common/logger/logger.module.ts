import { LoggerModule as Logger, simpleTransport, jsonTransport } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import * as winston from 'winston';

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

        const transports = isJSON ? jsonTransport({ secrets }) : simpleTransport({ secrets });
        return { level, transports: [transports] };
      },
    }),
  ],
})
export class LoggerModule {}
