/**
 * The chain cannot be processed yet, through no fault of the bot: an execution anchor the daemon
 * needs is not (or not yet) known to the EL node - a chain younger than the lookback window, a node
 * still syncing, pruned history.
 *
 * Thrown instead of a plain Error so the daemon can hold its state and wait for the next cycle
 * rather than treating it as a failure.
 */
export class ChainNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainNotReadyError';
  }
}
