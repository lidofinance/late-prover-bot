import { Global, Module } from '@nestjs/common';
import { ConfigModule as ConfigModuleSource } from '@nestjs/config';

import { ConfigService } from './config.service';
import { FILE_BACKED_ENV_KEYS } from './env.files';
import { validate } from './env.validation';

@Global()
@Module({
  imports: [
    ConfigModuleSource.forRoot({
      validate: validate,
      isGlobal: true,
      cache: true,
    }),
  ],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {
  constructor() {
    // @nestjs/config copies the validated values into process.env after validate(). A secret that came from a file
    // should not stay in the process env (child processes inherit it): ConfigService reads the validated config, so
    // the copy is not needed. A value the operator set in the env stays as it is.
    for (const key of FILE_BACKED_ENV_KEYS) {
      if (process.env[`${key}_FILE`]) {
        delete process.env[key];
      }
    }
  }
}
