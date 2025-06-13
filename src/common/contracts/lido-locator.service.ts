import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { join } from 'path';

@Injectable()
export class LidoLocatorContract {
  private contract: ethers.Contract;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    // Import the full ABI JSON
    const contractJson = require(join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'lido-locator.json'));
    
    // Create interface from the ABI
    const iface = new ethers.utils.Interface(contractJson);
    
    this.contract = new ethers.Contract(
      this.config.get('LIDO_LOCATOR_ADDRESS'),
      iface,
      this.execution.provider,
    );
  }

  public async getValidatorsExitBusOracle(): Promise<string> {
    return await this.contract.validatorsExitBusOracle();
  }

  public async getValidatorExitDelayVerifier(): Promise<string> {
    return await this.contract.validatorExitDelayVerifier();
  }

  public async getLido(): Promise<string> {
    return await this.contract.lido();
  }

  public async getStakingRouter(): Promise<string> {
    return await this.contract.stakingRouter();
  }

  public async getNodeOperatorsRegistry(): Promise<string> {
    return await this.contract.nodeOperatorsRegistry();
  }

  public async getWithdrawalQueue(): Promise<string> {
    return await this.contract.withdrawalQueue();
  }

  public async getWithdrawalVault(): Promise<string> {
    return await this.contract.withdrawalVault();
  }

  public async getELRewardsVault(): Promise<string> {
    return await this.contract.elRewardsVault();
  }

  public async getLegacyOracle(): Promise<string> {
    return await this.contract.legacyOracle();
  }

  public async getPostTokenRebaseReceiver(): Promise<string> {
    return await this.contract.postTokenRebaseReceiver();
  }

  public async getOracleReportSanityChecker(): Promise<string> {
    return await this.contract.oracleReportSanityChecker();
  }

  public async getBurner(): Promise<string> {
    return await this.contract.burner();
  }

  public async getTreasury(): Promise<string> {
    return await this.contract.treasury();
  }

  public async getStakingRouterConfig(): Promise<string> {
    return await this.contract.stakingRouterConfig();
  }

  public async getWithdrawalQueueConfig(): Promise<string> {
    return await this.contract.withdrawalQueueConfig();
  }

  public async getWithdrawalVaultConfig(): Promise<string> {
    return await this.contract.withdrawalVaultConfig();
  }

  public async getELRewardsVaultConfig(): Promise<string> {
    return await this.contract.elRewardsVaultConfig();
  }

  public async getLegacyOracleConfig(): Promise<string> {
    return await this.contract.legacyOracleConfig();
  }

  public async getPostTokenRebaseReceiverConfig(): Promise<string> {
    return await this.contract.postTokenRebaseReceiverConfig();
  }

  public async getOracleReportSanityCheckerConfig(): Promise<string> {
    return await this.contract.oracleReportSanityCheckerConfig();
  }

  public async getBurnerConfig(): Promise<string> {
    return await this.contract.burnerConfig();
  }

  public async getTreasuryConfig(): Promise<string> {
    return await this.contract.treasuryConfig();
  }
} 