import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { NestFactory } from '@nestjs/core';

import { ConfigService } from './common/config/config.service';
import { WorkingMode } from './common/config/env.validation';
import { DaemonModule } from './daemon/daemon.module';
import { DaemonService } from './daemon/daemon.service';

async function bootstrapDaemon() {
  const daemonApp = await NestFactory.create(DaemonModule, {
    bufferLogs: true,
  });
  daemonApp.useLogger(daemonApp.get(LOGGER_PROVIDER));
  const configService: ConfigService = daemonApp.get(ConfigService);
  await daemonApp.listen(configService.get('HTTP_PORT'), '0.0.0.0');
  daemonApp.get(DaemonService).run().then();
}

async function bootstrap() {
  switch (process.env.WORKING_MODE) {
    case WorkingMode.Daemon:
      await bootstrapDaemon();
      break;
    default:
      throw new Error('Unknown working mode');
  }
}
bootstrap();
