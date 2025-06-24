import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { ExitRequestsData, ProvableBeaconBlockHeader, ValidatorWitness, HistoricalHeaderWitness } from './types';
import { join } from 'path';

@Injectable()
export class VerifierContract {
  private contract: ethers.Contract;
  private contractWithSigner: ethers.Contract;
  private readonly logger = new Logger(VerifierContract.name);

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    // Import the full ABI JSON
    const contractJson = require(join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'validator-exit-delay-verifier.json'));

    // Create interface from the ABI
    const iface = new ethers.utils.Interface(contractJson);

    this.contract = new ethers.Contract(
      this.config.get('VERIFIER_ADDRESS'),
      iface,
      this.execution.provider,
    );

    // Create a contract instance with signer for transactions
    const privateKey = this.config.get('TX_SIGNER_PRIVATE_KEY');
    // Convert comma-separated numbers to hex string if needed
    const formattedPrivateKey = privateKey.includes(',')
      ? '0x' + privateKey.split(',').map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
      : privateKey;

    const signer = new ethers.Wallet(
      formattedPrivateKey,
      this.execution.provider
    );
    this.contractWithSigner = this.contract.connect(signer);
  }

  public async verifyValidatorExitDelay(
    beaconBlock: ProvableBeaconBlockHeader,
    validatorWitnesses: ValidatorWitness[],
    exitRequests: ExitRequestsData
  ): Promise<ethers.ContractTransaction> {
    try {
      await this.contractWithSigner.callStatic.verifyValidatorExitDelay(
        beaconBlock,
        validatorWitnesses,
        exitRequests
      );
      const tx = await this.contractWithSigner.verifyValidatorExitDelay(
        beaconBlock,
        validatorWitnesses,
        exitRequests
      );

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
    exitRequests: ExitRequestsData
  ): Promise<ethers.ContractTransaction> {
    try {
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
      const data: string = error.data as string;  // "0x5849603f…"
      try {
        // parseError will match that 4-byte selector to one of the custom errors in your ABI
        const parsed = this.contract.parseError(data);
        this.logger.error("Contract reverted with:", parsed.name, parsed.args);
      } catch (parseErr) {
        this.logger.error("Unknown selector:", data.slice(0, 10));
      }
      this.logger.error('Error in verifyHistoricalValidatorExitDelay:', error.reason || error.message);
      throw error;
    }
  }
}
