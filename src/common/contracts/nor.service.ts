import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';

import { Execution } from '../providers/execution/execution';

@Injectable()
export class NodeOperatorsRegistryContract {
  private contract: ethers.Contract;

  constructor(
    protected readonly address: string,
    protected readonly execution: Execution,
  ) {
    const abi = [
      'function isValidatorExitDelayPenaltyApplicable(uint256,uint256,bytes,uint256) view returns (bool)',
      'function exitDeadlineThreshold(uint256) view returns (uint256)',
    ];

    this.contract = new ethers.Contract(address, abi, this.execution.provider);
  }

  /**
   * Check if validator exit delay penalty is applicable
   * @param nodeOperatorId The ID of the node operator
   * @param proofSlotTimestamp The timestamp of the proof slot
   * @param publicKey The validator's public key
   * @param eligibleToExitInSec The time in seconds when the validator is eligible to exit
   * @param overrides Optional overrides for the contract call
   * @returns boolean indicating if penalty is applicable
   */
  public async isValidatorExitDelayPenaltyApplicable(
    nodeOperatorId: number,
    proofSlotTimestamp: number,
    publicKey: string,
    eligibleToExitInSec: number,
    overrides: ethers.CallOverrides = {},
  ): Promise<boolean> {
    return await this.contract.isValidatorExitDelayPenaltyApplicable(
      nodeOperatorId,
      proofSlotTimestamp,
      publicKey,
      eligibleToExitInSec,
      overrides,
    );
  }

  /**
   * Get the exit deadline threshold for a node operator
   * @param nodeOperatorId The ID of the node operator
   * @returns The exit deadline threshold in seconds
   */
  public async exitDeadlineThreshold(nodeOperatorId: number): Promise<number> {
    const threshold = await this.contract.exitDeadlineThreshold(nodeOperatorId);
    return threshold.toNumber();
  }
}
