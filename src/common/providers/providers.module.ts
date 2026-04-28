import { FallbackProviderModule, NonEmptyArray, SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { ConfigService } from '../config/config.service';
import { WorkingMode } from '../config/env.validation';
import { PrometheusService, RequestStatus } from '../prometheus';
import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { PatchedFallbackProvider } from './execution/patched-fallback-provider';

const buildProviderOptions = async (configService: ConfigService, prometheusService: PrometheusService) => ({
  urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
  network: configService.get('CHAIN_ID'),
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
});

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
