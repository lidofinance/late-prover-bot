import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { join } from 'path';
import { Execution } from '../providers/execution/execution';
import { LidoLocatorContract } from './lido-locator.service';
import { NodeOperatorsRegistryContract } from './nor.service';
import { PrometheusService } from '../prometheus/prometheus.service';

export interface StakingModule {
  id: number;
  stakingModuleAddress: string;
  stakingModuleFee: number;
  treasuryFee: number;
  targetShare: number;
  status: number;
  name: string;
  lastDepositAt: number;
  lastDepositBlock: number;
  exitedValidatorsCount: number;
}

export interface NodeOperatorSummary {
  isTargetLimitActive: boolean;
  targetValidatorsCount: number;
  stuckValidatorsCount: number;
  refundedValidatorsCount: number;
  stuckPenaltyEndTimestamp: number;
  totalExitedValidators: number;
  totalDepositedValidators: number;
  depositsCount: number;
}

@Injectable()
export class StakingRouterContract implements OnModuleInit {
  private contract: ethers.Contract;
  private readonly logger = new Logger(StakingRouterContract.name);
  private stakingRouterAddress: string;
  private stakingModuleContracts: Map<number, NodeOperatorsRegistryContract> = new Map();

  constructor(
    protected readonly execution: Execution,
    protected readonly lidoLocator: LidoLocatorContract,
    protected readonly prometheus: PrometheusService,
  ) { }

  async onModuleInit(): Promise<void> {
    try {
      // Get StakingRouter address from LidoLocator
      this.stakingRouterAddress = await this.lidoLocator.getStakingRouter();
      this.logger.log(`StakingRouter address from LidoLocator: ${this.stakingRouterAddress}`);

      const contractJson = require(join(process.cwd(), 'src', 'common', 'contracts', 'abi', 'staking-router.json'));
      const iface = new ethers.utils.Interface(contractJson);

      this.contract = new ethers.Contract(
        this.stakingRouterAddress,
        iface,
        this.execution.provider,
      );

      this.logger.log('StakingRouter contract initialized successfully');

      // Load staking module contracts automatically
      await this.loadStakingModuleContracts();
      this.logger.log('StakingRouter module initialization completed');
    } catch (error) {
      this.logger.error('Failed to initialize StakingRouterContract:', error.message);
      throw error;
    }
  }

  public async getStakingModules(): Promise<StakingModule[]> {
    try {
      const modules = await this.contract.getStakingModules();
      
      const results: StakingModule[] = modules.map((module: any) => ({
        id: module.id,
        stakingModuleAddress: module.stakingModuleAddress,
        name: module.name,
      }));

      this.prometheus.stakingModuleOperationsCount.inc({
        module_id: 'all',
        operation_type: 'getStakingModules',
        status: 'success'
      });

      this.logger.debug(`Successfully loaded ${results.length} staking modules`);
      return results;

    } catch (error) {
      this.prometheus.stakingModuleOperationsCount.inc({
        module_id: 'all',
        operation_type: 'getStakingModules',
        status: 'error'
      });
      
      this.logger.error('Failed to get staking modules:', error);
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