import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { ExitRequestsData, ProvableBeaconBlockHeader, ValidatorWitness } from './types';

@Injectable()
export class VerifierContract {
  private contract: ethers.Contract;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    const abi = [
      // BeaconBlockHeader struct
      'struct BeaconBlockHeader{' +
        'uint64 slot;' +
        'uint64 proposerIndex;' +
        'bytes32 parentRoot;' +
        'bytes32 stateRoot;' +
        'bytes32 bodyRoot;' +
      '}',
      // ProvableBeaconBlockHeader struct
      'struct ProvableBeaconBlockHeader{' +
        'BeaconBlockHeader header;' +
        'uint64 rootsTimestamp;' +
      '}',
      // ValidatorWitness struct
      'struct ValidatorWitness{' +
        'uint32 exitRequestIndex;' +
        'bytes32 withdrawalCredentials;' +
        'uint64 effectiveBalance;' +
        'bool slashed;' +
        'uint64 activationEligibilityEpoch;' +
        'uint64 activationEpoch;' +
        'uint64 withdrawableEpoch;' +
        'bytes32[] validatorProof;' +
      '}',
      // ExitRequestData struct
      'struct ExitRequestsData{' +
        'bytes data;' +
        'uint256 dataFormat;' +
      '}',
      // Main function
      'function verifyValidatorExitDelay(' +
        'ProvableBeaconBlockHeader calldata beaconBlock,' +
        'ValidatorWitness[] calldata validatorWitnesses,' +
        'ExitRequestsData calldata exitRequests' +
      ') external',
    ];
    
    this.contract = new ethers.Contract(
      this.config.get('VERIFIER_ADDRESS'),
      abi,
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
