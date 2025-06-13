import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { ExitRequestsData, ProvableBeaconBlockHeader, ValidatorWitness } from './types';
import { join } from 'path';

@Injectable()
export class VerifierContract {
  private contract: ethers.Contract;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    // Import the full ABI JSON
    const contractJson = require(join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'validator-exit-delay-verifier.json'));
    
    // Create interface from the ABI
    const iface = new ethers.utils.Interface(contractJson);
    
    this.contract = new ethers.Contract(
      this.config.get('VERIFIER_ADDRESS'),
      iface,
      this.execution.provider,
    );
  }

  public async verifyValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData
  ): Promise<ethers.ContractTransaction> {
    return await this.contract.verifyValidatorExitDelay(
      beaconBlock,
      validatorWitnesses,
      exitRequests
    );
  }
}
