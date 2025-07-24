import { Module } from '@nestjs/common';

import { ProverService } from './prover.service';
import { ContractsModule } from '../contracts/contracts.module';
import { ProvidersModule } from '../providers/providers.module';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';

@Module({
  imports: [ProvidersModule, ContractsModule, ConfigModule],
  providers: [
    ProverService,
    {
      provide: 'VALIDATOR_BATCH_SIZE',
      useFactory: (configService: ConfigService) => 
        configService.get('VALIDATOR_BATCH_SIZE'),
      inject: [ConfigService],
    },
  ],
  exports: [ProverService],
})
export class ProverModule {}
