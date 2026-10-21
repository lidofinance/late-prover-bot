/**
 * An execution anchor is not known to the EL node yet: the chain is younger than the lookback
 * window, the node is syncing, or the history is pruned. The daemon waits instead of failing.
 */
export class ChainNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainNotReadyError';
  }
}
