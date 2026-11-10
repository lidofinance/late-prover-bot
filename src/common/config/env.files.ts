import { readFileSync } from 'fs';

/**
 * Variables whose value can come from a file named by `<NAME>_FILE`. The file form is for secrets mounted by the
 * container platform (one secret per file). The variables stay readable from the env as before.
 */
export const FILE_BACKED_ENV_KEYS = ['TX_SIGNER_PRIVATE_KEY', 'EL_RPC_URLS', 'CL_API_URLS'] as const;

/** A `<NAME>_FILE` that cannot be used. The message names the variable and the path, never the content. */
export class SecretFileError extends Error {}

/**
 * Returns a copy of `config` where every file-backed variable with a set `<NAME>_FILE` takes the content of that file.
 *
 * - The file wins over the env value when both are set.
 * - Leading and trailing whitespace (spaces, newlines) of the file is dropped.
 * - The file is read once, when the config is validated at startup. A new value needs a restart.
 * - An empty file means "no value": the variable is removed, so the validation treats it as unset.
 * - A path that cannot be read, or a file that is not UTF-8 text, throws `SecretFileError`.
 */
export function applySecretFiles(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };

  for (const key of FILE_BACKED_ENV_KEYS) {
    const pathKey = `${key}_FILE`;
    const path = config[pathKey];
    if (typeof path !== 'string' || path === '') {
      continue;
    }

    const value = readSecretFile(pathKey, path);
    if (value === '') {
      delete result[key];
    } else {
      result[key] = value;
    }
  }

  return result;
}

function readSecretFile(pathKey: string, path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new SecretFileError(
      `${pathKey} points to a file that cannot be read (${code}): ${path}. Fix or remove the variable.`,
    );
  }

  try {
    // fatal: a byte sequence that is not UTF-8 throws instead of producing replacement characters
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    throw new SecretFileError(`${pathKey} points to ${path}, which is not UTF-8 text. Fix or remove the variable.`);
  }
}
