import { SECRET_REPLACER, regExpEscape } from '@lido-nestjs/logger';
import { Transform, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

import { Environment, LogFormat, LogLevel } from './interfaces';

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
  public LIDO_LOCATOR_ADDRESS: string;

  @IsNotEmpty()
  @IsString()
  @ValidateIf((vars) => !vars.DRY_RUN)
  public TX_SIGNER_PRIVATE_KEY: string;

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
  @Transform(({ value }) => value.split(','))
  public EL_RPC_URLS!: string[];

  @IsInt()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_RESPONSE_TIMEOUT_MS = MINUTE;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_MAX_RETRIES = 3;

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => value.split(','))
  public CL_API_URLS!: string[];

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

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config);

  const validatorOptions = { skipMissingProperties: false };
  const errors = validateSync(validatedConfig, validatorOptions);

  if (errors.length > 0) {
    const errorString = errors.toString();
    const sanitizedError = sanitizeValidationErrors(errorString, config);
    console.error('Configuration validation failed:');
    console.error(sanitizedError);
    process.exit(1);
  }

  return validatedConfig;
}

/**
 * Sanitize validation error messages to prevent leaking sensitive data
 * Uses the same sanitization logic as @lido-nestjs/logger cleanSecrets format
 */
function sanitizeValidationErrors(errorString: string, config: Record<string, unknown>): string {
  const sensitiveKeys = ['TX_SIGNER_PRIVATE_KEY', 'EL_RPC_URLS', 'CL_API_URLS'];

  const secrets: string[] = [];
  for (const key of sensitiveKeys) {
    const value = config[key];
    if (value) {
      const values = Array.isArray(value) ? value : [value];
      secrets.push(...values.filter((v): v is string => typeof v === 'string' && v.length > 0));
    }
  }

  return secrets.reduce((sanitized, secret) => {
    const re = new RegExp(regExpEscape(secret), 'g');
    return sanitized.replace(re, SECRET_REPLACER);
  }, errorString);
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
