/**
 * Serializes an error for logging as a short JSON string
 *
 * The @lido-nestjs/logger masks every property of a logged object and cuts large or deep payloads by the limits
 * of its sanitizer, so an error that carries a big payload (an RPC response, a request) would be logged truncated.
 *
 * This utility extracts only safe, essential error information (message and stack trace)
 * and serializes it as JSON string.
 *
 * @param err - The error to serialize
 * @returns A JSON string with error message and stack trace
 *
 * @example
 * try {
 *   // ... some code
 * } catch (error) {
 *   this.logger.error('Failed to process', serializeError(error));
 *   throw error;
 * }
 */
export function serializeError(err: unknown): string {
  let errorObj: any;
  if (err instanceof Error) {
    errorObj = {
      message: err.message,
      stack: err.stack,
    };
  } else {
    errorObj = {
      message: String(err),
      stack: undefined,
    };
  }
  return JSON.stringify(errorObj, null, 2);
}
