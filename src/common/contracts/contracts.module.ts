import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { VerifierContract } from './validator-exit-delay-verifier.service';
import { ExitRequestsContract } from './validator-exit-bus.service';
import { LidoLocatorContract } from './lido-locator.service';
import { StakingRouterContract } from './staking-router.service';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ConfigModule, ProvidersModule],
  providers: [
    VerifierContract,
    ExitRequestsContract,
    LidoLocatorContract,
    StakingRouterContract,
  ],
  exports: [
    VerifierContract,
    ExitRequestsContract,
    LidoLocatorContract,
    StakingRouterContract,
  ],
})
export class ContractsModule {}
