import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';

import { ConfigService } from '../config/config.service';
import contractJson from '../contracts/abi/lido-locator.json';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class LidoLocatorContract {
  private contract: ethers.Contract;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    // Create interface from the ABI
    const iface = new ethers.utils.Interface(contractJson);

    this.contract = new ethers.Contract(this.config.get('LIDO_LOCATOR_ADDRESS'), iface, this.execution.provider);
  }

  public async getValidatorsExitBusOracle(): Promise<string> {
    return await this.contract.validatorsExitBusOracle();
  }

  public async getValidatorExitDelayVerifier(): Promise<string> {
    return await this.contract.validatorExitDelayVerifier();
  }

  public async getStakingRouter(): Promise<string> {
    return await this.contract.stakingRouter();
  }
}
