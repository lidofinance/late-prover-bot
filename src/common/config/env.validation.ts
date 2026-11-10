import { Transform, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

import { FILE_BACKED_ENV_KEYS, SecretFileError, applySecretFiles } from './env.files';
import { Environment, LogFormat, LogLevel } from './interfaces';
import { logBootstrapError } from '../logger/bootstrap-logger';

export enum Network {
  Mainnet = 1,
  Goerli = 5,
  Holesky = 17000,
}

export enum WorkingMode {
  Daemon = 'daemon',
  CLI = 'cli',
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The EL fallback provider stops retrying when the next backoff would reach this value; every sleep stays below it */
export const EL_RPC_MAX_BACKOFF_MS = 10_000;

const hasValue = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

// A space after the comma would stay in the secret value: the mask would then look for " https://..." while the
// clients request and log the URL without the space
const splitList = (value: string): string[] => value.split(',').map((part) => part.trim());

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsEnum(WorkingMode)
  public WORKING_MODE = WorkingMode.Daemon;

  @IsNumber()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public START_LOOKBACK_DAYS = 7; // Default to 7 days lookback

  @IsNotEmpty()
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  public LIDO_LOCATOR_ADDRESS: string;

  // The format rule stops a malformed key here, where the error is masked. Later, ethers would quote the value in
  // its "invalid hexlify value" error before the app logger exists. The key is optional only in dry run; a key
  // that is given is always checked, because the signer is built from it in both modes.
  @IsNotEmpty()
  @IsString()
  @Matches(/^(0x)?[0-9a-fA-F]{64}$/)
  @ValidateIf((vars) => !vars.DRY_RUN || hasValue(vars.TX_SIGNER_PRIVATE_KEY))
  public TX_SIGNER_PRIVATE_KEY: string;

  /** Path to a file with the value of TX_SIGNER_PRIVATE_KEY; the file wins over the variable (see env.files.ts) */
  @IsOptional()
  @IsString()
  public TX_SIGNER_PRIVATE_KEY_FILE?: string;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_MIN_GAS_PRIORITY_FEE = 50_000_000; // 0.05 gwei

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_MAX_GAS_PRIORITY_FEE = 10_000_000_000; // 10 gwei

  @IsNumber()
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_PRIORITY_FEE_PERCENTILE = 25;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_FEE_HISTORY_DAYS = 1;

  @IsNumber()
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_FEE_HISTORY_PERCENTILE = 50;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_LIMIT = 2_000_000; // Minimum gas limit - bot will use more if estimation suggests (with 20% buffer)

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public VALIDATOR_BATCH_SIZE = 50; // Maximum validators per transaction

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public MAX_TRANSACTION_SIZE_BYTES = 100_000; // Maximum transaction size in bytes

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_MINING_WAITING_TIMEOUT_MS = HOUR;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_CONFIRMATIONS = 1;

  @IsNumber()
  @Min(1025)
  @Max(65535)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public HTTP_PORT = 8080;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @IsEnum(LogFormat)
  LOG_FORMAT: LogFormat = LogFormat.Simple;

  @IsBoolean()
  @Transform(({ value }) => toBoolean(value), { toClassOnly: true })
  public DRY_RUN = false;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CHAIN_ID!: Network;

  @IsArray()
  @ArrayMinSize(1)
  @IsNotEmpty({ each: true })
  @Transform(({ value }) => splitList(value))
  public EL_RPC_URLS!: string[];

  /** Path to a file with the value of EL_RPC_URLS; the file wins over the variable */
  @IsOptional()
  @IsString()
  public EL_RPC_URLS_FILE?: string;

  /** First backoff of the EL provider retries; it doubles on every retry */
  @IsInt()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_RETRY_DELAY_MS = 500;

  // 120 s is what ethers used before this variable reached the provider: the bot reads logs in ranges of
  // thousands of blocks, and a shorter timeout would turn slow answers into retries
  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_RESPONSE_TIMEOUT_MS = 2 * MINUTE;

  /** Attempts per EL provider before the switch to the next one (the first try included); see elRetryError */
  @IsInt()
  @Min(1)
  @Max(20)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_MAX_RETRIES = 3;

  @IsArray()
  @ArrayMinSize(1)
  @IsNotEmpty({ each: true })
  @Transform(({ value }) => splitList(value))
  public CL_API_URLS!: string[];

  /** Path to a file with the value of CL_API_URLS; the file wins over the variable */
  @IsOptional()
  @IsString()
  public CL_API_URLS_FILE?: string;

  @IsInt()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CL_API_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CL_API_RESPONSE_TIMEOUT_MS = MINUTE;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CL_API_MAX_RETRIES = 3;

  @IsNumber()
  @Min(10000) // Minimum 10 seconds
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public DAEMON_SLEEP_INTERVAL_MS = 300000; // Default 5 minutes

  @IsString()
  public FORK_NAME: string = 'electra';
}

// Every variable of the class above, as a Record so that the compiler reports a field that is missing here or a key
// that is not a field. The startup dump iterates over it.
const ENV_KEY_SET: Record<keyof EnvironmentVariables, true> = {
  NODE_ENV: true,
  WORKING_MODE: true,
  START_LOOKBACK_DAYS: true,
  LIDO_LOCATOR_ADDRESS: true,
  TX_SIGNER_PRIVATE_KEY: true,
  TX_SIGNER_PRIVATE_KEY_FILE: true,
  TX_MIN_GAS_PRIORITY_FEE: true,
  TX_MAX_GAS_PRIORITY_FEE: true,
  TX_GAS_PRIORITY_FEE_PERCENTILE: true,
  TX_GAS_FEE_HISTORY_DAYS: true,
  TX_GAS_FEE_HISTORY_PERCENTILE: true,
  TX_GAS_LIMIT: true,
  VALIDATOR_BATCH_SIZE: true,
  MAX_TRANSACTION_SIZE_BYTES: true,
  TX_MINING_WAITING_TIMEOUT_MS: true,
  TX_CONFIRMATIONS: true,
  HTTP_PORT: true,
  LOG_LEVEL: true,
  LOG_FORMAT: true,
  DRY_RUN: true,
  CHAIN_ID: true,
  EL_RPC_URLS: true,
  EL_RPC_URLS_FILE: true,
  EL_RPC_RETRY_DELAY_MS: true,
  EL_RPC_RESPONSE_TIMEOUT_MS: true,
  EL_RPC_MAX_RETRIES: true,
  CL_API_URLS: true,
  CL_API_URLS_FILE: true,
  CL_API_RETRY_DELAY_MS: true,
  CL_API_RESPONSE_TIMEOUT_MS: true,
  CL_API_MAX_RETRIES: true,
  DAEMON_SLEEP_INTERVAL_MS: true,
  FORK_NAME: true,
};

export const ENV_KEYS = Object.keys(ENV_KEY_SET) as readonly (keyof EnvironmentVariables)[];

/**
 * Validates the raw env: first the `<NAME>_FILE` variables are applied (a secret from a file replaces the env value),
 * then the class above is checked. A validation error, an unreadable or a non-UTF-8 secret file is logged through
 * the bootstrap logger with the secrets masked and stops the process. Any other exception is rethrown.
 */
export function validate(config: Record<string, unknown>) {
  const fail = (details: string, secrets: string[]): never => {
    logBootstrapError('Configuration validation failed', details, secrets);
    return process.exit(1);
  };

  let resolvedConfig: Record<string, unknown>;
  try {
    resolvedConfig = applySecretFiles(config);
  } catch (error) {
    if (!(error instanceof SecretFileError)) {
      throw error;
    }
    return fail(error.message, collectSecrets(config));
  }

  const validatedConfig = plainToInstance(EnvironmentVariables, resolvedConfig);

  const validatorOptions = { skipMissingProperties: false };
  const errors = validateSync(validatedConfig, validatorOptions);

  if (errors.length > 0) {
    return fail(errors.toString(), collectSecrets(resolvedConfig));
  }

  const retryError = elRetryError(validatedConfig);
  if (retryError) {
    return fail(retryError, collectSecrets(resolvedConfig));
  }

  return validatedConfig;
}

/**
 * The EL fallback provider doubles the backoff after every failed attempt and gives up as soon as the backoff
 * reaches EL_RPC_MAX_BACKOFF_MS, so a high attempt count with a long first delay would never be reached. The cap keeps
 * a dead provider from blocking the bot for hours before the next provider is tried; this check keeps the configured
 * count honest.
 */
export function elRetryError(
  config: Pick<EnvironmentVariables, 'EL_RPC_MAX_RETRIES' | 'EL_RPC_RETRY_DELAY_MS'>,
): string | undefined {
  const { EL_RPC_MAX_RETRIES: attempts, EL_RPC_RETRY_DELAY_MS: delayMs } = config;
  // attempt k (from 1) is followed by a sleep of delayMs * 2 ** (k - 1), which must stay below the cap for every
  // sleep before the last attempt
  const reachable = (count: number) => count < 2 || delayMs * 2 ** (count - 2) < EL_RPC_MAX_BACKOFF_MS;
  if (reachable(attempts)) {
    return undefined;
  }
  let max = 1;
  while (reachable(max + 1)) {
    max++;
  }
  return (
    `EL_RPC_MAX_RETRIES=${attempts} is not reachable with EL_RPC_RETRY_DELAY_MS=${delayMs}: the retries stop when the ` +
    `next backoff would reach ${EL_RPC_MAX_BACKOFF_MS} ms, the maximum is ${max}`
  );
}

/**
 * The secret values of a raw config (the key with and without 0x, every URL of the lists), for masking before
 * ConfigService exists
 */
export function collectSecrets(config: Record<string, unknown>): string[] {
  const secrets: string[] = [];
  for (const key of FILE_BACKED_ENV_KEYS) {
    const value = config[key];
    if (typeof value !== 'string') {
      continue;
    }
    for (const part of value.split(',')) {
      const secret = part.trim();
      if (secret.length === 0) {
        continue;
      }
      secrets.push(secret);
      if (secret.startsWith('0x')) {
        secrets.push(secret.slice(2));
      }
    }
  }
  return secrets;
}

const toBoolean = (value: any): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return !!value;
  }

  if (!(typeof value === 'string')) {
    return false;
  }

  switch (value.toLowerCase().trim()) {
    case 'true':
    case 'yes':
    case '1':
      return true;
    case 'false':
    case 'no':
    case '0':
    case null:
      return false;
    default:
      return false;
  }
};
