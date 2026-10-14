import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';

import { LidoLocatorContract } from './lido-locator.service';
import { ExitRequestsData, HistoricalHeaderWitness, ProvableBeaconBlockHeader, ValidatorWitness } from './types';
import { ConfigService } from '../config/config.service';
import contractJson from '../contracts/abi/validator-exit-delay-verifier.json';
import { Execution } from '../providers/execution/execution';

/** The fork switch of the verifier deployed before Gloas support, which has no GLOAS_SLOT */
const LEGACY_FORK_SLOT_ABI = ['function PIVOT_SLOT() view returns (uint64)'];

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

      // Create interface from the ABI
      const iface = new ethers.utils.Interface(contractJson);

      this.contract = new ethers.Contract(this.verifierAddress, iface, this.execution.provider);

      const firstSupportedSlot = await this.contract.FIRST_SUPPORTED_SLOT();
      const genesisTime = await this.contract.GENESIS_TIME();
      const secondsPerSlot = await this.contract.SECONDS_PER_SLOT();
      const slotsPerHistoricalRoot = await this.contract.SLOTS_PER_HISTORICAL_ROOT();
      const forkSlot = await this.getForkSlot();
      const capellaSlot = await this.contract.CAPELLA_SLOT();

      this.logger.log(
        `VerifierContract initialized successfully:` +
          `\n  Address: ${this.verifierAddress}` +
          `\n  FIRST_SUPPORTED_SLOT: ${firstSupportedSlot}` +
          `\n  GENESIS_TIME: ${genesisTime}` +
          `\n  SECONDS_PER_SLOT: ${secondsPerSlot}` +
          `\n  SLOTS_PER_HISTORICAL_ROOT: ${slotsPerHistoricalRoot}` +
          `\n  ${forkSlot}` +
          `\n  CAPELLA_SLOT: ${capellaSlot}`,
      );
    } catch (error) {
      this.logger.error('Failed to initialize VerifierContract:', error.message);
      throw error;
    }
  }

  /**
   * The slot the deployed verifier switches its state layout at. Only logged: both verifier versions
   * take the same calls, so the bot has to start against either until the upgrade is enacted.
   */
  private async getForkSlot(): Promise<string> {
    try {
      return `GLOAS_SLOT: ${await this.contract.GLOAS_SLOT()}`;
    } catch {
      const legacy = new ethers.Contract(this.verifierAddress, LEGACY_FORK_SLOT_ABI, this.execution.provider);
      return `PIVOT_SLOT: ${await legacy.PIVOT_SLOT()}`;
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
      exitRequests,
    );
  }

  public async verifyHistoricalValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    oldBlock: HistoricalHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<any> {
    // Emulation call for the execution service
    return await this.contract.callStatic.verifyHistoricalValidatorExitDelay(
      beaconBlock,
      oldBlock,
      validatorWitnesses,
      exitRequests,
    );
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
      exitRequests,
    );
  }
}
