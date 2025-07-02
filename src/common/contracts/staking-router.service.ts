import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { join } from 'path';

import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { LidoLocatorContract } from './lido-locator.service';
import { NodeOperatorsRegistryContract } from './nor.service';
import { StakingModule, StakingModuleContractWrapper } from './types';

@Injectable()
export class StakingRouterContract implements OnModuleInit {
  private contract: ethers.Contract;
  private readonly logger = new Logger(StakingRouterContract.name);
  private stakingRouterAddress: string;
  private stakingModuleContracts: Map<number, NodeOperatorsRegistryContract> = new Map();

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly lidoLocator: LidoLocatorContract,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Get StakingRouter address from LidoLocator
      this.stakingRouterAddress = await this.lidoLocator.getStakingRouter();
      this.logger.log(`StakingRouter address from LidoLocator: ${this.stakingRouterAddress}`);

      // Import the full ABI JSON
      const contractJson = require(join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'staking-router.json'));

      // Create interface from the ABI
      const iface = new ethers.utils.Interface(contractJson);

      this.contract = new ethers.Contract(this.stakingRouterAddress, iface, this.execution.provider);

      this.logger.log('StakingRouter contract initialized successfully');

      // Load staking module contracts automatically
      await this.loadStakingModuleContracts();
      this.logger.log('StakingRouter module initialization completed');
    } catch (error) {
      this.logger.error('Failed to initialize StakingRouter contract:', error.message);
      throw error;
    }
  }

  private async ensureContract(): Promise<void> {
    if (!this.contract) {
      const address = await this.lidoLocator.getStakingRouter();
      
      const abi = [
        'function getStakingModules() view returns (tuple(uint24 id, address stakingModuleAddress, uint16 stakingModuleFee, uint16 treasuryFee, uint16 targetShare, uint8 status, string name, uint64 lastDepositAt, uint256 lastDepositBlock, uint256 exitedValidatorsCount, uint256 totalValidatorsCount, uint256 totalDepositedValidators, uint256 totalDepositsValue)[])',
      ];

      this.contract = new ethers.Contract(address, abi, this.execution.provider);
      this.logger.log(`StakingRouter contract initialized at ${address}`);
    }
  }

  /**
   * Get all staking modules from the StakingRouter contract
   * @returns Array of staking modules with their details
   */
  public async getStakingModules(): Promise<StakingModule[]> {
    try {
      await this.ensureContract();
      
      const result = await this.contract.getStakingModules();
      
      const stakingModules: StakingModule[] = result.map((module: any) => ({
        id: module.id,
        stakingModuleAddress: module.stakingModuleAddress,
        name: module.name,
      }));

      this.logger.log(`Retrieved ${stakingModules.length} staking modules`);
      return stakingModules;
    } catch (error) {
      this.logger.error('Failed to get staking modules', error);
      throw error;
    }
  }

  /**
   * Load staking module contracts and save them in a map
   * Each contract implements the NOR ABI as NodeOperatorsRegistryContract instances
   * @returns Map of staking module ID to NodeOperatorsRegistryContract instance
   */
  public async loadStakingModuleContracts(): Promise<Map<number, NodeOperatorsRegistryContract>> {
    try {
      const stakingModules = await this.getStakingModules();
      
      // Clear existing contracts
      this.stakingModuleContracts.clear();

      // Create NodeOperatorsRegistryContract instances for each staking module
      for (const module of stakingModules) {
        const norContract = new NodeOperatorsRegistryContract(
          module.stakingModuleAddress,
          this.execution,
        );
        
        this.stakingModuleContracts.set(module.id, norContract);
        this.logger.log(`Loaded staking module contract ${module.id} (${module.name}) at ${module.stakingModuleAddress}`);
      }

      this.logger.log(`Loaded ${this.stakingModuleContracts.size} staking module contracts`);
      return this.stakingModuleContracts;
    } catch (error) {
      this.logger.error('Failed to load staking module contracts', error);
      throw error;
    }
  }

  /**
   * Get a specific staking module contract by ID
   * @param moduleId The staking module ID
   * @returns The NodeOperatorsRegistryContract instance or undefined if not found
   */
  public getStakingModuleContract(moduleId: number): NodeOperatorsRegistryContract | undefined {
    return this.stakingModuleContracts.get(moduleId);
  }
} 