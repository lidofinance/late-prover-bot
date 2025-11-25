import { ConfigService as ConfigServiceSource } from '@nestjs/config';

import { EnvironmentVariables } from './env.validation';

export class ConfigService extends ConfigServiceSource<EnvironmentVariables> {
  /**
   * List of sensitive values that should be hidden in logs
   */
  public get secrets(): string[] {
    const secrets: string[] = [];

    // Add RPC URLs
    secrets.push(...this.get('EL_RPC_URLS'));
    secrets.push(...this.get('CL_API_URLS'));

    // Add private key if present
    const privateKey = this.get('TX_SIGNER_PRIVATE_KEY');
    if (privateKey) {
      secrets.push(privateKey);
      // Also add the private key without 0x prefix in case it appears that way
      if (privateKey.startsWith('0x')) {
        secrets.push(privateKey.slice(2));
      }
    }

    return secrets;
  }

  public get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    return super.get(key, { infer: true }) as EnvironmentVariables[T];
  }
}
