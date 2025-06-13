import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { ExitRequestsData, ProvableBeaconBlockHeader, ValidatorWitness } from './types';
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
      this.logger.debug('Preparing verifyValidatorExitDelay transaction with:');
      this.logger.debug(`BeaconBlock: ${JSON.stringify(beaconBlock, null, 2)}`);
      this.logger.debug(`ValidatorWitnesses count: ${validatorWitnesses.length}`);
      this.logger.debug(`ExitRequests: ${JSON.stringify(exitRequests, null, 2)}`);

      const tx = await this.contractWithSigner.verifyValidatorExitDelay(
        beaconBlock,
        validatorWitnesses,
        exitRequests
      );

      this.logger.debug(`Transaction sent: ${tx.hash}`);
      return tx;
    } catch (error) {
      this.logger.error('Error in verifyValidatorExitDelay:', JSON.stringify({
        error: error.message,
        stack: error.stack,
        code: error.code,
        data: error.data,
        transaction: error.transaction,
        beaconBlock,
        validatorWitnessesCount: validatorWitnesses.length,
        exitRequests
      }));
      throw error;
    }
  }
}
