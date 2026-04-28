import { SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';

/**
 * Extends SimpleFallbackJsonRpcBatchProvider to treat CALL_EXCEPTION errors caused by
 * transient RPC transport failures (FetchError) as retryable.
 *
 * Upstream issue: ethers v5 wraps RPC transport errors (e.g. "Temporary internal error") as
 * CALL_EXCEPTION. The base provider's nonRetryableErrors list includes CALL_EXCEPTION, so it
 * stops retrying and never switches to the next fallback provider, even though the failure was
 * a transient network issue rather than a real contract revert.
 */
export class PatchedFallbackProvider extends SimpleFallbackJsonRpcBatchProvider {
  isNonRetryableError(error: any): boolean {
    if (error?.code === 'CALL_EXCEPTION' && error?.error?.name === 'FetchError') {
      return false;
    }
    return super.isNonRetryableError(error);
  }
}
