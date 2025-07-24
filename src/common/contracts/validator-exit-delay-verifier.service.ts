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
  ): Promise<ethers.ContractTransaction> {
    return this.executeContractCall('verifyValidatorExitDelay', [beaconBlock, validatorWitnesses, exitRequests]);
  }

  public async populateVerifyValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.PopulatedTransaction> {
    return await this.contractWithSigner.populateTransaction.verifyValidatorExitDelay(
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
  ): Promise<ethers.ContractTransaction> {
    return this.executeContractCall('verifyHistoricalValidatorExitDelay', [beaconBlock, oldBlock, validatorWitnesses, exitRequests]);
  }

  public async populateVerifyHistoricalValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    oldBlock: HistoricalHeaderWitness,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData,
  ): Promise<ethers.PopulatedTransaction> {
    return await this.contractWithSigner.populateTransaction.verifyHistoricalValidatorExitDelay(
      beaconBlock,
      oldBlock,
      validatorWitnesses,
      exitRequests
    );
  }

  /**
   * Get the gas limit from configuration or use a default
   */
  private getGasLimit(): number {
    return this.config.get('TX_GAS_LIMIT') || 1_000_000;
  }

  /**
   * Get the gas multiplier for retry attempts
   */
  private getGasMultiplier(): number {
    return this.config.get('TX_GAS_MULTIPLIER') || 2;
  }

  /**
   * Check if gas estimation should be skipped
   */
  private shouldSkipGasEstimation(): boolean {
    return this.config.get('TX_SKIP_GAS_ESTIMATION') || false;
  }

  /**
   * Execute contract call with proper gas handling
   */
  private async executeContractCall<T extends any[]>(
    methodName: string,
    args: T,
    context?: Record<string, any>
  ): Promise<ethers.ContractTransaction> {
    const skipGasEstimation = this.shouldSkipGasEstimation();
    let estimatedGas: ethers.BigNumber | null = null;
    
    if (!skipGasEstimation) {
      try {
        // First, try to simulate the transaction with callStatic
        await this.contractWithSigner.callStatic[methodName](...args);
        
        // If static call succeeds, try to estimate gas
        try {
          estimatedGas = await this.contractWithSigner.estimateGas[methodName](...args);
          this.logger.log(`Gas estimation for ${methodName}: ${estimatedGas.toString()}`);
        } catch (gasEstimateError) {
          this.logger.warn(`Gas estimation failed for ${methodName}, using configured limit:`, gasEstimateError.message);
        }
      } catch (staticError) {
        this.logger.warn(`Static call failed for ${methodName}:`, this.serializeError(staticError));
        // Continue with transaction attempt even if static call fails
      }
    }

    // Choose gas limit: use estimation + buffer, or configured limit, whichever is higher
    let gasLimit = this.getGasLimit();
    if (estimatedGas) {
      const estimatedWithBuffer = estimatedGas.mul(120).div(100); // Add 20% buffer
      if (estimatedWithBuffer.gt(gasLimit)) {
        gasLimit = estimatedWithBuffer.toNumber();
        this.logger.log(`Using estimated gas with buffer: ${gasLimit} (estimated: ${estimatedGas.toString()})`);
      }
    }

    try {
      // Execute the transaction with calculated gas limit
      const tx = await this.contractWithSigner[methodName](...args, {
        gasLimit: gasLimit
      });

      this.logger.debug(`Transaction sent: ${tx.hash} (method: ${methodName}, gas: ${gasLimit})`);
      return tx;
    } catch (error) {
      // Enhanced error handling for different error types
      if (error.code === 'UNPREDICTABLE_GAS_LIMIT' || error.message?.includes('intrinsic gas too low')) {
        const currentGas = gasLimit;
        const neededGas = this.extractNeededGas(error.message) || Math.floor(currentGas * this.getGasMultiplier());
        
        this.logger.error(`Gas limit too low for ${methodName}:`, {
          error: error.message,
          currentGas,
          neededGas,
          context,
          skipGasEstimation
        });
        
        // Try with a higher gas limit
        try {
          const higherGasLimit = Math.max(neededGas, Math.floor(currentGas * this.getGasMultiplier()));
          const tx = await this.contractWithSigner[methodName](...args, {
            gasLimit: higherGasLimit
          });
          this.logger.warn(`Transaction succeeded with increased gas limit for ${methodName}: ${higherGasLimit}`);
          return tx;
        } catch (secondError) {
          this.logger.error(`Transaction failed even with increased gas limit for ${methodName}`, this.serializeError(secondError));
          throw new Error(`Contract call would revert or needs more gas: ${secondError.reason || secondError.message}`);
        }
      }
      
      // Parse contract revert errors if available
      if (error.data) {
        try {
          const parsed = this.contract.parseError(error.data);
          this.logger.error(`Contract reverted with custom error for ${methodName}:`, {
            name: parsed.name,
            args: parsed.args
          });
          throw new Error(`Contract revert: ${parsed.name} - ${JSON.stringify(parsed.args)}`);
        } catch (parseErr) {
          this.logger.error(`Contract reverted with unknown error for ${methodName}:`, {
            selector: error.data.slice(0, 10),
            data: error.data
          });
        }
      }
      
      this.logger.error(`Error in ${methodName}:`, this.serializeError(error));
      throw error;
    }
  }

  /**
   * Extract needed gas amount from error message
   */
  private extractNeededGas(errorMessage: string): number | null {
    if (!errorMessage) return null;
    
    // Look for patterns like "minimum needed 1588836" or "gas needed: 1588836"
    const patterns = [
      /minimum needed (\d+)/i,
      /gas needed:?\s*(\d+)/i,
      /required:?\s*(\d+)/i
    ];
    
    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    }
    
    return null;
  }

  /**
   * Serialize error objects for better logging
   */
  private serializeError(err: unknown): string {
    if (err instanceof Error) {
      return JSON.stringify(
        {
          name: err.name,
          message: err.message,
          code: (err as any).code,
          reason: (err as any).reason,
          data: (err as any).data,
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
}
