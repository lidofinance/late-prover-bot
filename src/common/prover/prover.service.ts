import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

import { Consensus } from '../providers/consensus/consensus';
import { ExitRequestsContract } from '../contracts/validator-exit-bus.service';
import { ProvableBeaconBlockHeader, ValidatorWitness } from '../contracts/types';
import { VerifierContract } from '../contracts/validator-exit-delay-verifier.service';
import { generateValidatorProof, toHex } from '../helpers/proofs';
import type { ssz as sszType } from '@lodestar/types';
import { ConfigService } from '../config/config.service';
import { NodeOperatorsRegistryContract } from '../contracts/nor.service';
import { Execution } from '../providers/execution/execution';
import { BeaconBlockHeader } from '../contracts/types';

let ssz: typeof sszType;

@Injectable()
export class ProverService {
  private readonly SHARD_COMMITTEE_PERIOD_IN_SECONDS: number;
  private readonly logger = new Logger(ProverService.name);

  constructor(
    protected readonly consensus: Consensus,
    protected readonly exitRequests: ExitRequestsContract,
    protected readonly verifier: VerifierContract,
    protected readonly config: ConfigService,
    protected readonly nor: NodeOperatorsRegistryContract,
    protected readonly execution: Execution,
  ) {
    this.SHARD_COMMITTEE_PERIOD_IN_SECONDS = this.config.get('SHARD_COMMITTEE_PERIOD_IN_SECONDS');
  }

  private getEligibleExitRequestTimestamp(
    deliveredTimestamp: number,
    activationEpoch: number,
  ): number {
    // The earliest a validator can voluntarily exit is after the Shard Committee Period
    // subsequent to its activation epoch.
    const earliestPossibleVoluntaryExitTimestamp = this.consensus.genesisTimestamp +
      (activationEpoch * Number(this.consensus.beaconConfig.SLOTS_PER_EPOCH) * Number(this.consensus.beaconConfig.SECONDS_PER_SLOT)) +
      this.SHARD_COMMITTEE_PERIOD_IN_SECONDS;

    // The actual eligible timestamp is the max between the exit request submission time
    // and the earliest possible voluntary exit time.
    const eligibleExitRequestTimestamp = Math.max(
      deliveredTimestamp,
      earliestPossibleVoluntaryExitTimestamp
    );

    return eligibleExitRequestTimestamp;
  }


  private getSecondsSinceExitIsEligible(
    eligibleExitRequestTimestamp: number,
    referenceSlotTimestamp: number
  ): number {
    return referenceSlotTimestamp - eligibleExitRequestTimestamp;
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
    validatorGroup: { validator: ReturnType<typeof this.decodeValidatorsData>[0], activationEpoch: number, exitDeadlineEpoch: number }[],
    deadlineSlot: number,
    stateView: any,
    deliveryTimestamp: number,
    fromBlock: number,
    toBlock: number
  ): Promise<{
    validatorWitnesses: ValidatorWitness[],
    processedValidators: number,
    skippedValidators: number,
    deadlineStateView: any
  }> {
    const groupStartTime = Date.now();
    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Processing deadline slot group:` +
      `\n  Slot: ${deadlineSlot}` +
      `\n  Validators in group: ${validatorGroup.length}`
    );

    // Get deadline state once for the group
    const deadlineState = await this.consensus.getState(deadlineSlot);
    const deadlineStateView = ssz[deadlineState.forkName].BeaconState.deserializeToView(deadlineState.bodyBytes);

    if (!deadlineStateView) {
      this.logger.error(`[Blocks ${fromBlock}-${toBlock}] Failed to deserialize deadline state view for slot ${deadlineSlot}`);
      return { validatorWitnesses: [], processedValidators: 0, skippedValidators: validatorGroup.length, deadlineStateView: null };
    }

    const rootsTimestamp = this.consensus.genesisTimestamp + Number(deadlineStateView.latestBlockHeader.slot) * Number(this.consensus.beaconConfig.SECONDS_PER_SLOT);

    const validatorWitnesses: ValidatorWitness[] = [];
    let processedValidators = 0;
    let skippedValidators = 0;

    for (const { validator, activationEpoch, exitDeadlineEpoch } of validatorGroup) {
      const result = await this.processValidator(
        validator,
        activationEpoch,
        exitDeadlineEpoch,
        deadlineStateView,
        stateView,
        deliveryTimestamp,
        rootsTimestamp,
        fromBlock,
        toBlock
      );

      if (result.witness) {
        validatorWitnesses.push(result.witness);
        processedValidators++;
      } else {
        skippedValidators++;
      }
    }

    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Deadline slot group processing completed:` +
      `\n  Slot: ${deadlineSlot}` +
      `\n  Processing time: ${Date.now() - groupStartTime}ms`
    );

    return { validatorWitnesses, processedValidators, skippedValidators, deadlineStateView };
  }

  private async processValidator(
    validator: ReturnType<typeof this.decodeValidatorsData>[0],
    activationEpoch: number,
    exitDeadlineEpoch: number,
    deadlineStateView: any,
    stateView: any,
    deliveryTimestamp: number,
    rootsTimestamp: number,
    fromBlock: number,
    toBlock: number
  ): Promise<{ witness: ValidatorWitness | null }> {
    const validatorStartTime = Date.now();
    const validatorIndex = Number(validator.validatorIndex);
    const deadlineStateValidator = deadlineStateView.validators.getReadonly(validatorIndex);

    if (deadlineStateValidator.exitEpoch < exitDeadlineEpoch) {
      this.logger.log(
        `[Blocks ${fromBlock}-${toBlock}] Validator already exited:` +
        `\n  Index: ${validatorIndex}` +
        `\n  Public key: ${validator.validatorPubkey}` +
        `\n  Current exit epoch: ${deadlineStateValidator.exitEpoch}` +
        `\n  Required exit epoch: ${exitDeadlineEpoch}`
      );
      return { witness: null };
    }

    const eligibleExitRequestTimestamp = this.getEligibleExitRequestTimestamp(
      deliveryTimestamp,
      activationEpoch,
    );

    const secondsSinceExitIsEligible = this.getSecondsSinceExitIsEligible(
      eligibleExitRequestTimestamp,
      rootsTimestamp,
    );

    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Validator eligibility check:` +
      `\n  Index: ${validatorIndex}` +
      `\n  Seconds since eligible: ${secondsSinceExitIsEligible}` +
      `\n  Processing time: ${Date.now() - validatorStartTime}ms`
    );

    const isPenaltyApplicable = await this.nor.isValidatorExitDelayPenaltyApplicable(
      Number(validator.nodeOpId),
      rootsTimestamp,
      validator.validatorPubkey,
      secondsSinceExitIsEligible
    );

    if (!isPenaltyApplicable) {
      this.logger.log(
        `[Blocks ${fromBlock}-${toBlock}] Validator skipped due to penalty:` +
        `\n  Index: ${validatorIndex}` +
        `\n  Public key: ${validator.validatorPubkey}`
      );
      return { witness: null };
    }

    const proofStartTime = Date.now();
    const proof = generateValidatorProof(stateView, validatorIndex);
    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Generated validator proof:` +
      `\n  Index: ${validatorIndex}` +
      `\n  Proof generation time: ${Date.now() - proofStartTime}ms`
    );

    const witness: ValidatorWitness = {
      exitRequestIndex: Number(validatorIndex),
      withdrawalCredentials: toHex(deadlineStateValidator.withdrawalCredentials),
      effectiveBalance: Number(deadlineStateValidator.effectiveBalance),
      slashed: Boolean(deadlineStateValidator.slashed),
      activationEligibilityEpoch: Number(deadlineStateValidator.activationEligibilityEpoch),
      activationEpoch: Number(deadlineStateValidator.activationEpoch),
      withdrawableEpoch: Number(deadlineStateValidator.withdrawableEpoch),
      validatorProof: proof.witnesses.map(toHex),
      moduleId: Number(validator.moduleId),
      nodeOpId: Number(validator.nodeOpId),
      pubkey: validator.validatorPubkey
    };

    this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Added validator ${validatorIndex} to witnesses`);
    return { witness };
  }

  private async verifyValidatorGroup(
    validatorWitnesses: ValidatorWitness[],
    beaconBlock: ProvableBeaconBlockHeader,
    exitRequestsData: any,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const verificationStartTime = Date.now();

    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Verifying validator exit delay:` +
      `\n  Witnesses count: ${validatorWitnesses.length}` +
      `\n  Block slot: ${beaconBlock.header.slot}`
    );

    // Add detailed debug logging
    this.logger.debug('Beacon block:', JSON.stringify({
      header: {
        slot: beaconBlock.header.slot.toString(),
        proposerIndex: beaconBlock.header.proposerIndex.toString(),
        parentRoot: beaconBlock.header.parentRoot,
        stateRoot: beaconBlock.header.stateRoot,
        bodyRoot: beaconBlock.header.bodyRoot
      },
      rootsTimestamp: beaconBlock.rootsTimestamp.toString()
    }, null, 2));

    // Log first witness as example
    if (validatorWitnesses.length > 0) {
      this.logger.debug('Example validator witness:', JSON.stringify({
        exitRequestIndex: validatorWitnesses[0].exitRequestIndex.toString(),
        withdrawalCredentials: validatorWitnesses[0].withdrawalCredentials,
        effectiveBalance: validatorWitnesses[0].effectiveBalance.toString(),
        slashed: validatorWitnesses[0].slashed,
        activationEligibilityEpoch: validatorWitnesses[0].activationEligibilityEpoch.toString(),
        activationEpoch: validatorWitnesses[0].activationEpoch.toString(),
        withdrawableEpoch: validatorWitnesses[0].withdrawableEpoch.toString(),
        moduleId: validatorWitnesses[0].moduleId.toString(),
        nodeOpId: validatorWitnesses[0].nodeOpId.toString(),
        pubkey: validatorWitnesses[0].pubkey
      }, null, 2));
    }

    await this.verifier.verifyValidatorExitDelay(
      beaconBlock,
      validatorWitnesses,
      exitRequestsData
    );

    this.logger.log(
      `[Blocks ${fromBlock}-${toBlock}] Verification completed:` +
      `\n  Verification time: ${Date.now() - verificationStartTime}ms`
    );
  }

  public async handleBlock(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
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
      ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
      const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
      this.logger.log(`[Blocks ${fromBlock}-${toBlock}] Using beacon state with fork ${state.forkName}`);

      for (const exitRequest of exitRequestsResult) {
        const requestStartTime = Date.now();
        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Processing exit request:` +
          `\n  Hash: ${exitRequest.exitRequestsHash}` +
          `\n  Data Format: ${exitRequest.exitRequestsData.dataFormat}`
        );

        const validators = this.decodeValidatorsData(exitRequest.exitRequestsData.data);
        const deliveryTimestamp = await this.exitRequests.getDeliveryTimestamp(exitRequest.exitRequestsHash);
        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Exit request details:` +
          `\n  Validators count: ${validators.length}` +
          `\n  Delivery timestamp: ${deliveryTimestamp}` +
          `\n  Processing time: ${Date.now() - requestStartTime}ms`
        );

        const groupingStartTime = Date.now();
        const validatorsByDeadlineSlot = await this.groupValidatorsByDeadlineSlot(
          validators,
          deliveryTimestamp,
          stateView,
          fromBlock,
          toBlock
        );

        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Validator grouping completed:` +
          `\n  Total groups: ${validatorsByDeadlineSlot.size}` +
          `\n  Grouping time: ${Date.now() - groupingStartTime}ms`
        );

        let totalProcessedValidators = 0;
        let totalSkippedValidators = 0;

        for (const [deadlineSlot, validatorGroup] of validatorsByDeadlineSlot) {
          const { validatorWitnesses, processedValidators, skippedValidators, deadlineStateView } = await this.processValidatorGroup(
            validatorGroup,
            deadlineSlot,
            stateView,
            deliveryTimestamp,
            fromBlock,
            toBlock
          );

          totalProcessedValidators += processedValidators;
          totalSkippedValidators += skippedValidators;

          if (validatorWitnesses.length > 0) {
            // add historical calls
            const beaconBlock = {
              header: {
                slot: ethers.BigNumber.from(deadlineStateView.latestBlockHeader.slot),
                proposerIndex: ethers.BigNumber.from(deadlineStateView.latestBlockHeader.proposerIndex),
                parentRoot: ethers.utils.hexlify(deadlineStateView.latestBlockHeader.parentRoot),
                stateRoot: ethers.utils.hexlify(deadlineStateView.latestBlockHeader.stateRoot),
                bodyRoot: ethers.utils.hexlify(deadlineStateView.latestBlockHeader.bodyRoot),
              },
              rootsTimestamp: ethers.BigNumber.from(this.consensus.genesisTimestamp)
                .add(ethers.BigNumber.from(deadlineStateView.latestBlockHeader.slot)
                  .mul(ethers.BigNumber.from(this.consensus.beaconConfig.SECONDS_PER_SLOT)))
            };
            await this.verifyValidatorGroup(
              validatorWitnesses,
              beaconBlock,
              exitRequest.exitRequestsData,
              fromBlock,
              toBlock
            );
          }
        }

        this.logger.log(
          `[Blocks ${fromBlock}-${toBlock}] Exit request processing completed:` +
          `\n  Total validators: ${validators.length}` +
          `\n  Processed: ${totalProcessedValidators}` +
          `\n  Skipped: ${totalSkippedValidators}` +
          `\n  Total processing time: ${Date.now() - requestStartTime}ms`
        );
      }

      this.logger.log(
        `[Blocks ${fromBlock}-${toBlock}] Block processing completed:` +
        `\n  Total processing time: ${Date.now() - startTime}ms`
      );
    } catch (error) {
      this.logger.error(
        `[Blocks ${fromBlock}-${toBlock}] Processing failed:` +
        `\n  Error: ${error instanceof Error ? error.message : String(error)}` +
        `\n  Total time: ${Date.now() - startTime}ms`,
        error
      );
      throw error;
    }
  }

  private async groupValidatorsByDeadlineSlot(
    validators: ReturnType<typeof this.decodeValidatorsData>,
    deliveryTimestamp: number,
    stateView: any,
    fromBlock: number,
    toBlock: number
  ): Promise<Map<number, { validator: ReturnType<typeof this.decodeValidatorsData>[0], activationEpoch: number, exitDeadlineEpoch: number }[]>> {
    const validatorsByDeadlineSlot = new Map<number, {
      validator: ReturnType<typeof this.decodeValidatorsData>[0],
      activationEpoch: number,
      exitDeadlineEpoch: number
    }[]>();

    for (const validator of validators) {
      const validatorIndex = Number(validator.validatorIndex);
      const stateValidator = stateView.validators.getReadonly(validatorIndex);
      const activationEpoch = stateValidator.activationEpoch;
      const eligibleExitRequestTimestamp = this.getEligibleExitRequestTimestamp(
        deliveryTimestamp,
        activationEpoch,
      );

      const exitDeadlineThreshold = await this.nor.exitDeadlineThreshold(Number(validator.nodeOpId));
      const exitDeadline = eligibleExitRequestTimestamp + exitDeadlineThreshold;
      const exitDeadlineSlot = this.calculateSlotFromExitDeadline(exitDeadline);
      const exitDeadlineEpoch = this.consensus.slotToEpoch(exitDeadlineSlot);

      this.logger.debug?.(
        `[Blocks ${fromBlock}-${toBlock}] Validator details:` +
        `\n  Index: ${validatorIndex}` +
        `\n  Public key: ${validator.validatorPubkey}` +
        `\n  Node Operator: ${validator.nodeOpId}` +
        `\n  Module ID: ${validator.moduleId}` +
        `\n  Activation epoch: ${activationEpoch}` +
        `\n  Exit deadline: ${exitDeadline}` +
        `\n  Exit deadline slot: ${exitDeadlineSlot}` +
        `\n  Exit deadline epoch: ${exitDeadlineEpoch}` +
        `\n  Exit deadline threshold: ${exitDeadlineThreshold}`
      );

      if (!validatorsByDeadlineSlot.has(exitDeadlineSlot)) {
        validatorsByDeadlineSlot.set(exitDeadlineSlot, []);
      }
      validatorsByDeadlineSlot.get(exitDeadlineSlot)!.push({
        validator,
        activationEpoch,
        exitDeadlineEpoch
      });
    }

    return validatorsByDeadlineSlot;
  }

  private decodeValidatorsData(encodedHex: string): {
    moduleId: bigint,
    nodeOpId: bigint,
    validatorIndex: bigint,
    validatorPubkey: string,
  }[] {
    // Remove '0x' prefix if present
    if (encodedHex.startsWith('0x')) {
      encodedHex = encodedHex.slice(2);
    }

    const data = Buffer.from(encodedHex, 'hex');

    const ENTRY_SIZE = 64;
    const entries: {
      moduleId: bigint,
      nodeOpId: bigint,
      validatorIndex: bigint,
      validatorPubkey: string,
    }[] = [];

    for (let offset = 0; offset < data.length; offset += ENTRY_SIZE) {
      const entry = data.subarray(offset, offset + ENTRY_SIZE);

      const moduleId = BigInt('0x' + entry.subarray(0, 3).toString('hex'));
      const nodeOpId = BigInt('0x' + entry.subarray(3, 8).toString('hex'));
      const validatorIndex = BigInt('0x' + entry.subarray(8, 16).toString('hex'));
      const validatorPubkey = '0x' + entry.subarray(16, 64).toString('hex');

      entries.push({
        moduleId,
        nodeOpId,
        validatorIndex,
        validatorPubkey,
      });
    }

    return entries;
  }
}
