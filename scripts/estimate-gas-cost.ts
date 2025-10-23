#!/usr/bin/env ts-node

/**
 * Gas Cost Estimation Script
 * 
 * This script estimates the current gas costs for bot transactions on mainnet
 * without actually running the bot or sending any transactions.
 * 
 * Usage:
 *   yarn ts-node scripts/estimate-gas-cost.ts
 *   
 * Or with custom RPC:
 *   EL_RPC_URLS=https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY yarn ts-node scripts/estimate-gas-cost.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Constants from bot configuration
const BLOCKS_PER_HOUR = (60 * 60) / 12; // 300 blocks per hour (12s block time)
const HOURS_PER_DAY = 24;
const MAX_BLOCKCOUNT = 1024;

// Gas usage estimates based on Hoodi transaction data
const GAS_ESTIMATES = {
  TYPICAL_BATCH: 2_200_000,
  SMALL_BATCH: 1_500_000,
  LARGE_BATCH: 2_600_000,
};

interface GasAnalysis {
  currentBaseFee: bigint;
  currentBaseFeeGwei: string;
  historicalBaseFees: bigint[];
  recommendedBaseFee: bigint;
  recommendedBaseFeeGwei: string;
  percentile: number;
  historyDays: number;
  isGasAcceptable: boolean;
  estimatedCosts: {
    typical: {
      gasLimit: number;
      costGwei: string;
      costETH: string;
      costUSD: string;
    };
    small: {
      gasLimit: number;
      costGwei: string;
      costETH: string;
      costUSD: string;
    };
    large: {
      gasLimit: number;
      costGwei: string;
      costETH: string;
      costUSD: string;
    };
  };
}

class GasCostEstimator {
  private provider: ethers.providers.JsonRpcProvider;
  private ethPriceUSD: number = 2500; // Default, will fetch actual

  constructor(rpcUrl: string) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Fetch current ETH price from a price feed
   */
  private async fetchEthPrice(): Promise<number> {
    try {
      // Use a simple fetch to CoinGecko API (no API key needed for basic usage)
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
      const data = await response.json();
      return data.ethereum.usd;
    } catch (error) {
      console.warn('⚠️  Could not fetch ETH price, using default $2500');
      return 2500;
    }
  }

  /**
   * Fetch gas fee history from the blockchain
   */
  private async fetchGasFeeHistory(days: number): Promise<bigint[]> {
    const latestBlock = await this.provider.getBlock('latest');
    const latestBlockNumber = latestBlock.number;

    const totalBlocksToFetch = Math.floor(HOURS_PER_DAY * BLOCKS_PER_HOUR * days);
    const blockCountPerRequest = MAX_BLOCKCOUNT;

    console.log(`📊 Fetching ${totalBlocksToFetch} blocks of gas history (${days} days)...`);

    let allGasFees: bigint[] = [];
    let remainingBlocks = totalBlocksToFetch;
    let latestBlockToRequest = latestBlockNumber;

    while (remainingBlocks > 0) {
      const currentBatchSize = Math.min(remainingBlocks, blockCountPerRequest);
      
      const stats = await this.provider.send('eth_feeHistory', [
        `0x${currentBatchSize.toString(16)}`,
        `0x${latestBlockToRequest.toString(16)}`,
        []
      ]);

      // Parse baseFeePerGas
      const baseFees = stats.baseFeePerGas
        .slice(0, -1) // Remove extra block
        .map((fee: string) => BigInt(fee));

      allGasFees = [...baseFees, ...allGasFees];

      latestBlockToRequest -= currentBatchSize;
      remainingBlocks -= currentBatchSize;

      // Progress indicator
      const progress = ((totalBlocksToFetch - remainingBlocks) / totalBlocksToFetch * 100).toFixed(1);
      process.stdout.write(`\r   Progress: ${progress}%`);
    }

    console.log('\n   ✓ Gas history fetched successfully');
    return allGasFees;
  }

  /**
   * Calculate percentile of an array of bigints
   */
  private calculatePercentile(values: bigint[], percentile: number): bigint {
    const sorted = [...values].sort((a, b) => Number(a - b));
    const index = (percentile / 100) * (sorted.length - 1);
    
    if (Number.isInteger(index)) {
      return sorted[index];
    } else {
      const lower = sorted[Math.floor(index)];
      const upper = sorted[Math.ceil(index)];
      return (lower + upper) / 2n;
    }
  }

  /**
   * Format bigint gwei to readable string
   */
  private formatGwei(wei: bigint): string {
    return ethers.utils.formatUnits(wei, 'gwei');
  }

  /**
   * Calculate transaction cost
   */
  private calculateCost(gasLimit: number, baseFeePerGas: bigint): {
    costGwei: string;
    costETH: string;
    costUSD: string;
  } {
    const totalWei = BigInt(gasLimit) * baseFeePerGas;
    const totalGwei = Number(totalWei) / 1e9;
    const totalETH = ethers.utils.formatEther(totalWei);
    const totalUSD = (parseFloat(totalETH) * this.ethPriceUSD).toFixed(2);

    return {
      costGwei: totalGwei.toLocaleString(),
      costETH: parseFloat(totalETH).toFixed(6),
      costUSD: `$${totalUSD}`,
    };
  }

  /**
   * Run complete gas analysis
   */
  async analyze(): Promise<GasAnalysis> {
    console.log('🔍 Starting gas cost analysis...\n');

    // Fetch ETH price
    console.log('💰 Fetching current ETH price...');
    this.ethPriceUSD = await this.fetchEthPrice();
    console.log(`   ETH Price: $${this.ethPriceUSD.toFixed(2)}\n`);

    // Get configuration
    const historyDays = parseInt(process.env.TX_GAS_FEE_HISTORY_DAYS || '1');
    const percentile = parseInt(process.env.TX_GAS_FEE_HISTORY_PERCENTILE || '10');

    console.log('⚙️  Configuration:');
    console.log(`   History Days: ${historyDays}`);
    console.log(`   Percentile: ${percentile}\n`);

    // Fetch current base fee
    console.log('📡 Fetching current base fee...');
    const pendingBlock = await this.provider.getBlock('pending');
    const currentBaseFee = pendingBlock.baseFeePerGas?.toBigInt() ?? 0n;
    console.log(`   Current: ${this.formatGwei(currentBaseFee)} Gwei\n`);

    // Fetch historical data
    const historicalBaseFees = await this.fetchGasFeeHistory(historyDays);

    // Calculate recommended base fee
    console.log('\n📈 Analyzing historical data...');
    const recommendedBaseFee = this.calculatePercentile(historicalBaseFees, percentile);
    console.log(`   Recommended (${percentile}th percentile): ${this.formatGwei(recommendedBaseFee)} Gwei`);

    // Determine if current gas is acceptable
    const isGasAcceptable = currentBaseFee <= recommendedBaseFee;
    console.log(`   Status: ${isGasAcceptable ? '✅ ACCEPTABLE' : '⚠️  HIGH'}\n`);

    // Calculate estimated costs
    console.log('💵 Estimated Transaction Costs:\n');

    const estimates = {
      typical: this.calculateCost(GAS_ESTIMATES.TYPICAL_BATCH, currentBaseFee),
      small: this.calculateCost(GAS_ESTIMATES.SMALL_BATCH, currentBaseFee),
      large: this.calculateCost(GAS_ESTIMATES.LARGE_BATCH, currentBaseFee),
    };

    // Display results
    console.log('   Small Batch (~1.5M gas):');
    console.log(`     Gas Cost: ${estimates.small.costGwei} Gwei`);
    console.log(`     ETH Cost: ${estimates.small.costETH} ETH`);
    console.log(`     USD Cost: ${estimates.small.costUSD}\n`);

    console.log('   Typical Batch (~2.2M gas):');
    console.log(`     Gas Cost: ${estimates.typical.costGwei} Gwei`);
    console.log(`     ETH Cost: ${estimates.typical.costETH} ETH`);
    console.log(`     USD Cost: ${estimates.typical.costUSD}\n`);

    console.log('   Large Batch (~2.6M gas):');
    console.log(`     Gas Cost: ${estimates.large.costGwei} Gwei`);
    console.log(`     ETH Cost: ${estimates.large.costETH} ETH`);
    console.log(`     USD Cost: ${estimates.large.costUSD}\n`);

    // Statistics
    const minFee = historicalBaseFees.reduce((a, b) => a < b ? a : b);
    const maxFee = historicalBaseFees.reduce((a, b) => a > b ? a : b);
    const avgFee = historicalBaseFees.reduce((a, b) => a + b, 0n) / BigInt(historicalBaseFees.length);

    console.log(`📊 Historical Statistics (Last ${historyDays} day(s)):`);
    console.log(`   Minimum: ${this.formatGwei(minFee)} Gwei`);
    console.log(`   Average: ${this.formatGwei(avgFee)} Gwei`);
    console.log(`   Maximum: ${this.formatGwei(maxFee)} Gwei`);
    console.log(`   ${percentile}th Percentile: ${this.formatGwei(recommendedBaseFee)} Gwei\n`);

    // Decision
    if (isGasAcceptable) {
      console.log('✅ DECISION: Current gas fees are acceptable. Bot would send transactions now.');
    } else {
      const diff = currentBaseFee - recommendedBaseFee;
      const diffPercent = (Number(diff) / Number(recommendedBaseFee) * 100).toFixed(1);
      console.log(`⚠️  DECISION: Current gas fees are ${diffPercent}% higher than recommended.`);
      console.log('   Bot would skip transactions and wait for lower gas.\n');
    }

    return {
      currentBaseFee,
      currentBaseFeeGwei: this.formatGwei(currentBaseFee),
      historicalBaseFees,
      recommendedBaseFee,
      recommendedBaseFeeGwei: this.formatGwei(recommendedBaseFee),
      percentile,
      historyDays,
      isGasAcceptable,
      estimatedCosts: {
        typical: { gasLimit: GAS_ESTIMATES.TYPICAL_BATCH, ...estimates.typical },
        small: { gasLimit: GAS_ESTIMATES.SMALL_BATCH, ...estimates.small },
        large: { gasLimit: GAS_ESTIMATES.LARGE_BATCH, ...estimates.large },
      },
    };
  }
}

// Main execution
async function main() {
  const rpcUrl = process.env.EL_RPC_URLS?.split(',')[0] || 'https://eth.llamarpc.com';
  
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     Late Proof Verifier - Gas Cost Estimator          ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`🌐 Using RPC: ${rpcUrl}\n`);

  try {
    const estimator = new GasCostEstimator(rpcUrl);
    await estimator.analyze();
    
    console.log('════════════════════════════════════════════════════════\n');
    console.log('✨ Analysis complete!\n');
  } catch (error) {
    console.error('\n❌ Error during analysis:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { GasCostEstimator, GasAnalysis };

