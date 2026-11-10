import {
  FallbackProviderModule,
  NonEmptyArray,
  SimpleFallbackJsonRpcBatchProvider,
  SimpleFallbackProviderConfig,
} from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import type { ConnectionInfo } from 'ethers/lib/utils';

import { ConfigService } from '../config/config.service';
import { EL_RPC_MAX_BACKOFF_MS, WorkingMode } from '../config/env.validation';
import { PrometheusService, RequestStatus, USER_AGENT } from '../prometheus';
import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { PatchedFallbackProvider } from './execution/patched-fallback-provider';

export const buildProviderOptions = async (
  configService: ConfigService,
  prometheusService: PrometheusService,
): Promise<SimpleFallbackProviderConfig> => {
  const maxRetries = configService.get('EL_RPC_MAX_RETRIES');
  const retryDelayMs = configService.get('EL_RPC_RETRY_DELAY_MS');

  return {
    // ConnectionInfo instead of plain strings: the provider sees who sends the traffic, and every request has a timeout.
    // The tuple cast is safe: the validation requires at least one non-empty URL.
    urls: configService.get('EL_RPC_URLS').map(
      (url): ConnectionInfo => ({
        url,
        headers: { 'User-Agent': USER_AGENT },
        timeout: configService.get('EL_RPC_RESPONSE_TIMEOUT_MS'),
      }),
    ) as NonEmptyArray<ConnectionInfo>,
    network: configService.get('CHAIN_ID'),
    // Attempts per provider before the switch to the next one (the first try included). The backoff starts at the
    // delay and doubles on every retry; the library stops retrying as soon as the backoff reaches the cap, and the
    // env validation rejects a count the cap cannot reach (elRetryError).
    maxRetries,
    minBackoffMs: retryDelayMs,
    maxBackoffMs: EL_RPC_MAX_BACKOFF_MS,
    fetchMiddlewares: [
      async (next: any, ctx: any) => {
        const targetName = new URL(ctx.provider.connection.url).hostname;
        const reqName = 'batch';
        const stop = prometheusService.outgoingELRequestsDuration.startTimer({
          name: reqName,
          target: targetName,
        });
        return await next()
          .then((r: any) => {
            prometheusService.outgoingELRequestsCount.inc({
              name: reqName,
              target: targetName,
              status: RequestStatus.COMPLETE,
            });
            return r;
          })
          .catch((e: any) => {
            prometheusService.outgoingELRequestsCount.inc({
              name: reqName,
              target: targetName,
              status: RequestStatus.ERROR,
            });
            throw e;
          })
          .finally(() => stop());
      },
    ],
  };
};

const ExecutionDaemon = () =>
  FallbackProviderModule.forRootAsync({
    useFactory: buildProviderOptions,
    inject: [ConfigService, PrometheusService],
    providers: [
      {
        provide: SimpleFallbackJsonRpcBatchProvider,
        useFactory: async (logger: any, configService: ConfigService, prometheusService: PrometheusService) =>
          new PatchedFallbackProvider(await buildProviderOptions(configService, prometheusService), logger),
        inject: [LOGGER_PROVIDER, ConfigService, PrometheusService],
      },
    ],
  });

@Module({
  imports: [
    ConditionalModule.registerWhen(ExecutionDaemon(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
  ],
  providers: [Execution, Consensus],
  exports: [Execution, Consensus],
})
export class ProvidersModule {}
