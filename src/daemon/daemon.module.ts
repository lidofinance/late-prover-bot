import { Module } from '@nestjs/common';

import { DaemonService } from './daemon.service';
import { LastProcessedRoot } from './services/last-processed-root';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import { ConfigModule } from '../common/config/config.module';
import { ContractsModule } from '../common/contracts/contracts.module';
import { HealthModule } from '../common/health/health.module';
import { LoggerModule } from '../common/logger/logger.module';
import { PrometheusModule } from '../common/prometheus/prometheus.module';
import { ProverModule } from '../common/prover/prover.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [LoggerModule, ConfigModule, HealthModule, PrometheusModule, ContractsModule, ProvidersModule, ProverModule],
  providers: [DaemonService, RootsProcessor, RootsProvider, LastProcessedRoot],
  exports: [DaemonService],
})
export class DaemonModule {}
