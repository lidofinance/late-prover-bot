/**
 * Safely serializes an error for logging to avoid stack overflow during secret sanitization
 *
 * The @lido-nestjs/logger with secrets sanitization recursively processes all properties
 * of logged objects. When error objects contain large payloads, deep nesting, or circular
 * references, this causes stack overflow.
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
