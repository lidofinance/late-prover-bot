import { buildMask } from './mask';

/**
 * Logs an error that happens before the Nest container and its logger exist (the env validation at startup).
 * Both the message and the details pass through the mask, so a secret from the env never reaches stderr.
 */
export const logBootstrapError = (message: string, details: unknown, secrets: string[]): void => {
  const mask = buildMask(secrets);
  const line = { level: 'error', context: 'Bootstrap', message: mask(message), details: mask(details) };
  process.stderr.write(`${JSON.stringify(line)}\n`);
};
