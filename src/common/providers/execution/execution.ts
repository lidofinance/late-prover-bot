import { TransactionResponse } from '@ethersproject/abstract-provider';
import { MAX_BLOCKCOUNT, SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { BigNumber, PopulatedTransaction, Wallet, utils } from 'ethers';
import { InquirerService } from 'nest-commander';
import { promise as spinnerFor } from 'ora-classic';

import { bigIntMax, bigIntMin, percentile } from './utils/common';
import { ConfigService } from '../../config/config.service';
import { PrometheusService } from '../../prometheus/prometheus.service';
import { sanitizeObject } from '../../utils/sanitizer';

export enum TransactionStatus {
  confirmed = 'confirmed',
  pending = 'pending',
  error = 'error',
  dry_run = 'dry_run', // Add dry run status
}

// Constants
const RETRY_DELAY_MS = 60 * 1000; // 1 minute
const BLOCKS_PER_HOUR = (60 * 60) / 12; // Assuming 12s block time
const HOURS_PER_DAY = 24;
const GAS_BUFFER_MULTIPLIER = 2n; // 2x buffer for maxFeePerGas
const MAX_ERROR_MESSAGE_LENGTH = 500; // Truncate error messages longer than this

class ErrorWithContext extends Error {
  public readonly context: any;
  public readonly errorId: string;
  public logged: boolean = false;

  constructor(message?: string, ctx?: any) {
    super(message);
    this.context = ctx;
    this.errorId = this.generateErrorId();
  }

  private generateErrorId(): string {
    return `ERR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

class EmulatedCallError extends ErrorWithContext {}
class SendTransactionError extends ErrorWithContext {}
class HighGasFeeError extends ErrorWithContext {}
class NoSignerError extends ErrorWithContext {}
class GasLimitExceededError extends ErrorWithContext {}

interface GasParameters {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface GasFeeData {
  recommended: bigint;
  current: bigint;
}

interface TransactionContext {
  payload: any[];
  tx?: any;
}

// Error logging utility to prevent duplicate logging
class ErrorLogger {
  private loggedErrors = new Set<string>();

  constructor(
    private logger: LoggerService,
    private secrets: string[],
  ) {}

  logErrorOnce(error: any, context?: string): string {
    let errorId: string;
    let message: string;

    if (error instanceof ErrorWithContext) {
      errorId = error.errorId;
      message = error.message;

      if (error.logged) {
        // Error already logged, just log reference
        this.logger.warn(`Error ${errorId} occurred again${context ? ` in ${context}` : ''}`);
        return errorId;
      }
      error.logged = true;
    } else {
      errorId = this.generateErrorId();
      message = error instanceof Error ? error.message : String(error);
    }

    if (this.loggedErrors.has(errorId)) {
      this.logger.warn(`Error ${errorId} occurred again${context ? ` in ${context}` : ''}`);
      return errorId;
    }

    // Log the full error for the first time
    const truncatedMessage = this.truncateMessage(message);
    const errorDetails = this.serializeError(error);

    this.logger.error(
      `[${errorId}] ${truncatedMessage}${context ? ` (${context})` : ''}`,
      this.truncateErrorDetails(errorDetails),
    );

    this.loggedErrors.add(errorId);
    return errorId;
  }

  private generateErrorId(): string {
    return `ERR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private truncateMessage(message: string): string {
    if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
      return message;
    }
    return message.substring(0, MAX_ERROR_MESSAGE_LENGTH) + '... [truncated]';
  }

  private truncateErrorDetails(details: string): string {
    const maxLength = MAX_ERROR_MESSAGE_LENGTH * 3; // Allow longer for detailed error info
    if (details.length <= maxLength) {
      return details;
    }
    return details.substring(0, maxLength) + '\n... [error details truncated]';
  }

  private serializeError(err: unknown): string {
    let errorObj: any;
    if (err instanceof Error) {
      errorObj = {
        name: err.name,
        message: err.message,
        code: (err as any).code,
        reason: (err as any).reason,
        data: (err as any).data,
        // Only include stack for non-production or if explicitly needed
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
        ...Object.getOwnPropertyNames(err).reduce(
          (acc, key) => {
            if (!['name', 'message', 'stack'].includes(key)) {
              acc[key] = (err as any)[key];
            }
            return acc;
          },
          {} as Record<string, any>,
        ),
      };
    } else {
      errorObj = err;
    }

    // Sanitize the error object before serialization
    const sanitized = sanitizeObject(errorObj, this.secrets);
    return JSON.stringify(sanitized, null, 2);
  }
}

@Injectable()
export class Execution {
  public signer?: Wallet;
  private errorLogger: ErrorLogger;

  private gasFeeHistoryCache: bigint[] = [];
  private lastFeeHistoryBlockNumber = 0;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    @Optional() protected readonly prometheus: PrometheusService,
    @Optional() protected readonly inquirerService: InquirerService,
    public readonly provider: SimpleFallbackJsonRpcBatchProvider,
  ) {
    this.initializeSigner();
    this.errorLogger = new ErrorLogger(this.logger, this.config.secrets);
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  public async balanceOf(address: string): Promise<BigNumber> {
    return this.provider.getBalance(address);
  }

  public async execute(
    emulateTxCallback: (...payload: any[]) => Promise<any>,
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    return await this.executeDaemon(emulateTxCallback, populateTxCallback, payload);
  }

  public async executeDaemon(
    emulateTxCallback: (...payload: any[]) => Promise<any>,
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    while (true) {
      try {
        this.prometheus?.transactionCount.inc({ status: TransactionStatus.pending });

        const isDryRun = this.config.get('DRY_RUN');
        await this.executeTransaction(emulateTxCallback, populateTxCallback, payload);

        // Track appropriate completion status
        if (isDryRun) {
          this.prometheus?.transactionCount.inc({ status: TransactionStatus.dry_run });
        } else {
          this.prometheus?.transactionCount.inc({ status: TransactionStatus.confirmed });
        }

        return; // Successfully completed (either sent or dry run)
      } catch (error) {
        await this.handleExecutionError(error);
      } finally {
        this.prometheus?.transactionCount.dec({ status: TransactionStatus.pending });
      }
    }
  }

  // ==========================================
  // TRANSACTION EXECUTION
  // ==========================================

  private async executeTransaction(
    emulateTxCallback: (...payload: any[]) => Promise<any>,
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    this.logger.debug!(payload);

    // Step 1: Build transaction
    const tx = await populateTxCallback(...payload);
    const context: TransactionContext = { payload, tx };

    // Step 2: Emulate the call
    await this.emulateTransaction(emulateTxCallback, payload, context);

    // Step 3: Validate signer (only if not in dry run mode)
    if (!this.config.get('DRY_RUN')) {
      this.validateSigner(context);
    }

    // Step 4: Prepare transaction with gas parameters
    const populatedTx = await this.prepareTransaction(tx, context);

    // Step 5: Check if we should proceed (gas fees, dry run)
    const shouldProceed = await this.validateTransactionConditions(context, populatedTx);
    if (!shouldProceed) {
      return; // Successfully exit without sending transaction
    }

    // Step 6: Send and wait for confirmation
    await this.sendAndConfirmTransaction(populatedTx);
  }

  private async emulateTransaction(
    emulateTxCallback: (...payload: any[]) => Promise<any>,
    payload: any[],
    context: TransactionContext,
  ): Promise<void> {
    this.logger.log('Emulating call');
    try {
      await emulateTxCallback(...payload);
      this.logger.log('✅ Emulated call succeeded');
    } catch (error) {
      const errorId = this.errorLogger.logErrorOnce(error, 'emulation');
      throw new EmulatedCallError(`Emulation failed [${errorId}]`, context);
    }
  }

  private validateSigner(context: TransactionContext): void {
    if (!this.signer) {
      throw new NoSignerError('No specified signer. Only emulated calls are available', context);
    }
  }

  private async estimateGasLimit(tx: PopulatedTransaction): Promise<bigint> {
    try {
      this.logger.log('🔍 Estimating gas required for transaction');
      const estimated = await this.provider.estimateGas(tx);
      const estimatedBigInt = BigInt(estimated.toString());

      this.logger.log(`📊 Estimated gas: ${estimatedBigInt.toLocaleString()}`);
      return estimatedBigInt;
    } catch (error) {
      this.logger.warn('⚠️  Gas estimation failed, will use configured limit');
      this.errorLogger.logErrorOnce(error, 'gas-estimation');
      return BigInt(this.config.get('TX_GAS_LIMIT'));
    }
  }

  private async prepareTransaction(tx: PopulatedTransaction, context: TransactionContext): Promise<any> {
    const gasParameters = await this.calculateGasParameters();

    // Estimate gas limit
    const estimated = await this.estimateGasLimit(tx);
    const configuredLimit = BigInt(this.config.get('TX_GAS_LIMIT'));

    // Calculate estimated gas with buffer
    const ESTIMATION_BUFFER = 1.2; // 20% buffer
    const estimatedWithBuffer = BigInt(Math.floor(Number(estimated) * ESTIMATION_BUFFER));

    // TX_GAS_LIMIT is a hard upper limit - reject if estimation exceeds it
    if (estimatedWithBuffer > configuredLimit) {
      const errorMessage =
        `Transaction rejected: Estimated gas exceeds configured hard limit!` +
        `\n  Estimated: ${estimated.toLocaleString()}` +
        `\n  With 20% buffer: ${estimatedWithBuffer.toLocaleString()}` +
        `\n  Configured hard limit (TX_GAS_LIMIT): ${configuredLimit.toLocaleString()}` +
        `\n  Required: TX_GAS_LIMIT must be at least ${estimatedWithBuffer.toLocaleString()}` +
        `\n  Action: Increase TX_GAS_LIMIT or reduce VALIDATOR_BATCH_SIZE`;

      throw new GasLimitExceededError(errorMessage, context);
    }

    const gasLimit = estimatedWithBuffer;

    this.logger.log(
      `📊 Gas limit decision:` +
        `\n  Estimated: ${estimated.toLocaleString()}` +
        `\n  With 20% buffer: ${estimatedWithBuffer.toLocaleString()}` +
        `\n  Configured hard limit: ${configuredLimit.toLocaleString()}` +
        `\n  Using: ${gasLimit.toLocaleString()} ✅`,
    );

    const populated = await this.signer!.populateTransaction({
      ...tx,
      maxFeePerGas: gasParameters.maxFeePerGas,
      maxPriorityFeePerGas: gasParameters.maxPriorityFeePerGas,
      gasLimit: gasLimit,
    });

    context.tx = populated;
    return populated;
  }

  private async validateTransactionConditions(context: TransactionContext, populatedTx: any): Promise<boolean> {
    // Handle dry run mode - log transaction details and return false (don't proceed)
    if (this.config.get('DRY_RUN')) {
      this.logDryRunTransaction(populatedTx);
      return false;
    }

    // Check gas fees
    const isGasFeeAcceptable = await this.isGasFeeAcceptable();
    if (!isGasFeeAcceptable) {
      throw new HighGasFeeError('Transaction is not sent due to high gas fee', context);
    }

    return true; // Proceed with transaction
  }

  private logDryRunTransaction(populatedTx: any): void {
    this.logger.log('🔍 DRY RUN MODE - Transaction prepared but not sent:');

    // Try to identify the contract method being called
    let methodInfo = '';
    if (populatedTx.data && populatedTx.data.length > 10) {
      const methodSelector = populatedTx.data.substring(0, 10);
      methodInfo = `\n  Method Selector: ${methodSelector}`;
    }

    this.logger.log(
      `📋 Transaction Details:` +
        `\n  To: ${populatedTx.to || 'N/A'}` +
        `\n  Value: ${populatedTx.value || '0'} ETH` +
        `\n  Gas Limit: ${populatedTx.gasLimit}` +
        `\n  Max Fee Per Gas: ${populatedTx.maxFeePerGas} (${utils.formatUnits(populatedTx.maxFeePerGas || 0, 'gwei')} Gwei)` +
        `\n  Max Priority Fee: ${populatedTx.maxPriorityFeePerGas} (${utils.formatUnits(populatedTx.maxPriorityFeePerGas || 0, 'gwei')} Gwei)` +
        `\n  Nonce: ${populatedTx.nonce}` +
        `\n  Data Length: ${populatedTx.data ? populatedTx.data.length : 0} bytes` +
        methodInfo +
        `\n  Estimated Cost: ~${this.estimateTransactionCost(populatedTx)} ETH`,
    );

    if (populatedTx.data && populatedTx.data.length > 2) {
      const dataPreview =
        populatedTx.data.length > 200 ? populatedTx.data.substring(0, 200) + '... [truncated]' : populatedTx.data;
      this.logger.debug!(`📝 Transaction Data: ${dataPreview}`);
    }

    this.logger.log('✅ DRY RUN completed successfully - no transaction sent');
    this.logger.log('💡 To send transactions, set DRY_RUN=false in your environment');
  }

  private estimateTransactionCost(populatedTx: any): string {
    if (!populatedTx.gasLimit || !populatedTx.maxFeePerGas) {
      return 'N/A';
    }

    const gasLimit = BigInt(populatedTx.gasLimit);
    const maxFeePerGas = BigInt(populatedTx.maxFeePerGas);
    const maxCost = gasLimit * maxFeePerGas;

    return utils.formatEther(maxCost.toString());
  }

  private async sendAndConfirmTransaction(populatedTx: any): Promise<void> {
    const signed = await this.signer!.signTransaction(populatedTx);

    try {
      // Send transaction
      const submitted = await this.sendTransactionWithLogging(signed, populatedTx);

      // Wait for confirmation
      await this.waitForConfirmation(submitted);

      this.logger.log(`✅ Transaction succeeded! Hash: ${submitted.hash}`);
    } catch (error) {
      const errorId = this.errorLogger.logErrorOnce(error, 'transaction-submission');
      throw new SendTransactionError(`Transaction submission failed [${errorId}]`, { tx: populatedTx });
    }
  }

  private async sendTransactionWithLogging(signedTx: string, populatedTx: any): Promise<TransactionResponse> {
    const submittedPromise = this.provider.sendTransaction(signedTx);

    const logMessage = `Sending transaction with nonce ${populatedTx.nonce} and gasLimit: ${populatedTx.gasLimit}, maxFeePerGas: ${populatedTx.maxFeePerGas}, maxPriorityFeePerGas: ${populatedTx.maxPriorityFeePerGas}`;
    spinnerFor(submittedPromise, { text: logMessage });

    const submitted = await submittedPromise;
    this.logger.log(`Transaction sent to mempool. Hash: ${submitted.hash}`);

    return submitted;
  }

  private async waitForConfirmation(submitted: TransactionResponse): Promise<void> {
    const confirmations = this.config.get('TX_CONFIRMATIONS');
    const timeout = this.config.get('TX_MINING_WAITING_TIMEOUT_MS');

    const waitingPromise = this.provider.waitForTransaction(submitted.hash, confirmations, timeout);
    const logMessage = `Waiting until the transaction has been mined and confirmed ${confirmations} times`;

    spinnerFor(waitingPromise, { text: logMessage });
    await waitingPromise;
  }

  // ==========================================
  // ERROR HANDLING
  // ==========================================

  private async handleExecutionError(error: any): Promise<void> {
    if (error instanceof NoSignerError) {
      this.errorLogger.logErrorOnce(error, 'execution-validation');
      return; // Exit the retry loop
    }

    if (error instanceof HighGasFeeError) {
      this.prometheus?.highGasFeeInterruptionsCount.inc();
      this.errorLogger.logErrorOnce(error, 'high-gas-fee');
      this.logger.warn('Retrying in 1 minute...');
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return; // Continue the retry loop
    }

    // For other errors, log once and re-throw
    this.prometheus?.transactionCount.inc({ status: TransactionStatus.error });
    const errorId = this.errorLogger.logErrorOnce(error, 'transaction-execution');

    // Create a new error with reference to avoid re-logging the same details
    const referenceError = new Error(`Transaction execution failed [${errorId}]`);
    throw referenceError;
  }

  // ==========================================
  // GAS MANAGEMENT
  // ==========================================

  private async calculateGasParameters(): Promise<GasParameters> {
    this.logger.log('🔄 Calculating priority fee');

    const { baseFeePerGas } = await this.provider.getBlock('pending');
    const feeHistory = await this.provider.getFeeHistory(1, 'latest', [
      this.config.get('TX_GAS_PRIORITY_FEE_PERCENTILE'),
    ]);

    const maxPriorityFeePerGas = this.calculatePriorityFee(feeHistory.reward);
    const maxFeePerGas = BigInt(Number(baseFeePerGas)) * GAS_BUFFER_MULTIPLIER + maxPriorityFeePerGas;

    this.logger.debug!(`Priority fee: ${maxPriorityFeePerGas} | Max fee: ${maxFeePerGas}`);

    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  private calculatePriorityFee(rewards: any[]): bigint {
    const rewardValue = rewards.pop()?.pop()?.toBigInt() ?? 0n;
    const minFee = BigInt(this.config.get('TX_MIN_GAS_PRIORITY_FEE'));
    const maxFee = BigInt(this.config.get('TX_MAX_GAS_PRIORITY_FEE'));

    return bigIntMin(bigIntMax(rewardValue, minFee), maxFee);
  }

  private async isGasFeeAcceptable(): Promise<boolean> {
    const { current, recommended } = await this.calculateGasFeeData();
    const currentGwei = utils.formatUnits(current, 'gwei');
    const recommendedGwei = utils.formatUnits(recommended, 'gwei');
    const info = `Current: ${currentGwei} Gwei | Recommended: ${recommendedGwei} Gwei`;

    if (current > recommended) {
      this.logger.warn(`📛 Current gas fee is HIGH! ${info}`);
      return false;
    }

    this.logger.log(`✅ Current gas fee is OK! ${info}`);
    return true;
  }

  private async calculateGasFeeData(): Promise<GasFeeData> {
    const { baseFeePerGas: currentFee } = await this.provider.getBlock('pending');
    await this.updateGasFeeHistoryCache();

    const recommended = percentile(this.gasFeeHistoryCache, this.config.get('TX_GAS_FEE_HISTORY_PERCENTILE'));

    return {
      recommended,
      current: currentFee?.toBigInt() ?? 0n,
    };
  }

  // ==========================================
  // GAS FEE HISTORY MANAGEMENT
  // ==========================================

  private async updateGasFeeHistoryCache(): Promise<void> {
    const maxFeeHistoryCacheSize = this.calculateMaxCacheSize();
    const { number: latestBlockNumber } = await this.provider.getBlock('latest');
    const blocksSinceLastUpdate = latestBlockNumber - this.lastFeeHistoryBlockNumber;

    // Only update if enough blocks have passed
    if (blocksSinceLastUpdate < BLOCKS_PER_HOUR) {
      return;
    }

    this.logger.log('🔄 Updating gas fee history cache');

    const blocksToFetch = Math.min(blocksSinceLastUpdate, maxFeeHistoryCacheSize);
    const newGasFees = await this.fetchGasFeeHistory(latestBlockNumber, blocksToFetch);

    this.updateCacheWithNewFees(newGasFees);
    this.lastFeeHistoryBlockNumber = latestBlockNumber;
  }

  private calculateMaxCacheSize(): number {
    const maxBlocksPerDay = HOURS_PER_DAY * BLOCKS_PER_HOUR;
    return this.config.get('TX_GAS_FEE_HISTORY_DAYS') * maxBlocksPerDay;
  }

  private async fetchGasFeeHistory(latestBlockNumber: number, totalBlocksToFetch: number): Promise<bigint[]> {
    let newGasFees: bigint[] = [];
    const blockCountPerRequest = MAX_BLOCKCOUNT;
    let latestBlockToRequest = latestBlockNumber;
    let remainingBlocks = totalBlocksToFetch;

    while (remainingBlocks > 0) {
      const currentBatchSize = Math.min(remainingBlocks, blockCountPerRequest);

      const stats = await this.provider.getFeeHistory(currentBatchSize, latestBlockToRequest, []);

      // Remove the extra block (baseFeePerGas includes next block)
      stats.baseFeePerGas.pop();

      const batchFees = stats.baseFeePerGas.map((fee) => fee.toBigInt());
      newGasFees = [...batchFees, ...newGasFees];

      latestBlockToRequest -= currentBatchSize - 1;
      remainingBlocks -= currentBatchSize;
    }

    return newGasFees;
  }

  private updateCacheWithNewFees(newGasFees: bigint[]): void {
    const existingCacheToKeep =
      this.gasFeeHistoryCache.length > newGasFees.length ? this.gasFeeHistoryCache.slice(newGasFees.length) : [];

    this.gasFeeHistoryCache = [...existingCacheToKeep, ...newGasFees];
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================

  private initializeSigner(): void {
    const privateKey = this.config.get('TX_SIGNER_PRIVATE_KEY');
    if (privateKey) {
      this.signer = new Wallet(privateKey, this.provider);
    }
  }
}
