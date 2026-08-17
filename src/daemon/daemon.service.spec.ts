import { DaemonService } from './daemon.service';
import { ChainNotReadyError } from '../common/errors/chain-not-ready.error';

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const makeHeader = (root: string, slot: number) => ({
  root,
  canonical: true,
  header: { message: { slot: slot.toString(), proposer_index: '1' }, signature: '0xsig' },
});

const makeService = ({ roots = undefined as any, processImpl = jest.fn() } = {}) => {
  const logger = makeLogger();
  const prometheus = {
    rootsProcessingDuration: { startTimer: jest.fn(() => jest.fn()) },
    daemonSleepCount: { inc: jest.fn() },
    rootsSameCount: { inc: jest.fn() },
    latestSuccessRun: { setToCurrentTime: jest.fn() },
  };

  const service = new (DaemonService as any)(
    logger, // logger
    { get: jest.fn(() => 0) }, // config - zero sleep interval
    prometheus, // prometheus
    {}, // consensus
    {}, // execution
    { getRoots: jest.fn(async () => roots) }, // rootsProvider
    { process: processImpl }, // rootsProcessor
  );

  return { service, logger, prometheus, processImpl };
};

const TRANSITION = {
  prev: makeHeader('0xprev', 100),
  latest: makeHeader('0xlatest', 200),
};

describe('DaemonService.baseRun', () => {
  it('processes a roots transition and marks the cycle successful', async () => {
    const { service, logger, prometheus } = makeService({ roots: TRANSITION });

    await (service as any).baseRun();

    expect(prometheus.latestSuccessRun.setToCurrentTime).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // Waiting is not a completed cycle: bumping the success timestamp here would make a bot stuck
  // for hours indistinguishable from a healthy idle one.
  it('does not mark the cycle successful when there are no roots to work with', async () => {
    const { service, logger, prometheus } = makeService({ roots: undefined });

    await (service as any).baseRun();

    expect(prometheus.latestSuccessRun.setToCurrentTime).not.toHaveBeenCalled();
    expect(prometheus.daemonSleepCount.inc).toHaveBeenCalledWith({ reason: 'no_new_roots' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('marks the cycle successful when already caught up', async () => {
    const caughtUp = { prev: TRANSITION.latest, latest: TRANSITION.latest };
    const { service, prometheus } = makeService({ roots: caughtUp });

    await (service as any).baseRun();

    expect(prometheus.latestSuccessRun.setToCurrentTime).toHaveBeenCalled();
    expect(prometheus.daemonSleepCount.inc).toHaveBeenCalledWith({ reason: 'caught_up' });
  });

  // A chain the EL cannot anchor yet is not a failure: hold the state, warn once, wait.
  it('waits instead of failing when the chain is not ready', async () => {
    const processImpl = jest.fn(async () => {
      throw new ChainNotReadyError('Execution block [0x00] anchored at slot [0] is unknown to the EL node');
    });
    const { service, logger, prometheus } = makeService({ roots: TRANSITION, processImpl });

    await expect((service as any).baseRun()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Chain is not ready'));
    expect(logger.error).not.toHaveBeenCalled();
    expect(prometheus.daemonSleepCount.inc).toHaveBeenCalledWith({ reason: 'chain_not_ready' });
    expect(prometheus.latestSuccessRun.setToCurrentTime).not.toHaveBeenCalled();
  });

  it('still fails loudly on any other error', async () => {
    const processImpl = jest.fn(async () => {
      throw new Error('boom');
    });
    const { service, logger, prometheus } = makeService({ roots: TRANSITION, processImpl });

    await expect((service as any).baseRun()).rejects.toThrow('boom');

    expect(logger.error).toHaveBeenCalledWith('Failed to process roots', expect.anything());
    expect(prometheus.daemonSleepCount.inc).not.toHaveBeenCalledWith({ reason: 'chain_not_ready' });
  });
});
