import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { VerifierContract } from './validator-exit-delay-verifier.service';
import { ExitRequestsContract } from './validator-exit-bus.service';
import { NodeOperatorsRegistryContract } from './nor.service';
import { LidoLocatorContract } from './lido-locator.service';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ConfigModule, ProvidersModule],
  providers: [
    VerifierContract,
    ExitRequestsContract,
    NodeOperatorsRegistryContract,
    LidoLocatorContract,
  ],
  exports: [
    VerifierContract,
    ExitRequestsContract,
    NodeOperatorsRegistryContract,
    LidoLocatorContract,
  ],
})
export class ContractsModule {}
