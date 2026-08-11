import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';

import { LidoLocatorContract } from './lido-locator.service';
import {
  BlockRootsHeaderWitness,
  ExitRequestsData,
  HistoricalHeaderWitness,
  ProvableBeaconBlockHeader,
  ValidatorWitness,
} from './types';
import { ConfigService } from '../config/config.service';
import legacyContractJson from '../contracts/abi/validator-exit-delay-verifier-legacy.json';
import contractJson from '../contracts/abi/validator-exit-delay-verifier.json';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class VerifierContract implements OnModuleInit {
  private contract: ethers.Contract;
  private readonly logger = new Logger(VerifierContract.name);
  private verifierAddress: string;
  /**
   * Whether the deployed verifier takes the proven block as a witness against a recent block's
   * `state.block_roots`, instead of anchoring it through EIP-4788 itself.
   *
   * This is a property of the deployment, not of the chain: the Gloas-capable verifier can be
   * deployed before the fork and handles pre-fork proofs too. So it is probed rather than configured
   * - an operator flag would have to be flipped in lockstep with a protocol upgrade, and a wrong
   * value fails at submission time.
   */
  private blockRootsWitnessSupported: boolean;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly lidoLocator: LidoLocatorContract,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.resolveVerifier();

      const firstSupportedSlot = await this.contract.FIRST_SUPPORTED_SLOT();
      const genesisTime = await this.contract.GENESIS_TIME();
      const secondsPerSlot = await this.contract.SECONDS_PER_SLOT();
      const slotsPerHistoricalRoot = await this.contract.SLOTS_PER_HISTORICAL_ROOT();
      const pivotSlot = await this.contract.PIVOT_SLOT();
      const capellaSlot = await this.contract.CAPELLA_SLOT();

      this.logger.log(
        `VerifierContract initialized successfully:` +
          `\n  Address: ${this.verifierAddress}` +
          `\n  Block roots witness supported: ${this.blockRootsWitnessSupported}` +
          `\n  FIRST_SUPPORTED_SLOT: ${firstSupportedSlot}` +
          `\n  GENESIS_TIME: ${genesisTime}` +
          `\n  SECONDS_PER_SLOT: ${secondsPerSlot}` +
          `\n  SLOTS_PER_HISTORICAL_ROOT: ${slotsPerHistoricalRoot}` +
          `\n  PIVOT_SLOT: ${pivotSlot}` +
          `\n  CAPELLA_SLOT: ${capellaSlot}`,
      );
    } catch (error) {
      this.logger.error('Failed to initialize VerifierContract:', error.message);
      throw error;
    }
  }

  /**
   * Re-read the verifier from the LidoLocator and probe what it expects.
   *
   * Called once per daemon cycle so a protocol upgrade - a new verifier address in the locator, or a
   * new implementation behind the same address - is picked up without restarting the bot.
   */
  public async refresh(): Promise<void> {
    const previousAddress = this.verifierAddress;
    const previousSupport = this.blockRootsWitnessSupported;

    await this.resolveVerifier();

    if (previousAddress !== this.verifierAddress || previousSupport !== this.blockRootsWitnessSupported) {
      this.logger.log(
        `ValidatorExitDelayVerifier changed:` +
          `\n  Address: ${previousAddress} -> ${this.verifierAddress}` +
          `\n  Block roots witness supported: ${previousSupport} -> ${this.blockRootsWitnessSupported}`,
      );
    }
  }

  /** See {@link blockRootsWitnessSupported} */
  public supportsBlockRootsWitness(): boolean {
    return this.blockRootsWitnessSupported;
  }

  private async resolveVerifier(): Promise<void> {
    this.verifierAddress = await this.lidoLocator.getValidatorExitDelayVerifier();

    // GI_VALIDATORS is the generalized index of the Gloas validators node and exists only on the
    // verifier that walks into the progressive list itself, i.e. the one taking a block roots witness
    this.blockRootsWitnessSupported = await new ethers.Contract(
      this.verifierAddress,
      new ethers.utils.Interface(contractJson),
      this.execution.provider,
    )
      .GI_VALIDATORS()
      .then(() => true)
      .catch(() => false);

    this.contract = new ethers.Contract(
      this.verifierAddress,
      new ethers.utils.Interface(this.blockRootsWitnessSupported ? contractJson : legacyContractJson),
      this.execution.provider,
    );
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

  /**
   * @param recentBlock A block whose root the verifier reads from the EIP-4788 predeploy.
   * @param targetBlock The block the validators are proven at, itself proven against
   *   `recentBlock.header.stateRoot` through the state's `block_roots`.
   */
  public async verifyValidatorExitDelay(
    recentBlock: ProvableBeaconBlockHeader,
    targetBlock: BlockRootsHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<any> {
    // Emulation call for the execution service
    return await this.contract.callStatic.verifyValidatorExitDelay(
      recentBlock,
      targetBlock,
      validatorWitnesses,
      exitRequests,
    );
  }

  public async populateVerifyValidatorExitDelay(
    recentBlock: ProvableBeaconBlockHeader,
    targetBlock: BlockRootsHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.PopulatedTransaction> {
    return await this.contract.populateTransaction.verifyValidatorExitDelay(
      recentBlock,
      targetBlock,
      validatorWitnesses,
      exitRequests,
    );
  }

  /** The pre-Gloas verifier: the proven block is anchored through EIP-4788 itself. */
  public async verifyValidatorExitDelayLegacy(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<any> {
    return await this.contract.callStatic.verifyValidatorExitDelay(beaconBlock, validatorWitnesses, exitRequests);
  }

  public async populateVerifyValidatorExitDelayLegacy(
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
