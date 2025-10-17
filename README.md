# Late Proof Verifier Bot

## Description

**Tool for generating proofs for delayed validator exits** in the Lido ecosystem. This bot monitors validator exit requests and generates cryptographic proofs when validators fail to exit by their required deadline, enabling penalty enforcement on node operators.

## Overview

The Late Proof Verifier Bot is a critical component of Lido's validator exit delay monitoring system. It:

- **Monitors beacon chain** for validator exit requests
- **Detects delayed exits** when validators haven't exited by their deadline
- **Generates proofs** using Merkle tree cryptography for delayed validator exits
- **Submits verification** to the ValidatorExitDelayVerifier contract
- **Enables penalty enforcement** on node operators whose validators are delayed

## How It Works

### Daemon Mode (Default)

The bot runs as a daemon that continuously processes beacon chain roots:

<details>
  <summary>The algorithm is as follows</summary>

1. **Get finalized beacon chain root**
   - Fetches the latest finalized beacon chain header
   - Determines the previous root to process (from storage, START_ROOT, or parent root)

2. **Process block range**
   - Processes execution layer blocks between previous and current beacon chain roots
   - Discovers validator exit requests from ValidatorsExitBusOracle events

3. **Group validators by deadline**
   - Analyzes exit requests and groups validators by their exit deadline slots
   - Calculates when each validator should have exited based on activation time

4. **Generate proofs for delayed exits**
   - For each validator past its deadline, generates a Merkle proof of its current state
   - Supports both current slot verification and historical slot verification using historical summaries

5. **Submit to verifier contract**
   - Calls `verifyValidatorExitDelay()` or `verifyHistoricalValidatorExitDelay()`
   - Enables penalty application on node operators with delayed validators

6. **Store progress and repeat**
   - Saves the last processed root to storage
   - Sleeps for configured interval (default 5 minutes) and repeats the process

**Key Features:**
- **Sequential processing**: Processes beacon chain roots sequentially to avoid missing blocks
- **Crash recovery**: Resumes from the last processed root after restart
- **Historical verification**: Can generate proofs for older slots using historical summaries
- **Batch processing**: Efficiently handles multiple validators per transaction
- **Comprehensive monitoring**: Tracks processing via Prometheus metrics

</details>

## Getting Started

### Prerequisites

- Node.js 16+
- Access to Ethereum execution layer RPC
- Access to Ethereum consensus layer API
- Private key for transaction signing (if not in dry-run mode)

### Installation

1. **Clone and install dependencies**
   ```bash
   git clone https://github.com/lidofinance/late-prover-bot.git
   cd late-prover-bot
   yarn install
   ```

2. **Generate contract types**
   ```bash
   yarn run typechain
   ```

3. **Build the project**
   ```bash
   yarn build
   ```

### Configuration

1. **Create environment file**
   ```bash
   cp .env.example .env
   ```

2. **Fill in the required variables** (see Environment Variables section below)

### Running the Bot

#### Using Docker Compose (Recommended)

```bash
# Start daemon with monitoring stack
docker-compose up -d daemon prometheus

# View logs
docker-compose logs -f daemon

# Access metrics
curl http://localhost:8081/metrics
```

#### Using Yarn

```bash
# Development mode
NODE_OPTIONS=--max-old-space-size=8192 yarn run start:dev

# Production mode
yarn run start:prod
```

## Environment Variables

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| **Core Settings** | | | |
| `WORKING_MODE` | Working mode: `daemon` | no | `daemon` |
| `HTTP_PORT` | Port for HTTP server (health/metrics) | no | `8080` |
| `DRY_RUN` | Dry run mode (no transactions) | no | `false` |
| `DAEMON_SLEEP_INTERVAL_MS` | Sleep interval between daemon cycles (milliseconds) | no | `300000` (5 minutes) |
| `CHAIN_ID` | Ethereum chain ID (1=mainnet, 5=goerli, 17000=holesky) | yes | |
| **Blockchain Connection** | | | |
| `EL_RPC_URLS` | Comma-separated execution layer RPC URLs | yes | |
| `EL_RPC_RETRY_DELAY_MS` | Delay between EL RPC retries | no | `500` |
| `EL_RPC_RESPONSE_TIMEOUT_MS` | EL RPC response timeout | no | `60000` |
| `EL_RPC_MAX_RETRIES` | Maximum EL RPC retries | no | `3` |
| `CL_API_URLS` | Comma-separated consensus layer API URLs | yes | |
| `CL_API_RETRY_DELAY_MS` | Delay between CL API retries | no | `500` |
| `CL_API_RESPONSE_TIMEOUT_MS` | CL API response timeout | no | `60000` |
| `CL_API_MAX_RETRIES` | Maximum CL API retries | no | `3` |
| `FORK_NAME` | Ethereum consensus layer fork name (fallback if not in headers) | no | `electra` |
| **Contracts** | | | |
| `LIDO_LOCATOR_ADDRESS` | Lido Locator contract address | yes | |
| `TX_SIGNER_PRIVATE_KEY` | Private key for transaction signing | yes (if not dry run) | |
| **Transaction Settings** | | | |
| `TX_MIN_GAS_PRIORITY_FEE` | Minimum gas priority fee (wei) | no | `50000000` (0.05 gwei) |
| `TX_MAX_GAS_PRIORITY_FEE` | Maximum gas priority fee (wei) | no | `10000000000` (10 gwei) |
| `TX_GAS_PRIORITY_FEE_PERCENTILE` | Gas priority fee percentile | no | `25` |
| `TX_GAS_FEE_HISTORY_DAYS` | Days of gas fee history | no | `1` |
| `TX_GAS_FEE_HISTORY_PERCENTILE` | Gas fee history percentile | no | `50` |
| `TX_GAS_LIMIT` | Minimum gas limit for transactions (bot may use more based on estimation) | no | `2000000` |
| `TX_SKIP_GAS_ESTIMATION` | Skip gas estimation and always use fixed TX_GAS_LIMIT | no | `false` |
| `VALIDATOR_BATCH_SIZE` | Maximum validators per transaction | no | `50` |
| `MAX_TRANSACTION_SIZE_BYTES` | Maximum transaction size in bytes | no | `100000` |
| `TX_MINING_WAITING_TIMEOUT_MS` | Transaction mining timeout | no | `3600000` (1 hour) |
| `TX_CONFIRMATIONS` | Required confirmations | no | `1` |
| **Startup Options** | | | |
| `START_ROOT` | Start from specific beacon chain root | no | |
| `START_SLOT` | Start from specific beacon chain slot | no | |
| `START_EPOCH` | Start from specific beacon chain epoch | no | |
| **Logging** | | | |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | no | `info` |
| `LOG_FORMAT` | Log format (`simple`, `json`) | no | `simple` |

## Gas Cost Estimation Tool

Before running the bot, you can estimate current gas costs on mainnet using the standalone gas estimation script:

```bash
# Basic usage (uses default public RPC)
yarn estimate-gas

# With your own RPC
EL_RPC_URLS=https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY yarn estimate-gas

# With custom configuration
TX_GAS_FEE_HISTORY_DAYS=3 TX_GAS_FEE_HISTORY_PERCENTILE=75 yarn estimate-gas
```

**What it does:**
- ✅ Fetches current mainnet base fee
- ✅ Analyzes historical gas data (1 day by default)
- ✅ Calculates recommended gas fee using percentile
- ✅ Estimates costs for small/typical/large batches
- ✅ Shows if bot would send transactions now
- ✅ Displays costs in Gwei, ETH, and USD

**Example output:**
```
Current base fee: 25.3 Gwei
Recommended (50th percentile): 28.5 Gwei
Status: ✅ ACCEPTABLE

Typical Batch (~2.2M gas):
  Gas Cost: 55,660,000 Gwei
  ETH Cost: 0.055660 ETH
  USD Cost: $138.35

✅ DECISION: Bot would send transactions now.
```

See [scripts/README.md](scripts/README.md) for full documentation.

## Monitoring

### Health Check

```bash
curl http://localhost:8081/health
```

## Troubleshooting

### Gas-Related Errors

#### How Gas Limit Works

The bot uses **dynamic gas estimation** by default:

1. **Estimates gas** required for each transaction using `eth_estimateGas`
2. **Adds 20% buffer** to account for gas variation
3. **Compares with configured limit**: Uses the **higher** of estimated or configured value
4. **Warns if estimated exceeds configured** limit

**Example behavior:**
- Configured: `TX_GAS_LIMIT=2000000`
- Estimated: `1,800,000` gas
- Used: `2,160,000` gas (1.8M × 1.2 buffer)
- If estimated: `2,500,000` gas
  - Used: `3,000,000` gas (2.5M × 1.2 buffer)
  - ⚠️ Warning logged: "Consider increasing TX_GAS_LIMIT"

#### UNPREDICTABLE_GAS_LIMIT Error
If you encounter `UNPREDICTABLE_GAS_LIMIT` errors:

1. **Check logs**: Look for the estimated gas amount before the error
2. **Increase gas limit**: Set `TX_GAS_LIMIT` to estimated × 1.5 for safety
3. **Skip gas estimation**: Set `TX_SKIP_GAS_ESTIMATION=true` to use fixed gas limits
4. **Check contract state**: Ensure your validators and exit requests are valid
5. **Network issues**: Verify your RPC endpoints are stable and responsive

#### Out of Gas / Transaction Reverted
If your transaction passes checks but reverts with "out of gas":

1. **Check logs for gas warnings**: Look for messages about estimated gas exceeding limit
2. **Increase configured limit**: The bot will automatically use the higher amount
   ```bash
   # If logs show "Estimated gas (with buffer): 2,500,000"
   TX_GAS_LIMIT=2500000
   ```
3. **Consider batch size**: Reduce `VALIDATOR_BATCH_SIZE` if transactions are too large
4. **Use fixed limit**: Set `TX_SKIP_GAS_ESTIMATION=true` and a high `TX_GAS_LIMIT`

#### Intrinsic Gas Too Low Error
If you see "intrinsic gas too low: gas X, minimum needed Y":

1. **Set higher gas limit**: Use the "minimum needed" value + 20% buffer
   ```bash
   # If error shows "minimum needed 1588836"
   TX_GAS_LIMIT=1906600  # 1588836 * 1.2
   ```
2. **Enable dynamic estimation**: Ensure `TX_SKIP_GAS_ESTIMATION=false` (default)
3. **Check batch size**: Larger batches need more gas - consider reducing `VALIDATOR_BATCH_SIZE`

#### Gas Limit Guidelines by Batch Size
- **1-10 validators**: `TX_GAS_LIMIT=1000000` (bot will use more if needed)
- **11-25 validators**: `TX_GAS_LIMIT=1500000` (bot will use more if needed)
- **26-50 validators**: `TX_GAS_LIMIT=2000000` (bot will use more if needed)
- **51+ validators**: `TX_GAS_LIMIT=2500000+` or reduce batch size

**Note:** With dynamic estimation (default), these are **minimum safety values**. The bot will automatically use more gas if estimation suggests it's needed.

### Oversized Transaction Error

If you encounter "oversized data" or "transaction size limit exceeded" errors:

1. **Reduce batch size**: Set `VALIDATOR_BATCH_SIZE=25` (or lower)
2. **Set size limit**: Adjust `MAX_TRANSACTION_SIZE_BYTES=50000` for stricter limits
3. **Monitor logs**: Check how many validators are being processed per batch
4. **RPC provider limits**: Some providers have stricter size limits (Alchemy: 128KB, Infura: varies)

Example configuration for large validator sets:
```bash
VALIDATOR_BATCH_SIZE=20
MAX_TRANSACTION_SIZE_BYTES=80000
TX_GAS_LIMIT=2500000
```

The application automatically splits large validator groups into smaller batches to prevent oversized transactions and provides detailed batch processing logs.

### Prometheus Metrics

The bot exposes comprehensive metrics at `/metrics` endpoint:

```bash
# View all metrics
curl http://localhost:8081/metrics

# View custom metrics
curl http://localhost:8081/metrics | grep late_prover_bot
```

#### Key Metrics Categories

- **Proof Generation**: Duration and success rates
- **Validator Processing**: Processed, skipped, and eligible validators
- **Contract Interactions**: Call duration and verification counts
- **Block Processing**: Range processing and batch operations
- **Memory Usage**: Heap usage and RSS memory
- **Daemon Operations**: Cycle duration and sleep tracking
- **Error Tracking**: Various error counters

### Monitoring Stack

The project includes a complete monitoring setup:

```bash
# Start with Prometheus
docker-compose up -d daemon prometheus

# Access Prometheus UI
open http://localhost:9090

# Uncomment Grafana in docker-compose.yml for dashboards
# open http://localhost:8082 (admin/MYPASSWORT)
```

## Development

### Building

```bash
# Build for production
yarn build

# Build and watch for changes
yarn run start:dev
```

### Testing

```bash
# Unit tests
yarn test

# E2E daemon tests  
yarn run test-daemon

# Test coverage
yarn run test:cov
```

### Linting

```bash
# Check code style
yarn run lint

# Fix code style issues
yarn run lint:fix

# Format code
yarn run format
```

## Architecture

### Core Components

- **DaemonService**: Main orchestrator running the processing loop
- **RootsProcessor**: Processes beacon chain roots and block ranges
- **RootsProvider**: Provides next roots to process with crash recovery
- **ProverService**: Generates Merkle proofs for delayed validator exits
- **Contract Services**: Interact with Lido contracts (ValidatorExitDelayVerifier, StakingRouter, etc.)
- **Consensus/Execution Providers**: Interface with beacon chain and execution layer

### Data Flow

1. **Root Discovery**: RootsProvider determines next beacon chain root to process
2. **Block Range Processing**: RootsProcessor handles execution layer blocks
3. **Exit Request Detection**: ProverService discovers exit requests from events
4. **Validator Analysis**: Groups validators by deadline and checks exit status
5. **Proof Generation**: Creates Merkle proofs for delayed validators
6. **Contract Submission**: Submits proofs to ValidatorExitDelayVerifier contract
7. **Progress Tracking**: Stores last processed root and updates metrics

## License

GPL-3.0

## Support

For issues and questions, please open an issue on the [GitHub repository](https://github.com/lidofinance/late-prover-bot).
