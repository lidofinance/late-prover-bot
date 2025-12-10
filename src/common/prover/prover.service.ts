import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';

import { NodeOperatorsRegistryContract } from '../contracts/nor.service';
import { StakingRouterContract } from '../contracts/staking-router.service';
import { ValidatorWitness } from '../contracts/types';
import { ExitRequestsContract } from '../contracts/validator-exit-bus.service';
import { VerifierContract } from '../contracts/validator-exit-delay-verifier.service';
import { generateHistoricalStateProof, generateValidatorProof, toHex } from '../helpers/proofs';
import { getSizeRangeCategory } from '../prometheus/decorators';
import { PrometheusService } from '../prometheus/prometheus.service';
import { RequestError } from '../providers/base/rest-provider';
import { Consensus } from '../providers/consensus/consensus';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class ProverService implements OnModuleInit {
  private SHARD_COMMITTEE_PERIOD_IN_SECONDS: number;
  private readonly FAR_FUTURE_EPOCH = '18446744073709551615'; // 2^64 - 1

  // Persistent storage for validators grouped by deadline slot across multiple handleBlock calls
  private validatorsByDeadlineSlotStorage = new Map<
    number,
    {
      exitRequest: any;
      validators: {
        validator: ReturnType<typeof this.decodeValidatorsData>[0];
        activationEpoch: number;
        exitDeadlineEpoch: number;
      }[];
    }[]
  >();

  // Track validator pubkeys that have had proof transactions successfully submitted
  private reportedValidatorPubkeys = new Set<string>();

  constructor(
    @Inject(LOGGER_PROVIDER) private readonly loggerService: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly exitRequests: ExitRequestsContract,
    protected readonly verifier: VerifierContract,
    protected readonly stakingRouter: StakingRouterContract,
    protected readonly execution: Execution,
    protected readonly prometheus: PrometheusService,
    @Inject('VALIDATOR_BATCH_SIZE') private readonly validatorBatchSize: number,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.SHARD_COMMITTEE_PERIOD_IN_SECONDS = await this.verifier.getShardCommitteePeriodInSeconds();
      this.loggerService.log(
        `SHARD_COMMITTEE_PERIOD_IN_SECONDS from contract: ${this.SHARD_COMMITTEE_PERIOD_IN_SECONDS}`,
      );

      // Initialize storage with last 7 days of validator events
      await this.initializeStorageWithRecentEvents();
    } catch (error) {
      this.loggerService.error('Failed to initialize ProverService:', error.message);
      throw error;
    }
  }

  /**
   * Initialize storage with validator events from the last 7 days
   */
  private async initializeStorageWithRecentEvents(): Promise<void> {
    try {
      this.loggerService.log('Initializing storage with recent validator events...');

      // Calculate block range for last 7 days
      const currentBlock = await this.execution.provider.getBlockNumber();
      const SECONDS_PER_DAY = 24 * 60 * 60;
      const DAYS_TO_LOOK_BACK = 7;
      const AVERAGE_BLOCK_TIME = 12; // seconds per block on Ethereum

      const blocksToLookBack = Math.floor((DAYS_TO_LOOK_BACK * SECONDS_PER_DAY) / AVERAGE_BLOCK_TIME);
      const fromBlock = Math.max(1, currentBlock - blocksToLookBack);

      this.loggerService.log(
        `Scanning for exit requests in recent blocks:` +
          `\n  Current block: ${currentBlock}` +
          `\n  From block: ${fromBlock}` +
          `\n  Block range: ${blocksToLookBack} blocks (${DAYS_TO_LOOK_BACK} days)`,
      );

      // Use the same batch processing but without eligible validator processing
      await this.accumulateValidatorsFromBlocks(fromBlock, currentBlock);

      this.loggerService.log(
        `Storage initialization completed:` +
          `\n  Total deadline slots in storage: ${this.validatorsByDeadlineSlotStorage.size}`,
      );
    } catch (error) {
      this.loggerService.error('Failed to initialize storage with recent events:', error.message);
    } finally {
      this.updateValidatorStorageMetrics();
    }
  }

  /**
   * Accumulate validators from blocks without processing eligible ones
   * Similar to handleBlock but only accumulates validators in storage
   */
  private async accumulateValidatorsFromBlocks(fromBlock: number, toBlock: number): Promise<void> {
    const startTime = Date.now();

    this.loggerService.log(`[Init ${fromBlock}-${toBlock}] Starting validator accumulation`);

    // Prepare batches for processing
    const batches = this.createBatches(fromBlock, toBlock);
    this.loggerService.log(`[Init ${fromBlock}-${toBlock}] Created ${batches.length} batches for processing`);

    // Initialize beacon state and headers
    const beaconState = await this.initializeBeaconState(fromBlock, toBlock);

    // If beacon state deserialization failed, skip gracefully
    if (!beaconState) {
      this.loggerService.warn(
        `[Init ${fromBlock}-${toBlock}] Skipping initialization due to beacon node data corruption`,
      );
      return;
    }

    const { finalizedStateView } = beaconState;

    // Process all batches and accumulate validators in storage (without processing eligible ones)
    await this.processBatches(batches, finalizedStateView, fromBlock, toBlock);

    this.loggerService.log(
      `[Init ${fromBlock}-${toBlock}] Validator accumulation completed:` +
        `\n  Total processing time: ${Date.now() - startTime}ms` +
        `\n  Deadline slots in storage: ${this.validatorsByDeadlineSlotStorage.size}`,
    );
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
    const groupSize = validatorGroup.length;
    const groupSizeRange = getSizeRangeCategory(groupSize);

    // Track validator group processing
    const stopGroupTimer = this.prometheus.validatorGroupProcessingDuration.startTimer({
      deadline_slot: deadlineSlot.toString(),
      group_size_range: groupSizeRange,
    });

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Processing deadline slot group:` +
        `\n  Slot: ${deadlineSlot}` +
        `\n  Validators in group: ${validatorGroup.length}`,
    );

    // Track eligible validators
    this.prometheus.validatorsEligibleCount.set({ module_id: 'all' }, groupSize);

    const ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);

    // Track beacon state fetch
    const stopStateFetch = this.prometheus.beaconStateFetchDuration.startTimer({
      state_type: 'deadline',
    });

    const deadlineState = await this.consensus.getState(deadlineSlot);
    stopStateFetch();

    // Track state deserialization
    const stopDeserialization = this.prometheus.beaconStateDeserializationDuration.startTimer({
      fork_name: deadlineState.forkName,
    });

    let deadlineStateView;
    try {
      deadlineStateView = ssz[deadlineState.forkName].BeaconState.deserializeToView(deadlineState.bodyBytes);
    } catch (error) {
      this.prometheus.stateDeserializationErrorsCount.inc({
        fork_name: deadlineState.forkName,
      });

      this.loggerService.error(
        `[Blocks ${fromBlock}-${toBlock}] Failed to deserialize deadline state view for slot ${deadlineSlot}:` +
          `\n  Fork: ${deadlineState.forkName}` +
          `\n  Data size: ${deadlineState.bodyBytes.length} bytes` +
          `\n  Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        validatorWitnesses: [],
        processedValidators: 0,
        skippedValidators: validatorGroup.length,
      };
    } finally {
      stopDeserialization();
    }

    if (!deadlineStateView) {
      this.prometheus.stateDeserializationErrorsCount.inc({
        fork_name: deadlineState.forkName,
      });

      this.loggerService.error(
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

        // Track processed validator
        this.prometheus.validatorsProcessedCount.inc({
          module_id: validator.moduleId.toString(),
          processing_type: 'proof_generation',
        });
      } else {
        skippedValidators++;
      }
    }

    const processingDuration = Date.now() - groupStartTime;
    stopGroupTimer();

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Deadline slot group processing completed:` +
        `\n  Slot: ${deadlineSlot}` +
        `\n  Processing time: ${processingDuration}ms`,
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
    const moduleId = validator.moduleId.toString();

    // Track individual validator processing
    const stopValidatorTimer = this.prometheus.validatorProcessingDuration.startTimer({
      module_id: moduleId,
      processing_type: 'eligibility_check',
    });

    const deadlineStateValidator = stateView.validators.getReadonly(validatorIndex);

    // Check if validator already exited
    if (deadlineStateValidator.exitEpoch < exitDeadlineEpoch) {
      this.prometheus.exitAlreadyProcessedCount.inc({
        module_id: moduleId,
      });

      this.prometheus.validatorsSkippedCount.inc({
        module_id: moduleId,
        reason: 'already_exited',
      });

      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] Validator already exited:` +
          `\n  Index: ${validatorIndex}` +
          `\n  Public key: ${validator.validatorPubkey}` +
          `\n  Current exit epoch: ${deadlineStateValidator.exitEpoch}` +
          `\n  Required exit epoch: ${exitDeadlineEpoch}`,
      );

      stopValidatorTimer();
      return null;
    }

    const eligibleExitRequestTimestamp = this.getEligibleExitRequestTimestamp(deliveredTimestamp, activationEpoch);
    if (proofSlotTimestamp < eligibleExitRequestTimestamp) {
      this.prometheus.exitDeadlineFutureCount.inc({
        module_id: moduleId,
      });

      this.prometheus.validatorsSkippedCount.inc({
        module_id: moduleId,
        reason: 'not_eligible_yet',
      });

      stopValidatorTimer();
      return null;
    }

    const secondsSinceExitIsEligible = this.getSecondsSinceExitIsEligible(
      eligibleExitRequestTimestamp,
      proofSlotTimestamp,
    );

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Validator eligibility check:` +
        `\n  Index: ${validatorIndex}` +
        `\n  Seconds since eligible: ${secondsSinceExitIsEligible}` +
        `\n  Processing time: ${Date.now() - validatorStartTime}ms`,
    );

    // Check if this validator was already reported
    const wasReported = this.reportedValidatorPubkeys.has(validator.validatorPubkey);

    const isPenaltyApplicable = await this.getContractForModule(
      Number(validator.moduleId),
    ).isValidatorExitDelayPenaltyApplicable(
      Number(validator.nodeOpId),
      proofSlotTimestamp,
      validator.validatorPubkey,
      secondsSinceExitIsEligible,
    );

    // Track penalty application result
    this.prometheus.validatorsPenaltyApplicableCount.inc({
      module_id: moduleId,
      applicable: isPenaltyApplicable ? 'yes' : 'no',
    });

    if (!isPenaltyApplicable) {
      this.prometheus.validatorsSkippedCount.inc({
        module_id: moduleId,
        reason: 'penalty_not_applicable',
      });

      // If penalty is not applicable AND validator was previously reported,
      // we can remove it from our tracking set and it will be cleaned from storage
      if (wasReported) {
        this.reportedValidatorPubkeys.delete(validator.validatorPubkey);
        this.loggerService.log(
          `[Blocks ${fromBlock}-${toBlock}] Validator penalty no longer applicable (was reported):` +
            `\n  Index: ${validatorIndex}` +
            `\n  Public key: ${validator.validatorPubkey}` +
            `\n  Removed from tracking set - will be cleaned from storage`,
        );
      } else {
        this.loggerService.log(
          `[Blocks ${fromBlock}-${toBlock}] Validator skipped due to penalty:` +
            `\n  Index: ${validatorIndex}` +
            `\n  Public key: ${validator.validatorPubkey}` +
            `\n  Validator node operator: ${validator.nodeOpId}` +
            `\n  Validator module: ${validator.moduleId}`,
        );
      }

      stopValidatorTimer();
      return null;
    }

    // Track proof generation
    const stopProofGeneration = this.prometheus.proofGenerationDuration.startTimer({
      proof_type: 'validator',
      slot_type: 'current',
    });

    const proof = generateValidatorProof(stateView, validatorIndex);
    stopProofGeneration();

    this.prometheus.proofGenerationCount.inc({
      proof_type: 'validator',
      slot_type: 'current',
      status: 'success',
    });

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

    stopValidatorTimer();

    this.loggerService.log(`[Blocks ${fromBlock}-${toBlock}] Added validator ${validatorIndex} to witnesses`);
    return witness;
  }

  /**
   * Update validator storage metrics
   */
  private updateValidatorStorageMetrics(): void {
    const storageSize = this.validatorsByDeadlineSlotStorage.size;
    this.prometheus.validatorStorageDeadlineSlots.set(storageSize);

    if (storageSize > 0) {
      const slots = Array.from(this.validatorsByDeadlineSlotStorage.keys());
      const minSlot = slots.reduce((min, slot) => (slot < min ? slot : min), slots[0]);
      const maxSlot = slots.reduce((max, slot) => (slot > max ? slot : max), slots[0]);
      this.prometheus.validatorStorageMinSlot.set(minSlot);
      this.prometheus.validatorStorageMaxSlot.set(maxSlot);
    } else {
      // Reset min/max when storage is empty
      this.prometheus.validatorStorageMinSlot.set(0);
      this.prometheus.validatorStorageMaxSlot.set(0);
    }
  }

  /**
   * Add validators from an exit request to the persistent storage
   * @param validatorsByDeadlineSlot Validators grouped by deadline slot from a single exit request
   */
  private addToValidatorStorage(
    validatorsByDeadlineSlot: Map<
      number,
      {
        exitRequest: any;
        validators: {
          validator: ReturnType<typeof this.decodeValidatorsData>[0];
          activationEpoch: number;
          exitDeadlineEpoch: number;
        }[];
      }
    >,
  ): void {
    for (const [deadlineSlot, groupData] of validatorsByDeadlineSlot) {
      if (!this.validatorsByDeadlineSlotStorage.has(deadlineSlot)) {
        this.validatorsByDeadlineSlotStorage.set(deadlineSlot, []);
      }
      this.validatorsByDeadlineSlotStorage.get(deadlineSlot)!.push(groupData);
    }

    // Update metrics after adding
    this.updateValidatorStorageMetrics();
  }

  /**
   * Creates batches for block processing
   * @param fromBlock Starting block number
   * @param toBlock Ending block number
   * @param batchSize Size of each batch (default: 10000)
   * @returns Array of batch objects with from/to block numbers
   */
  private createBatches(
    fromBlock: number,
    toBlock: number,
    batchSize: number = 10000,
  ): Array<{ from: number; to: number }> {
    const blockRange = toBlock - fromBlock;
    const batches: Array<{ from: number; to: number }> = [];

    if (blockRange < batchSize) {
      // Single batch for small ranges
      batches.push({ from: fromBlock, to: toBlock });
    } else {
      // Multiple batches for large ranges
      let currentFrom = fromBlock;
      while (currentFrom <= toBlock) {
        const currentTo = Math.min(currentFrom + batchSize - 1, toBlock);
        batches.push({ from: currentFrom, to: currentTo });
        currentFrom = currentTo + 1;
      }
    }

    return batches;
  }

  /**
   * Initialize beacon state and headers for processing
   * Returns null if unable to deserialize state (beacon node data corruption issue)
   * Throws if unable to fetch state (network/API issue that should trigger alerts)
   */
  private async initializeBeaconState(
    fromBlock: number,
    toBlock: number,
  ): Promise<{
    finalizedStateView: any;
    provableFinalizedBlockHeader: any;
    ssz: any;
  } | null> {
    this.loggerService.log(`[Blocks ${fromBlock}-${toBlock}] Fetching finalized beacon state`);
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

    const ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);

    let finalizedStateView;
    try {
      finalizedStateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
    } catch (error) {
      this.prometheus.stateDeserializationErrorsCount.inc({
        fork_name: state.forkName,
      });
      this.loggerService.error(
        `[Blocks ${fromBlock}-${toBlock}] Failed to deserialize finalized state (beacon node data corruption):` +
          `\n  Fork: ${state.forkName}` +
          `\n  Data size: ${state.bodyBytes.length} bytes` +
          `\n  Error: ${error instanceof Error ? error.message : String(error)}` +
          `\n  Skipping this cycle - will retry when beacon node data is healthy`,
      );
      return null;
    }

    this.loggerService.log(`[Blocks ${fromBlock}-${toBlock}] Using beacon state with fork ${state.forkName}`);

    return { finalizedStateView, provableFinalizedBlockHeader, ssz };
  }

  /**
   * Process a single exit request and add validators to storage
   */
  private async processExitRequest(
    exitRequest: any,
    finalizedStateView: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    const requestStartTime = Date.now();
    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Processing exit request:` +
        `\n  Hash: ${exitRequest.exitRequestsHash}` +
        `\n  Data Format: ${exitRequest.exitRequestsData.dataFormat}`,
    );

    const validators = this.decodeValidatorsData(exitRequest.exitRequestsData.data);
    const deliveredTimestamp = await this.exitRequests.getExitRequestDeliveryTimestamp(exitRequest.exitRequestsHash);

    this.loggerService.log(
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
      exitRequest,
      fromBlock,
      toBlock,
    );

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Validator grouping completed:` +
        `\n  Total groups: ${validatorsByDeadlineSlot.size}` +
        `\n  Grouping time: ${Date.now() - groupingStartTime}ms`,
    );

    // Add validators to persistent storage
    this.addToValidatorStorage(validatorsByDeadlineSlot);

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Exit request accumulated:` +
        `\n  Total validators: ${validators.length}` +
        `\n  Added to storage` +
        `\n  Processing time: ${Date.now() - requestStartTime}ms`,
    );
  }

  /**
   * Process all batches of exit requests
   */
  private async processBatches(
    batches: Array<{ from: number; to: number }>,
    finalizedStateView: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchStartTime = Date.now();

      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] Processing batch ${i + 1}/${batches.length}: blocks ${batch.from}-${batch.to}`,
      );

      // Fetch exit requests for this batch only
      const exitRequestsResult = await this.exitRequests.getExitRequestsFromBlock(batch.from, batch.to);

      if (!exitRequestsResult || exitRequestsResult.length === 0) {
        this.loggerService.log(
          `[Blocks ${fromBlock}-${toBlock}] Batch ${i + 1}/${batches.length}: No exit requests found`,
        );
        continue;
      }

      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] Batch ${i + 1}/${batches.length}: Found ${exitRequestsResult.length} exit requests`,
      );

      // Process each exit request in this batch
      for (const exitRequest of exitRequestsResult) {
        await this.processExitRequest(exitRequest, finalizedStateView, fromBlock, toBlock);
      }

      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] Batch ${i + 1}/${batches.length} completed: ` +
          `${Date.now() - batchStartTime}ms`,
      );
    }
  }

  /**
   * Process a single deadline slot with all its validators
   */
  private async processDeadlineSlot(
    deadlineSlot: number,
    groupDataArray: any[],
    finalizedStateView: any,
    provableFinalizedBlockHeader: any,
    ssz: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<{ processedValidators: number; skippedValidators: number }> {
    // Combine all validators for this deadline slot from all exit requests
    let allValidators: {
      validator: ReturnType<typeof this.decodeValidatorsData>[0];
      activationEpoch: number;
      exitDeadlineEpoch: number;
    }[] = [];
    let exitRequest: any = null;

    for (const groupData of groupDataArray) {
      allValidators = allValidators.concat(groupData.validators);
      if (!exitRequest) {
        exitRequest = groupData.exitRequest; // Use the first exit request for the group
      }
    }

    // Get delivery timestamp from the first exit request
    const deliveredTimestamp = await this.exitRequests.getExitRequestDeliveryTimestamp(exitRequest.exitRequestsHash);

    const isOldSlot = await this.isSlotOld(deadlineSlot);

    const { slot: actualSlot, header: deadlineBlockHeader } = await this.findNextAvailableSlot(deadlineSlot);

    // Use the actual slot that has a block for proof timestamp
    const proofSlotTimestamp = this.consensus.slotToTimestamp(actualSlot);
    const provableDeadlineBlockHeader = {
      header: {
        slot: Number(deadlineBlockHeader.header.message.slot),
        proposerIndex: Number(deadlineBlockHeader.header.message.proposer_index),
        parentRoot: deadlineBlockHeader.header.message.parent_root,
        stateRoot: deadlineBlockHeader.header.message.state_root,
        bodyRoot: deadlineBlockHeader.header.message.body_root,
      },
      rootsTimestamp: this.calcRootsTimestamp(actualSlot),
    };

    // Process all combined validators for this deadline slot
    const { validatorWitnesses, processedValidators, skippedValidators } = await this.processValidatorGroup(
      allValidators,
      actualSlot,
      proofSlotTimestamp,
      deliveredTimestamp,
      fromBlock,
      toBlock,
    );

    if (validatorWitnesses.length === 0) {
      return { processedValidators: 0, skippedValidators: 0 };
    }

    if (isOldSlot) {
      await this.processHistoricalSlot(
        deadlineSlot,
        validatorWitnesses,
        exitRequest,
        finalizedStateView,
        provableFinalizedBlockHeader,
        ssz,
      );
    } else {
      await this.processCurrentSlot(validatorWitnesses, exitRequest, provableDeadlineBlockHeader, fromBlock, toBlock);
    }

    return { processedValidators, skippedValidators };
  }

  /**
   * Process historical slot verification
   */
  private async processHistoricalSlot(
    deadlineSlot: number,
    validatorWitnesses: any[],
    exitRequest: any,
    finalizedStateView: any,
    provableFinalizedBlockHeader: any,
    ssz: any,
  ): Promise<void> {
    // Split into batches to avoid oversized transactions
    const batches = this.createValidatorBatches(validatorWitnesses);

    this.loggerService.log(
      `Processing historical slot ${deadlineSlot} in ${batches.length} batches:` +
        `\n  Total validators: ${validatorWitnesses.length}` +
        `\n  Batch size: ${this.validatorBatchSize}` +
        `\n  Batches: ${batches.map((batch, i) => `${i + 1}(${batch.length})`).join(', ')}`,
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchStartTime = Date.now();

      this.loggerService.log(
        `Processing historical batch ${i + 1}/${batches.length}:` +
          `\n  Slot: ${deadlineSlot}` +
          `\n  Validators in batch: ${batch.length}`,
      );

      const summaryIndex = this.calcSummaryIndex(deadlineSlot);
      const rootIndexInSummary = this.calcRootIndexInSummary(deadlineSlot);
      const summarySlot = this.calcSlotOfSummary(summaryIndex);
      const summaryState = await this.consensus.getState(summarySlot);

      let summaryStateView;
      try {
        summaryStateView = ssz[summaryState.forkName].BeaconState.deserializeToView(summaryState.bodyBytes);
      } catch (error) {
        this.prometheus.stateDeserializationErrorsCount.inc({
          fork_name: summaryState.forkName,
        });
        this.loggerService.error(
          `❌ Historical batch ${i + 1}/${batches.length} skipped - Failed to deserialize summary state for slot ${summarySlot}:` +
            `\n  Fork: ${summaryState.forkName}` +
            `\n  Data size: ${summaryState.bodyBytes.length} bytes` +
            `\n  Error: ${error instanceof Error ? error.message : String(error)}` +
            `\n  This is beacon node data corruption - skipping this batch`,
        );
        // Skip this batch but continue with others
        continue;
      }

      // Generate proof that this block's root exists in the historical summaries
      const proof = generateHistoricalStateProof(
        finalizedStateView,
        summaryStateView,
        summaryIndex,
        rootIndexInSummary,
      );

      const { header: deadlineBlockHeader } = await this.findNextAvailableSlot(deadlineSlot);

      const oldBlock = {
        header: {
          slot: Number(deadlineBlockHeader.header.message.slot),
          proposerIndex: Number(deadlineBlockHeader.header.message.proposer_index),
          parentRoot: deadlineBlockHeader.header.message.parent_root,
          stateRoot: deadlineBlockHeader.header.message.state_root,
          bodyRoot: deadlineBlockHeader.header.message.body_root,
        },
        proof: proof.witnesses.map((w) => ethers.utils.hexlify(w)),
      };

      try {
        // Use execution service for transaction handling
        await this.execution.execute(
          // Emulation callback
          async (beaconBlock, oldBlock, validatorWitnesses, exitRequestsData) => {
            return await this.verifier.verifyHistoricalValidatorExitDelay(
              beaconBlock,
              oldBlock,
              validatorWitnesses,
              exitRequestsData,
            );
          },
          // Population callback
          async (beaconBlock, oldBlock, validatorWitnesses, exitRequestsData) => {
            return await this.verifier.populateVerifyHistoricalValidatorExitDelay(
              beaconBlock,
              oldBlock,
              validatorWitnesses,
              exitRequestsData,
            );
          },
          // Payload
          [provableFinalizedBlockHeader, oldBlock, batch, exitRequest.exitRequestsData],
        );

        // Transaction successful - add all validator pubkeys to reported set
        for (const witness of batch) {
          this.reportedValidatorPubkeys.add(witness.pubkey);
        }

        this.loggerService.log(
          `✅ Historical batch ${i + 1}/${batches.length} completed:` +
            `\n  Slot: ${deadlineSlot}` +
            `\n  Validators: ${batch.length}` +
            `\n  Reported validators tracked: ${this.reportedValidatorPubkeys.size}` +
            `\n  Processing time: ${Date.now() - batchStartTime}ms`,
        );
      } catch (error) {
        // Don't log full error details here - execution service has already logged them
        // Just log a brief reference for this batch context
        this.loggerService.error(
          `❌ Historical batch ${i + 1}/${batches.length} failed:` +
            `\n  Slot: ${deadlineSlot}` +
            `\n  Validators: ${batch.length}` +
            `\n  Error: ${this.getErrorReference(error)}`,
        );
        throw error;
      }
    }
  }

  /**
   * Process current slot verification
   */
  private async processCurrentSlot(
    validatorWitnesses: any[],
    exitRequest: any,
    provableDeadlineBlockHeader: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    // Split into batches to avoid oversized transactions
    const batches = this.createValidatorBatches(validatorWitnesses);

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Processing current slot in ${batches.length} batches:` +
        `\n  Total validators: ${validatorWitnesses.length}` +
        `\n  Block slot: ${provableDeadlineBlockHeader.header.slot}` +
        `\n  Batch size: ${this.validatorBatchSize}` +
        `\n  Batches: ${batches.map((batch, i) => `${i + 1}(${batch.length})`).join(', ')}`,
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchStartTime = Date.now();

      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] Processing batch ${i + 1}/${batches.length}:` +
          `\n  Validators in batch: ${batch.length}` +
          `\n  Block slot: ${provableDeadlineBlockHeader.header.slot}`,
      );

      try {
        const verificationStartTime = Date.now();

        // Use execution service for transaction handling
        await this.execution.execute(
          // Emulation callback
          async (beaconBlock, validatorWitnesses, exitRequestsData) => {
            return await this.verifier.verifyValidatorExitDelay(beaconBlock, validatorWitnesses, exitRequestsData);
          },
          // Population callback
          async (beaconBlock, validatorWitnesses, exitRequestsData) => {
            return await this.verifier.populateVerifyValidatorExitDelay(
              beaconBlock,
              validatorWitnesses,
              exitRequestsData,
            );
          },
          // Payload
          [provableDeadlineBlockHeader, batch, exitRequest.exitRequestsData],
        );

        // Transaction successful - add all validator pubkeys to reported set
        for (const witness of batch) {
          this.reportedValidatorPubkeys.add(witness.pubkey);
        }

        this.loggerService.log(
          `[Blocks ${fromBlock}-${toBlock}] ✅ Batch ${i + 1}/${batches.length} completed:` +
            `\n  Validators: ${batch.length}` +
            `\n  Reported validators tracked: ${this.reportedValidatorPubkeys.size}` +
            `\n  Verification time: ${Date.now() - verificationStartTime}ms` +
            `\n  Total batch time: ${Date.now() - batchStartTime}ms`,
        );
      } catch (error) {
        // Don't log full error details here - execution service has already logged them
        // Just log a brief reference for this batch context
        this.loggerService.error(
          `[Blocks ${fromBlock}-${toBlock}] ❌ Batch ${i + 1}/${batches.length} failed:` +
            `\n  Validators: ${batch.length}` +
            `\n  Block slot: ${provableDeadlineBlockHeader.header.slot}` +
            `\n  Error: ${this.getErrorReference(error)}`,
        );
        throw error;
      }
    }
  }

  /**
   * Process all eligible validators from storage
   */
  private async processEligibleValidators(
    finalizedStateView: any,
    provableFinalizedBlockHeader: any,
    ssz: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    // Filter storage entries where deadline slot <= current slot
    const currentSlot = Number(provableFinalizedBlockHeader.header.slot);
    const eligibleEntries = Array.from(this.validatorsByDeadlineSlotStorage.entries()).filter(
      ([deadlineSlot]) => deadlineSlot <= currentSlot,
    );

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Processing accumulated validators from storage:` +
        `\n  Current slot: ${currentSlot}` +
        `\n  Total deadline slots in storage: ${this.validatorsByDeadlineSlotStorage.size}` +
        `\n  Eligible deadline slots (passed): ${eligibleEntries.length}`,
    );

    if (eligibleEntries.length === 0) {
      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] No eligible validators to process - all deadlines are in the future`,
      );
      return;
    }

    let totalProcessedValidators = 0;
    let totalSkippedValidators = 0;

    for (const [deadlineSlot, groupDataArray] of eligibleEntries) {
      const deadlineSlotPenalizable = deadlineSlot + 1;
      const { processedValidators, skippedValidators } = await this.processDeadlineSlot(
        deadlineSlotPenalizable,
        groupDataArray,
        finalizedStateView,
        provableFinalizedBlockHeader,
        ssz,
        fromBlock,
        toBlock,
      );

      totalProcessedValidators += processedValidators;
      totalSkippedValidators += skippedValidators;
    }

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] All eligible validators processed:` +
        `\n  Total processed: ${totalProcessedValidators}` +
        `\n  Total skipped: ${totalSkippedValidators}` +
        `\n  Deadline slots processed: ${eligibleEntries.length}`,
    );

    // Remove processed entries from storage (validators no longer tracked after penalty check)
    await this.cleanupProcessedEntries(eligibleEntries, fromBlock, toBlock);
  }

  /**
   * Clean up processed entries from storage
   * Removes validators that are no longer in the reported set (penalty no longer applicable)
   */
  private async cleanupProcessedEntries(
    eligibleEntries: Array<[number, any[]]>,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    let totalValidatorsChecked = 0;
    let totalValidatorsRemoved = 0;
    let totalSlotsRemoved = 0;

    for (const [deadlineSlot, groupDataArray] of eligibleEntries) {
      // Collect all validators for this deadline slot
      let allValidators: {
        validator: ReturnType<typeof this.decodeValidatorsData>[0];
        activationEpoch: number;
        exitDeadlineEpoch: number;
      }[] = [];

      for (const groupData of groupDataArray) {
        // Use concat instead of spread to avoid stack overflow with large arrays
        allValidators = allValidators.concat(groupData.validators);
      }

      // Check each validator - remove if NOT in reported set (penalty no longer applicable)
      const remainingValidators: typeof allValidators = [];

      for (const validatorData of allValidators) {
        totalValidatorsChecked++;
        const { validator } = validatorData;

        // If validator is NOT in reported set, it means:
        // - Either it was never reported (shouldn't be in eligible entries, but keep it)
        // - Or it WAS reported but penalty is no longer applicable (was removed from set)
        const isStillTracked = this.reportedValidatorPubkeys.has(validator.validatorPubkey);

        if (!isStillTracked) {
          // Not in reported set - can be removed from storage
          totalValidatorsRemoved++;
          this.loggerService.debug?.(
            `[Blocks ${fromBlock}-${toBlock}] Validator removed from storage (no longer tracked):` +
              `\n  Validator index: ${validator.validatorIndex}` +
              `\n  Public key: ${validator.validatorPubkey}` +
              `\n  Deadline slot: ${deadlineSlot}`,
          );
        } else {
          // Still in reported set - keep in storage for next check
          remainingValidators.push(validatorData);
          this.loggerService.debug?.(
            `[Blocks ${fromBlock}-${toBlock}] Validator still tracked, keeping in storage:` +
              `\n  Validator index: ${validator.validatorIndex}` +
              `\n  Public key: ${validator.validatorPubkey}` +
              `\n  Deadline slot: ${deadlineSlot}`,
          );
        }
      }

      // Update storage: remove slot if all validators are reported, otherwise update with remaining validators
      if (remainingValidators.length === 0) {
        // All validators reported, remove the entire deadline slot
        this.validatorsByDeadlineSlotStorage.delete(deadlineSlot);
        totalSlotsRemoved++;
        this.loggerService.log(
          `[Blocks ${fromBlock}-${toBlock}] All validators reported for deadline slot ${deadlineSlot}, removing slot from storage`,
        );
      } else {
        // Some validators not yet reported, update storage with remaining validators
        const updatedGroupDataArray = groupDataArray
          .map((groupData) => {
            const remainingForThisGroup = remainingValidators.filter((v) =>
              groupData.validators.some((gv: any) => gv.validator.validatorIndex === v.validator.validatorIndex),
            );

            return {
              ...groupData,
              validators: remainingForThisGroup,
            };
          })
          .filter((groupData) => groupData.validators.length > 0);

        if (updatedGroupDataArray.length > 0) {
          this.validatorsByDeadlineSlotStorage.set(deadlineSlot, updatedGroupDataArray);
          this.loggerService.log(
            `[Blocks ${fromBlock}-${toBlock}] Deadline slot ${deadlineSlot} updated:` +
              `\n  Validators remaining: ${remainingValidators.length}` +
              `\n  Validators removed: ${allValidators.length - remainingValidators.length}`,
          );
        } else {
          this.validatorsByDeadlineSlotStorage.delete(deadlineSlot);
          totalSlotsRemoved++;
        }
      }
    }

    // Update metrics after cleanup
    this.updateValidatorStorageMetrics();

    this.loggerService.log(
      `[Blocks ${fromBlock}-${toBlock}] Cleaned up storage based on reported validators:` +
        `\n  Validators checked: ${totalValidatorsChecked}` +
        `\n  Validators removed: ${totalValidatorsRemoved}` +
        `\n  Validators remaining: ${totalValidatorsChecked - totalValidatorsRemoved}` +
        `\n  Deadline slots removed: ${totalSlotsRemoved}` +
        `\n  Deadline slots in storage: ${this.validatorsByDeadlineSlotStorage.size}` +
        `\n  Reported validators tracked: ${this.reportedValidatorPubkeys.size}`,
    );
  }

  public async handleBlock(fromBlock: number, toBlock: number): Promise<void> {
    const startTime = Date.now();
    try {
      this.loggerService.log(`[Blocks ${fromBlock}-${toBlock}] Starting block processing`);

      // Prepare batches for processing
      const batches = this.createBatches(fromBlock, toBlock);
      this.loggerService.log(`[Blocks ${fromBlock}-${toBlock}] Created ${batches.length} batches for processing`);

      // Initialize beacon state and headers
      const beaconState = await this.initializeBeaconState(fromBlock, toBlock);

      // If beacon state deserialization failed (beacon node data corruption), skip this cycle gracefully
      if (!beaconState) {
        this.loggerService.warn(
          `[Blocks ${fromBlock}-${toBlock}] Skipping block processing due to beacon node data corruption` +
            `\n  Will retry in next daemon cycle` +
            `\n  Total time: ${Date.now() - startTime}ms`,
        );
        return; // Return gracefully without throwing - don't trigger error_recovery alert
      }

      const { finalizedStateView, provableFinalizedBlockHeader, ssz } = beaconState;
      // Process all batches and accumulate validators in storage
      await this.processBatches(batches, finalizedStateView, fromBlock, toBlock);

      // Process eligible validators from storage
      await this.processEligibleValidators(finalizedStateView, provableFinalizedBlockHeader, ssz, fromBlock, toBlock);

      this.loggerService.log(
        `[Blocks ${fromBlock}-${toBlock}] Block processing completed:` +
          `\n  Total processing time: ${Date.now() - startTime}ms`,
      );
    } catch (error) {
      // Brief error summary without full details (detailed errors already logged by lower layers)
      this.loggerService.error(
        `[Blocks ${fromBlock}-${toBlock}] Processing failed:` +
          `\n  Error: ${this.getErrorReference(error)}` +
          `\n  Total time: ${Date.now() - startTime}ms`,
      );
      throw error;
    }
  }

  private async groupValidatorsByDeadlineSlot(
    validators: ReturnType<typeof this.decodeValidatorsData>,
    deliveredTimestamp: number,
    stateView: any,
    exitRequest: any,
    fromBlock: number,
    toBlock: number,
  ): Promise<
    Map<
      number,
      {
        exitRequest: any;
        validators: {
          validator: ReturnType<typeof this.decodeValidatorsData>[0];
          activationEpoch: number;
          exitDeadlineEpoch: number;
        }[];
      }
    >
  > {
    const validatorsByDeadlineSlot = new Map<
      number,
      {
        exitRequest: any;
        validators: {
          validator: ReturnType<typeof this.decodeValidatorsData>[0];
          activationEpoch: number;
          exitDeadlineEpoch: number;
        }[];
      }
    >();

    for (const validator of validators) {
      const validatorIndex = Number(validator.validatorIndex);
      const stateValidator = stateView.validators.getReadonly(validatorIndex);
      const activationEpoch = stateValidator.activationEpoch;
      const eligibleExitRequestTimestamp = this.getEligibleExitRequestTimestamp(deliveredTimestamp, activationEpoch);
      const withdrawableEpoch = stateValidator.withdrawableEpoch;

      const exitDeadlineThreshold = await this.getContractForModule(Number(validator.moduleId)).exitDeadlineThreshold(
        Number(validator.nodeOpId),
      );
      const exitDeadline = eligibleExitRequestTimestamp + exitDeadlineThreshold;
      // this is the slot where validator must exit
      const exitDeadlineSlot = this.calculateSlotFromExitDeadline(exitDeadline);
      const exitDeadlineEpoch = this.consensus.slotToEpoch(exitDeadlineSlot);

      this.loggerService.debug?.(
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
        validatorsByDeadlineSlot.set(exitDeadlineSlot, {
          exitRequest,
          validators: [],
        });
      }
      validatorsByDeadlineSlot.get(exitDeadlineSlot)!.validators.push({
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
   * Find the next available (non-skipped) slot at or after the given slot
   * Beacon chain can have skipped slots where no block was proposed
   *
   * @param startSlot The slot to start searching from
   * @param maxAttempts Maximum number of slots to try (default: 32, one epoch)
   * @returns The next available slot number and its header
   */
  private async findNextAvailableSlot(
    startSlot: number,
    maxAttempts: number = 32,
  ): Promise<{ slot: number; header: any }> {
    let currentSlot = startSlot;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const header = await this.consensus.getBeaconHeader(currentSlot.toString());
        // Successfully got header - this slot has a block
        this.loggerService.log(
          `Found available slot ${currentSlot}` +
            (currentSlot !== startSlot ? ` (requested: ${startSlot}, skipped: ${currentSlot - startSlot})` : ''),
        );
        return { slot: currentSlot, header };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry for 404 errors (skipped slots), throw all other errors
        if (!(error instanceof RequestError && error.statusCode === 404)) {
          throw error;
        }

        this.loggerService.debug?.(`Slot ${currentSlot} is skipped (404), trying next slot`);
        currentSlot++;
      }
    }

    throw new Error(
      `Failed to find available slot after ${maxAttempts} attempts starting from slot ${startSlot}. Last error: ${lastError?.message}`,
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

      const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);

      this.loggerService.debug?.(
        `Checking if slot ${slot} is old:` +
          `\n  Current slot: ${currentSlot}` +
          `\n  Distance: ${distance}` +
          `\n  Threshold: ${slotsPerHistoricalRoot}` +
          `\n  Is old: ${distance >= slotsPerHistoricalRoot}`,
      );

      return distance >= slotsPerHistoricalRoot;
    } catch (error) {
      this.loggerService.error(`Failed to determine if slot ${slot} is old: ${this.getErrorReference(error)}`);
      throw error;
    }
  }

  /**
   * Split validator witnesses into smaller batches to avoid oversized transactions
   */
  private createValidatorBatches<T>(validators: T[]): T[][] {
    const batchSize = this.validatorBatchSize;
    const batches: T[][] = [];

    for (let i = 0; i < validators.length; i += batchSize) {
      const batch = validators.slice(i, i + batchSize);
      batches.push(batch);
    }

    return batches;
  }

  /**
   * Get a brief error reference without full details to avoid duplicate logging
   */
  private getErrorReference(error: any): string {
    if (error instanceof Error) {
      // Extract error ID if present, otherwise create short reference
      const errorIdMatch = error.message.match(/\[ERR_\d+_[a-z0-9]+\]/);
      if (errorIdMatch) {
        return errorIdMatch[0]; // Return just the error ID
      }

      // For errors without ID, return just the first 100 characters
      const shortMessage = error.message.length > 100 ? error.message.substring(0, 100) + '...' : error.message;
      return `${error.name}: ${shortMessage}`;
    }

    const errorStr = String(error);
    return errorStr.length > 100 ? errorStr.substring(0, 100) + '...' : errorStr;
  }
}
