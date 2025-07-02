import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { ssz as sszType } from '@lodestar/types';
import { Inject, Injectable, Logger, LoggerService } from '@nestjs/common';
import { ethers } from 'ethers';

import { ConfigService } from '../config/config.service';
import { NodeOperatorsRegistryContract } from '../contracts/nor.service';
import { StakingRouterContract } from '../contracts/staking-router.service';
import { ProvableBeaconBlockHeader, ValidatorWitness } from '../contracts/types';
import { ExitRequestsContract } from '../contracts/validator-exit-bus.service';
import { VerifierContract } from '../contracts/validator-exit-delay-verifier.service';
import { generateHistoricalStateProof, generateValidatorProof, toHex } from '../helpers/proofs';
import { Consensus } from '../providers/consensus/consensus';
import { Execution } from '../providers/execution/execution';

let ssz: typeof sszType;

@Injectable()
export class ProverService {
  private readonly SHARD_COMMITTEE_PERIOD_IN_SECONDS: number;
  private readonly SLOTS_PER_HISTORICAL_ROOT = 8192; // Distance threshold for considering a slot as old
  private readonly logger = new Logger(ProverService.name);
  private readonly FAR_FUTURE_EPOCH = '18446744073709551615'; // 2^64 - 1

  constructor(
    @Inject(LOGGER_PROVIDER) private readonly loggerService: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly exitRequests: ExitRequestsContract,
    protected readonly verifier: VerifierContract,
    protected readonly config: ConfigService,
    protected readonly stakingRouter: StakingRouterContract,
    protected readonly execution: Execution,
  ) {
    this.SHARD_COMMITTEE_PERIOD_IN_SECONDS = this.config.get('SHARD_COMMITTEE_PERIOD_IN_SECONDS');
  }

  /**
   * Get the appropriate contract for a specific module ID
   * @param moduleId The staking module ID
   * @returns The NodeOperatorsRegistryContract instance
   * @throws Error if no contract found for the module
   */
  private getContractForModule(moduleId: number): NodeOperatorsRegistryContract {
    const moduleContract = this.stakingRouter.getStakingModuleContract(moduleId);
    if (!moduleContract) {
      throw new Error(`No contract found for staking module ${moduleId}.`);
    }
    return moduleContract;
  }

  private getEligibleExitRequestTimestamp(deliveredTimestamp: number, activationEpoch: number): number {
    // The earliest a validator can voluntarily exit is after the Shard Committee Period
    // subsequent to its activation epoch.
    const earliestPossibleVoluntaryExitTimestamp =
      this.consensus.genesisTimestamp +
      activationEpoch *
        Number(this.consensus.beaconConfig.SLOTS_PER_EPOCH) *
        Number(this.consensus.beaconConfig.SECONDS_PER_SLOT) +
      this.SHARD_COMMITTEE_PERIOD_IN_SECONDS;

    // The actual eligible timestamp is the max between the exit request submission time
    // and the earliest possible voluntary exit time.
    return Math.max(deliveredTimestamp, earliestPossibleVoluntaryExitTimestamp);
  }

  private getSecondsSinceExitIsEligible(eligibleExitRequestTimestamp: number, proofSlotTimestamp: number): number {
    return proofSlotTimestamp - eligibleExitRequestTimestamp;
  }

  /**
   * Calculate the slot number from an exit deadline
   * @param exitDeadlineTimestamp The exit deadline timestamp in seconds
   * @returns The corresponding slot number
   */
  private calculateSlotFromExitDeadline(exitDeadlineTimestamp: number): number {
    // Calculate how many slots have passed since genesis
    const secondsSinceGenesis = exitDeadlineTimestamp - this.consensus.genesisTimestamp;
    return Math.floor(secondsSinceGenesis / Number(this.consensus.beaconConfig.SECONDS_PER_SLOT));
  }

  private async processValidatorGroup(
    validatorGroup: {
      validator: ReturnType<typeof this.decodeValidatorsData>[0];
      activationEpoch: number;
      exitDeadlineEpoch: number;
    }[],
    deadlineSlot: number,
    proofSlotTimestamp: number,
    deliveredTimestamp: number,
    fromBlock: number,
    toBlock: number,
  ): Promise<{
    validatorWitnesses: ValidatorWitness[];
    processedValidators: number;
    skippedValidators: number;
  }> {
    const groupStartTime = Date.now();
    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Processing deadline slot group:` +
        `\n  Slot: ${deadlineSlot}` +
        `\n  Validators in group: ${validatorGroup.length}`,
    );

    // Get deadline state once for the group
    const deadlineState = await this.consensus.getState(deadlineSlot);
    const deadlineStateView = ssz[deadlineState.forkName].BeaconState.deserializeToView(deadlineState.bodyBytes);

    if (!deadlineStateView) {
      this.logger.error(
        `[Blocks ${fromBlock}-${toBlock}] Failed to deserialize deadline state view for slot ${deadlineSlot}`,
      );
      return {
        validatorWitnesses: [],
        processedValidators: 0,
        skippedValidators: validatorGroup.length,
      };
    }

    const validatorWitnesses: ValidatorWitness[] = [];
    let processedValidators = 0;
    let skippedValidators = 0;

    for (const { validator, activationEpoch, exitDeadlineEpoch } of validatorGroup) {
      const witness = await this.processValidator(
        validator,
        activationEpoch,
        exitDeadlineEpoch,
        deadlineStateView,
        proofSlotTimestamp,
        deliveredTimestamp,
        fromBlock,
        toBlock,
      );

      if (witness) {
        validatorWitnesses.push(witness);
        processedValidators++;
      } else {
        skippedValidators++;
      }
    }

    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Deadline slot group processing completed:` +
        `\n  Slot: ${deadlineSlot}` +
        `\n  Processing time: ${Date.now() - groupStartTime}ms`,
    );

    return { validatorWitnesses, processedValidators, skippedValidators };
  }

  private async processValidator(
    validator: ReturnType<typeof this.decodeValidatorsData>[0],
    activationEpoch: number,
    exitDeadlineEpoch: number,
    stateView: any,
    proofSlotTimestamp: number,
    deliveredTimestamp: number,
    fromBlock: number,
    toBlock: number,
  ): Promise<ValidatorWitness | null> {
    const validatorStartTime = Date.now();
    const validatorIndex = Number(validator.validatorIndex);
    const deadlineStateValidator = stateView.validators.getReadonly(validatorIndex);

    if (deadlineStateValidator.exitEpoch < exitDeadlineEpoch) {
      this.logger.log(
        `[Blocks ${fromBlock}-${toBlock}] Validator already exited:` +
          `\n  Index: ${validatorIndex}` +
          `\n  Public key: ${validator.validatorPubkey}` +
          `\n  Current exit epoch: ${deadlineStateValidator.exitEpoch}` +
          `\n  Required exit epoch: ${exitDeadlineEpoch}`,
      );
      return null;
    }

    const eligibleExitRequestTimestamp = this.getEligibleExitRequestTimestamp(deliveredTimestamp, activationEpoch);
    if (proofSlotTimestamp < eligibleExitRequestTimestamp) {
      return null;
    }

    const secondsSinceExitIsEligible = this.getSecondsSinceExitIsEligible(
      eligibleExitRequestTimestamp,
      proofSlotTimestamp,
    );

    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Validator eligibility check:` +
        `\n  Index: ${validatorIndex}` +
        `\n  Seconds since eligible: ${secondsSinceExitIsEligible}` +
        `\n  Processing time: ${Date.now() - validatorStartTime}ms`,
    );

    const isPenaltyApplicable = await this.getContractForModule(Number(validator.moduleId)).isValidatorExitDelayPenaltyApplicable(
      Number(validator.nodeOpId),
      proofSlotTimestamp,
      validator.validatorPubkey,
      secondsSinceExitIsEligible,
    );

    if (!isPenaltyApplicable) {
      this.logger.log(
        `[Blocks ${fromBlock}-${toBlock}] Validator skipped due to penalty:` +
          `\n  Index: ${validatorIndex}` +
          `\n  Public key: ${validator.validatorPubkey}`,
      );
      return null;
    }

    const proof = generateValidatorProof(stateView, validatorIndex);
    let withdrawableEpoch = deadlineStateValidator.withdrawableEpoch;
    if (withdrawableEpoch == Infinity) {
      withdrawableEpoch = this.FAR_FUTURE_EPOCH;
    }

    const witness: ValidatorWitness = {
      exitRequestIndex: validator.exitDataIndex,
      withdrawalCredentials: toHex(deadlineStateValidator.withdrawalCredentials),
      effectiveBalance: Number(deadlineStateValidator.effectiveBalance),
      slashed: Boolean(deadlineStateValidator.slashed),
      activationEligibilityEpoch: Number(deadlineStateValidator.activationEligibilityEpoch),
      activationEpoch: Number(deadlineStateValidator.activationEpoch),
      withdrawableEpoch: withdrawableEpoch,
      validatorProof: proof.witnesses.map(toHex),
      moduleId: Number(validator.moduleId),
      nodeOpId: Number(validator.nodeOpId),
      pubkey: validator.validatorPubkey,
    };

    this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Added validator ${validatorIndex} to witnesses`);
    return witness;
  }

  private async verifyValidatorGroup(
    validatorWitnesses: ValidatorWitness[],
    beaconBlock: ProvableBeaconBlockHeader,
    exitRequestsData: any,
  ): Promise<void> {
    this.logger.debug(
      'Beacon block:',
      JSON.stringify(
        {
          header: {
            slot: beaconBlock.header.slot.toString(),
            proposerIndex: beaconBlock.header.proposerIndex.toString(),
            parentRoot: beaconBlock.header.parentRoot,
            stateRoot: beaconBlock.header.stateRoot,
            bodyRoot: beaconBlock.header.bodyRoot,
          },
          rootsTimestamp: beaconBlock.rootsTimestamp.toString(),
        },
        null,
        2,
      ),
    );

    if (validatorWitnesses.length > 0) {
      this.logger.debug('ValidatorWitnesses:', JSON.stringify(validatorWitnesses, null, 2));
    }

    await this.verifier.verifyValidatorExitDelay(beaconBlock, validatorWitnesses, exitRequestsData);
  }

  public async handleBlock(fromBlock: number, toBlock: number): Promise<void> {
    const startTime = Date.now();
    try {
      this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Starting block processing`);
      const exitRequestsResult = await this.exitRequests.getExitRequestsFromBlock(fromBlock, toBlock);
      if (!exitRequestsResult) {
        this.logger.log(`[Blocks ${fromBlock}-${toBlock}] No exit requests found`);
        return;
      }

      this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Found ${exitRequestsResult.length} exit requests events`);
      this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Fetching finalized beacon state`);
      const state = await this.consensus.getState('finalized');
      const finalizedBlockHeader = await this.consensus.getBeaconHeader('finalized');
      const provableFinalizedBlockHeader = {
        header: {
          slot: Number(finalizedBlockHeader.header.message.slot),
          proposerIndex: Number(finalizedBlockHeader.header.message.proposer_index),
          parentRoot: finalizedBlockHeader.header.message.parent_root,
          stateRoot: finalizedBlockHeader.header.message.state_root,
          bodyRoot: finalizedBlockHeader.header.message.body_root,
        },
        rootsTimestamp: this.calcRootsTimestamp(Number(finalizedBlockHeader.header.message.slot)),
      };
      ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
      const finalizedStateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
      this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Using beacon state with fork ${state.forkName}`);

      for (const exitRequest of exitRequestsResult) {
        const requestStartTime = Date.now();
        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Processing exit request:` +
            `\n  Hash: ${exitRequest.exitRequestsHash}` +
            `\n  Data Format: ${exitRequest.exitRequestsData.dataFormat}`,
        );

        const validators = this.decodeValidatorsData(exitRequest.exitRequestsData.data);
        const deliveredTimestamp = await this.exitRequests.getExitRequestDeliveryTimestamp(
          exitRequest.exitRequestsHash,
        );
        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Exit request details:` +
            `\n  Validators count: ${validators.length}` +
            `\n  Delivery timestamp: ${deliveredTimestamp}` +
            `\n  Processing time: ${Date.now() - requestStartTime}ms`,
        );

        const groupingStartTime = Date.now();
        const validatorsByDeadlineSlot = await this.groupValidatorsByDeadlineSlot(
          validators,
          deliveredTimestamp,
          finalizedStateView,
          fromBlock,
          toBlock,
        );

        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Validator grouping completed:` +
            `\n  Total groups: ${validatorsByDeadlineSlot.size}` +
            `\n  Grouping time: ${Date.now() - groupingStartTime}ms`,
        );

        let totalProcessedValidators = 0;
        let totalSkippedValidators = 0;

        for (const [deadlineSlot, validatorGroup] of validatorsByDeadlineSlot) {
          const isOldSlot = await this.isSlotOld(deadlineSlot);
          const deadlineBlockHeader = await this.consensus.getBeaconHeader(deadlineSlot.toString());
          const proofSlotTimestamp = this.consensus.slotToTimestamp(deadlineSlot);
          const provableDeadlineBlockHeader = {
            header: {
              slot: Number(deadlineBlockHeader.header.message.slot),
              proposerIndex: Number(deadlineBlockHeader.header.message.proposer_index),
              parentRoot: deadlineBlockHeader.header.message.parent_root,
              stateRoot: deadlineBlockHeader.header.message.state_root,
              bodyRoot: deadlineBlockHeader.header.message.body_root,
            },
            rootsTimestamp: this.calcRootsTimestamp(deadlineSlot),
          };

          // here are proofs for all validators in the group
          const { validatorWitnesses, processedValidators, skippedValidators } = await this.processValidatorGroup(
            validatorGroup,
            deadlineSlot,
            proofSlotTimestamp,
            deliveredTimestamp,
            fromBlock,
            toBlock,
          );
          if (validatorWitnesses.length === 0) {
            continue;
          }
          totalProcessedValidators += processedValidators;
          totalSkippedValidators += skippedValidators;

          if (isOldSlot) {
            const summaryIndex = this.calcSummaryIndex(deadlineSlot);
            const rootIndexInSummary = this.calcRootIndexInSummary(deadlineSlot);
            const summarySlot = this.calcSlotOfSummary(summaryIndex);

            const summaryState = await this.consensus.getState(summarySlot);
            ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
            const summaryStateView = ssz[summaryState.forkName].BeaconState.deserializeToView(summaryState.bodyBytes);

            // Generate proof that this block's root exists in the historical summaries
            const proof = generateHistoricalStateProof(
              finalizedStateView,
              summaryStateView,
              summaryIndex,
              rootIndexInSummary,
            );
            // Get the block header for the deadline slot - this is the block where the validator missed their exit deadline
            const deadlineBlockHeader = await this.consensus.getBeaconHeader(deadlineSlot.toString());

            // Create the historical header witness using the deadline block header
            await this.verifier.verifyHistoricalValidatorExitDelay(
              // beaconBlock
              provableFinalizedBlockHeader,
              // oldBlock
              {
                header: {
                  slot: Number(deadlineBlockHeader.header.message.slot),
                  proposerIndex: Number(deadlineBlockHeader.header.message.proposer_index),
                  parentRoot: deadlineBlockHeader.header.message.parent_root,
                  stateRoot: deadlineBlockHeader.header.message.state_root,
                  bodyRoot: deadlineBlockHeader.header.message.body_root,
                },
                rootGIndex: '0x' + (proof.gindex.toString(16) + '00').padStart(64, '0'),
                proof: proof.witnesses.map((w) => ethers.utils.hexlify(w)),
              },
              validatorWitnesses,
              exitRequest.exitRequestsData,
            );
          } else {
            this.logger.log(
              `[Blocks ${fromBlock}-${toBlock}] Verifying validator exit delay:` +
                `\n  Witnesses count: ${validatorWitnesses.length}` +
                `\n  Block slot: ${provableDeadlineBlockHeader.header.slot}`,
            );
            const verificationStartTime = Date.now();
            await this.verifyValidatorGroup(
              validatorWitnesses,
              provableDeadlineBlockHeader,
              exitRequest.exitRequestsData,
            );
            this.logger.log(
              `[Blocks ${fromBlock}-${toBlock}] Verification completed:` +
                `\n  Verification time: ${Date.now() - verificationStartTime}ms`,
            );
          }
        }

        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Exit request processing completed:` +
            `\n  Total validators: ${validators.length}` +
            `\n  Processed: ${totalProcessedValidators}` +
            `\n  Skipped: ${totalSkippedValidators}` +
            `\n  Total processing time: ${Date.now() - requestStartTime}ms`,
        );
      }

      this.logger.log(
        `[Blocks ${fromBlock}-${toBlock}] Block processing completed:` +
          `\n  Total processing time: ${Date.now() - startTime}ms`,
      );
    } catch (error) {
      this.logger.error(
        `[Blocks ${fromBlock}-${toBlock}] Processing failed:` +
          `\n  Error: ${error instanceof Error ? error.message : String(error)}` +
          `\n  Total time: ${Date.now() - startTime}ms`,
        this.serializeError(error),
      );
      throw error;
    }
  }

  private serializeError(err: unknown): string {
    if (err instanceof Error) {
      return JSON.stringify(
        {
          name: err.name,
          message: err.message,
          stack: err.stack,
          ...Object.getOwnPropertyNames(err).reduce(
            (acc, key) => {
              acc[key] = (err as any)[key];
              return acc;
            },
            {} as Record<string, any>,
          ),
        },
        null,
        2,
      );
    } else {
      return JSON.stringify(err, null, 2);
    }
  }

  private async groupValidatorsByDeadlineSlot(
    validators: ReturnType<typeof this.decodeValidatorsData>,
    deliveredTimestamp: number,
    stateView: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<
    Map<
      number,
      {
        validator: ReturnType<typeof this.decodeValidatorsData>[0];
        activationEpoch: number;
        exitDeadlineEpoch: number;
      }[]
    >
  > {
    const validatorsByDeadlineSlot = new Map<
      number,
      {
        validator: ReturnType<typeof this.decodeValidatorsData>[0];
        activationEpoch: number;
        exitDeadlineEpoch: number;
      }[]
    >();

    for (const validator of validators) {
      const validatorIndex = Number(validator.validatorIndex);
      const stateValidator = stateView.validators.getReadonly(validatorIndex);
      const activationEpoch = stateValidator.activationEpoch;
      const eligibleExitRequestTimestamp = this.getEligibleExitRequestTimestamp(deliveredTimestamp, activationEpoch);
      const withdrawableEpoch = stateValidator.withdrawableEpoch;

      const exitDeadlineThreshold = await this.getContractForModule(Number(validator.moduleId)).exitDeadlineThreshold(Number(validator.nodeOpId));
      const exitDeadline = eligibleExitRequestTimestamp + exitDeadlineThreshold;
      // this is the slot where validator must exit
      const exitDeadlineSlot = this.calculateSlotFromExitDeadline(exitDeadline);
      const exitDeadlineEpoch = this.consensus.slotToEpoch(exitDeadlineSlot);

      this.logger.debug?.(
        `[Blocks ${fromBlock}-${toBlock}] Validator details:` +
          `\n  Index: ${validatorIndex}` +
          `\n  Public key: ${validator.validatorPubkey}` +
          `\n  Node Operator: ${validator.nodeOpId}` +
          `\n  Module ID: ${validator.moduleId}` +
          `\n  Activation epoch: ${activationEpoch}` +
          `\n  Withdrawable epoch: ${withdrawableEpoch}` +
          `\n  Exit deadline: ${exitDeadline}` +
          `\n  Exit deadline slot: ${exitDeadlineSlot}` +
          `\n  Exit deadline epoch: ${exitDeadlineEpoch}` +
          `\n  Exit deadline threshold: ${exitDeadlineThreshold}`,
      );

      if (!validatorsByDeadlineSlot.has(exitDeadlineSlot)) {
        validatorsByDeadlineSlot.set(exitDeadlineSlot, []);
      }
      validatorsByDeadlineSlot.get(exitDeadlineSlot)!.push({
        validator,
        activationEpoch,
        exitDeadlineEpoch,
      });
    }

    return validatorsByDeadlineSlot;
  }

  private decodeValidatorsData(encodedHex: string): {
    exitDataIndex: number;
    moduleId: bigint;
    nodeOpId: bigint;
    validatorIndex: bigint;
    validatorPubkey: string;
  }[] {
    // Remove '0x' prefix if present
    if (encodedHex.startsWith('0x')) {
      encodedHex = encodedHex.slice(2);
    }

    const data = Buffer.from(encodedHex, 'hex');

    const ENTRY_SIZE = 64;
    const entries: {
      exitDataIndex: number;
      moduleId: bigint;
      nodeOpId: bigint;
      validatorIndex: bigint;
      validatorPubkey: string;
    }[] = [];

    let exitDataIndex = 0;
    for (let offset = 0; offset < data.length; offset += ENTRY_SIZE) {
      const entry = data.subarray(offset, offset + ENTRY_SIZE);

      const moduleId = BigInt('0x' + entry.subarray(0, 3).toString('hex'));
      const nodeOpId = BigInt('0x' + entry.subarray(3, 8).toString('hex'));
      const validatorIndex = BigInt('0x' + entry.subarray(8, 16).toString('hex'));
      const validatorPubkey = '0x' + entry.subarray(16, 64).toString('hex');

      entries.push({
        exitDataIndex,
        moduleId,
        nodeOpId,
        validatorIndex,
        validatorPubkey,
      });
      exitDataIndex++;
    }

    return entries;
  }

  private calcSummaryIndex(slot: number): number {
    const capellaForkSlot = this.consensus.epochToSlot(Number(this.consensus.beaconConfig.CAPELLA_FORK_EPOCH));
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return Math.floor((slot - capellaForkSlot) / slotsPerHistoricalRoot);
  }

  private calcSlotOfSummary(summaryIndex: number): number {
    const capellaForkSlot = this.consensus.epochToSlot(Number(this.consensus.beaconConfig.CAPELLA_FORK_EPOCH));
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return capellaForkSlot + (summaryIndex + 1) * slotsPerHistoricalRoot;
  }

  private calcRootIndexInSummary(slot: number): number {
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return slot % slotsPerHistoricalRoot;
  }

  private calcRootsTimestamp(slot: number): number {
    return (
      this.consensus.genesisTimestamp +
      Number(this.consensus.beaconConfig.SECONDS_PER_SLOT) +
      slot * Number(this.consensus.beaconConfig.SECONDS_PER_SLOT)
    );
  }

  /**
   * Determines if a slot is considered "old" based on its distance from the current slot
   * A slot is considered old if it's at least SLOTS_PER_HISTORICAL_ROOT slots behind the current slot
   */
  private async isSlotOld(slot: number): Promise<boolean> {
    try {
      const currentHeader = await this.consensus.getBeaconHeader('head');
      if (!currentHeader) {
        throw new Error('Failed to get current beacon header');
      }

      const currentSlot = Number(currentHeader.header.message.slot);
      const distance = currentSlot - slot;

      this.logger.debug(
        `Checking if slot ${slot} is old:` +
          `\n  Current slot: ${currentSlot}` +
          `\n  Distance: ${distance}` +
          `\n  Threshold: ${this.SLOTS_PER_HISTORICAL_ROOT}` +
          `\n  Is old: ${distance >= this.SLOTS_PER_HISTORICAL_ROOT}`,
      );

      return distance >= this.SLOTS_PER_HISTORICAL_ROOT;
    } catch (error) {
      this.logger.error(`Failed to determine if slot ${slot} is old: ${this.serializeError(error)}`);
      throw error;
    }
  }
}
