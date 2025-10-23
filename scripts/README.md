# Gas Cost Estimation Script

This script estimates current gas costs for bot transactions on Ethereum mainnet without running the actual bot.

## Features

- ✅ Fetches current mainnet base fee
- ✅ Analyzes historical gas fee data (configurable days)
- ✅ Calculates recommended gas fee using percentile
- ✅ Estimates transaction costs in Gwei, ETH, and USD
- ✅ Shows whether bot would send transactions at current gas prices
- ✅ Provides detailed statistics (min, max, avg, percentile)
- ✅ Uses real ETH/USD price from CoinGecko

## Usage

### Basic Usage (Uses default RPC)

```bash
yarn estimate-gas
```

### With Custom RPC

```bash
EL_RPC_URLS=https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY yarn estimate-gas
```

### With Custom Configuration

```bash
# Use 3 days of history and 75th percentile
TX_GAS_FEE_HISTORY_DAYS=3 TX_GAS_FEE_HISTORY_PERCENTILE=75 yarn estimate-gas
```

## Configuration

The script respects the same environment variables as the bot:

| Variable | Description | Default |
|----------|-------------|---------|
| `EL_RPC_URLS` | Ethereum RPC endpoint(s) | `https://eth.llamarpc.com` |
| `TX_GAS_FEE_HISTORY_DAYS` | Days of history to analyze | `1` |
| `TX_GAS_FEE_HISTORY_PERCENTILE` | Percentile for "recommended" gas | `50` |

## Example Output

```
╔════════════════════════════════════════════════════════╗
║     Late Proof Verifier - Gas Cost Estimator          ║
╚════════════════════════════════════════════════════════╝

🌐 Using RPC: https://eth.llamarpc.com

🔍 Starting gas cost analysis...

💰 Fetching current ETH price...
   ETH Price: $2,485.50

⚙️  Configuration:
   History Days: 1
   Percentile: 50

📡 Fetching current base fee...
   Current: 25.3 Gwei

📊 Fetching 7200 blocks of gas history (1 days)...
   Progress: 100.0%
   ✓ Gas history fetched successfully

📈 Analyzing historical data...
   Recommended (50th percentile): 28.5 Gwei
   Status: ✅ ACCEPTABLE

💵 Estimated Transaction Costs:

   Small Batch (~1.5M gas):
     Gas Cost: 37,950,000 Gwei
     ETH Cost: 0.037950 ETH
     USD Cost: $94.32

   Typical Batch (~2.2M gas):
     Gas Cost: 55,660,000 Gwei
     ETH Cost: 0.055660 ETH
     USD Cost: $138.35

   Large Batch (~2.6M gas):
     Gas Cost: 65,780,000 Gwei
     ETH Cost: 0.065780 ETH
     USD Cost: $163.51

📊 Historical Statistics (Last 1 day(s)):
   Minimum: 18.2 Gwei
   Average: 26.8 Gwei
   Maximum: 42.3 Gwei
   50th Percentile: 28.5 Gwei

✅ DECISION: Current gas fees are acceptable. Bot would send transactions now.

════════════════════════════════════════════════════════

✨ Analysis complete!
```

## Gas Estimates Used

The script uses gas estimates based on actual Holesky transaction data:

- **Small Batch**: ~1.5M gas (fewer validators)
- **Typical Batch**: ~2.2M gas (normal batch size)
- **Large Batch**: ~2.6M gas (maximum batch size)

Based on your Holesky transaction:
- Gas Used: 2,153,904
- Gas Limit: 2,606,599

## Understanding the Output

### Current vs Recommended

- **Current**: The base fee in the pending block right now
- **Recommended**: The Nth percentile of historical base fees
- If current ≤ recommended → Bot would send ✅
- If current > recommended → Bot would skip ⚠️

### Percentile Settings

- **25th percentile**: More conservative (bot waits for very low gas)
- **50th percentile**: Balanced (median gas)
- **75th percentile**: More aggressive (bot sends more often)

### Cost Breakdown

Each estimate shows:
1. **Gas Cost (Gwei)**: Total gas units × base fee
2. **ETH Cost**: Cost in Ether
3. **USD Cost**: Cost in dollars (using live ETH price)

## When to Run This Script

Run this script to:
- ✅ Check current gas market conditions
- ✅ Estimate costs before starting the bot
- ✅ Decide if it's a good time to send transactions
- ✅ Understand how much you'll spend on gas
- ✅ Test different percentile configurations
- ✅ Monitor gas trends over time

## Troubleshooting

### "Could not fetch ETH price"
The script will use a default of $2,500 if it can't reach CoinGecko. This doesn't affect gas analysis, only USD estimates.

### "Error during analysis"
Check your RPC endpoint is accessible and supports `eth_feeHistory`.

### Slow execution
Fetching historical data can take 10-30 seconds depending on the number of days configured and RPC speed.

## Integration with Bot

The script uses the **exact same logic** as the bot for:
- Fetching gas fee history
- Calculating percentiles  
- Determining if gas is acceptable

This means the script's "DECISION" perfectly matches what the bot would do.

## Technical Details

### Data Source
- **Current Gas**: Fetched from `pending` block
- **Historical Gas**: Fetched using `eth_feeHistory` RPC method
- **ETH Price**: CoinGecko API (free tier, no auth)

### Calculation Method
```typescript
1. Fetch last N days of baseFeePerGas values
2. Calculate Pth percentile of historical fees
3. Compare: current <= percentile ? accept : reject
4. Estimate: gasLimit × baseFeePerGas = cost
```

This matches your Python bot:
```python
numpy.percentile(gas_history, PERCENTILE)
```

## See Also

- [Main README](../README.md) - Bot configuration and setup
- [Environment Variables](../README.md#environment-variables) - All config options

