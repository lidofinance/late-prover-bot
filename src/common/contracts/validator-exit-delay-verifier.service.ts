import { join } from 'path';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';

import { ExitRequestsData, HistoricalHeaderWitness, ProvableBeaconBlockHeader, ValidatorWitness } from './types';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { LidoLocatorContract } from './lido-locator.service';

@Injectable()
export class VerifierContract implements OnModuleInit {
  private contract: ethers.Contract;
  private readonly logger = new Logger(VerifierContract.name);
  private verifierAddress: string;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly lidoLocator: LidoLocatorContract,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Get ValidatorExitDelayVerifier address from LidoLocator
      this.verifierAddress = await this.lidoLocator.getValidatorExitDelayVerifier();
      this.logger.log(`ValidatorExitDelayVerifier address from LidoLocator: ${this.verifierAddress}`);

      // Import the full ABI JSON
      const contractJson = require(
        join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'validator-exit-delay-verifier.json'),
      );

      // Create interface from the ABI
      const iface = new ethers.utils.Interface(contractJson);

      this.contract = new ethers.Contract(this.verifierAddress, iface, this.execution.provider);

      this.logger.log('VerifierContract initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize VerifierContract:', error.message);
      throw error;
    }
  }

  public async getShardCommitteePeriodInSeconds(): Promise<number> {
    try {
      const result = await this.contract.SHARD_COMMITTEE_PERIOD_IN_SECONDS();
      return Number(result);
    } catch (error) {
      this.logger.error('Error getting SHARD_COMMITTEE_PERIOD_IN_SECONDS:', error.reason || error.message);
      throw error;
    }
  }

  public async verifyValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<any> {
    // Emulation call for the execution service
    return await this.contract.callStatic.verifyValidatorExitDelay(beaconBlock, validatorWitnesses, exitRequests);
  }

  public async populateVerifyValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.PopulatedTransaction> {
    return await this.contract.populateTransaction.verifyValidatorExitDelay(
      beaconBlock,
      validatorWitnesses,
      exitRequests
    );
  }

  public async verifyHistoricalValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    oldBlock: HistoricalHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<any> {
    // Emulation call for the execution service
    return await this.contract.callStatic.verifyHistoricalValidatorExitDelay(beaconBlock, oldBlock, validatorWitnesses, exitRequests);
  }

  public async populateVerifyHistoricalValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    oldBlock: HistoricalHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.PopulatedTransaction> {
    return await this.contract.populateTransaction.verifyHistoricalValidatorExitDelay(
      beaconBlock,
      oldBlock,
      validatorWitnesses,
      exitRequests
    );
  }

}
