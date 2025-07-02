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
  private contractWithSigner: ethers.Contract;
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

      // Create a contract instance with signer for transactions
      const privateKey = this.config.get('TX_SIGNER_PRIVATE_KEY');
      // Convert comma-separated numbers to hex string if needed
      const formattedPrivateKey = privateKey.includes(',')
        ? '0x' +
          privateKey
            .split(',')
            .map((n) => parseInt(n).toString(16).padStart(2, '0'))
            .join('')
        : privateKey;

      const signer = new ethers.Wallet(formattedPrivateKey, this.execution.provider);
      this.contractWithSigner = this.contract.connect(signer);

      this.logger.log('VerifierContract initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize VerifierContract:', error.message);
      throw error;
    }
  }

  public async verifyValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.ContractTransaction> {
    try {
      await this.contractWithSigner.callStatic.verifyValidatorExitDelay(beaconBlock, validatorWitnesses, exitRequests);
      const tx = await this.contractWithSigner.verifyValidatorExitDelay(beaconBlock, validatorWitnesses, exitRequests);

      this.logger.debug(`Transaction sent: ${tx.hash}`);
      return tx;
    } catch (error) {
      this.logger.error('Error in verifyValidatorExitDelay:', error.reason || error.message);
      throw error;
    }
  }

  public async verifyHistoricalValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    oldBlock: HistoricalHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.ContractTransaction> {
    try {
      this.logger.debug('Calling verifyHistoricalValidatorExitDelay with:', {
        beaconBlock: {
          header: {
            slot: beaconBlock.header.slot,
            proposerIndex: beaconBlock.header.proposerIndex,
            parentRoot: beaconBlock.header.parentRoot,
            stateRoot: beaconBlock.header.stateRoot,
            bodyRoot: beaconBlock.header.bodyRoot,
          },
          rootsTimestamp: beaconBlock.rootsTimestamp,
        },
        oldBlock: {
          header: {
            slot: oldBlock.header.slot,
            proposerIndex: oldBlock.header.proposerIndex,
            parentRoot: oldBlock.header.parentRoot,
            stateRoot: oldBlock.header.stateRoot,
            bodyRoot: oldBlock.header.bodyRoot,
          },
          rootGIndex: oldBlock.rootGIndex,
          proofLength: oldBlock.proof.length,
          proof: oldBlock.proof,
        },
        validatorWitnessesCount: validatorWitnesses.length,
        exitRequestsDataFormat: exitRequests.dataFormat,
      });

      await this.contractWithSigner.callStatic.verifyHistoricalValidatorExitDelay(
        beaconBlock,
        oldBlock,
        validatorWitnesses,
        exitRequests,
      );
      const tx = await this.contractWithSigner.verifyHistoricalValidatorExitDelay(
        beaconBlock,
        oldBlock,
        validatorWitnesses,
        exitRequests,
      );

      this.logger.debug(`Transaction sent: ${tx.hash}`);
      return tx;
    } catch (error) {
      const data: string = error.data as string; // "0x5849603f…"
      if (data) {
        try {
          // parseError will match that 4-byte selector to one of the custom errors in your ABI
          const parsed = this.contract.parseError(data);
          this.logger.error('Contract reverted with:', parsed.name, parsed.args);
        } catch (parseErr) {
          this.logger.error('Unknown selector:', data.slice(0, 10));
        }
      }
      this.logger.error('Error in verifyHistoricalValidatorExitDelay:', error.reason || error.message);
      throw error;
    }
  }
}
