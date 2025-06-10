import { Module } from '@nestjs/common';

import { ProverService } from './prover.service';
import { ContractsModule } from '../contracts/contracts.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule, ContractsModule],
  providers: [ProverService],
  exports: [ProverService],
})
export class ProverModule {}
