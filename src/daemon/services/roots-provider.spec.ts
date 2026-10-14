import { RootsProvider } from './roots-provider';
import { RequestError } from '../../common/providers/base/rest-provider';

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const GENESIS = 1742213400;
const SECONDS_PER_SLOT = 12;
const LOOKBACK_DAYS = 7;
const LOOKBACK_SLOTS = (LOOKBACK_DAYS * 24 * 60 * 60) / SECONDS_PER_SLOT;

const makeHeader = (slot: number) => ({
  root: `0xroot${slot}`,
  canonical: true,
  header: {
    message: {
      slot: slot.toString(),
      proposer_index: '1',
      parent_root: `0xroot${slot - 1}`,
      state_root: `0xstate${slot}`,
      body_root: `0xbody${slot}`,
    },
    signature: '0xsig',
  },
});

// headSlot doubles as the chain age in slots: the system clock is moved to that slot.
const makeService = ({ headSlot, lastProcessed = null as any }: { headSlot: number; lastProcessed?: any }) => {
  jest.setSystemTime((GENESIS + headSlot * SECONDS_PER_SLOT) * 1000);

  const consensus = {
    timestampToSlot: (ts: number) => Math.floor((ts - GENESIS) / SECONDS_PER_SLOT),
    getBeaconHeader: jest.fn(async (blockId: string) => {
      if (blockId === 'finalized') return makeHeader(headSlot - 64);
      const slot = Number(blockId);
      if (Number.isNaN(slot)) return makeHeader(headSlot - 1000); // by root
      // What a CL answers for a slot that cannot exist.
      if (slot < 0) throw new RequestError(`Request failed with status code [400]`, 400);
      return makeHeader(slot);
    }),
  };

  const logger = makeLogger();

  const service = new (RootsProvider as any)(
    logger, // logger
    { get: jest.fn(() => LOOKBACK_DAYS) }, // config
    consensus, // consensus
    { latestSlot: { set: jest.fn() } }, // prometheus
    { get: jest.fn(async () => lastProcessed) }, // lastProcessedRoot
  );

  return { service, consensus, logger };
};

describe('RootsProvider.getRoots', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('falls back to the lookback slot when nothing was processed yet', async () => {
    const headSlot = 400_000;
    const { service, consensus } = makeService({ headSlot });

    const roots = await service.getRoots();

    expect(consensus.getBeaconHeader).toHaveBeenCalledWith(String(headSlot - LOOKBACK_SLOTS));
    expect(roots?.prev.root).toBe(`0xroot${headSlot - LOOKBACK_SLOTS}`);
    expect(roots?.latest.root).toBe(`0xroot${headSlot - 64}`);
  });

  // A chain younger than the lookback window puts the computed slot before genesis. Unclamped, the
  // CL rejects it with a 400 on every cycle and the daemon never gets a previous root. Slot 0 is no
  // good either: the genesis block hashes to a zero execution block that no EL node knows.
  it('clamps the lookback slot to the first anchorable slot on a chain younger than the window', async () => {
    const headSlot = LOOKBACK_SLOTS / 2;
    const { service, consensus, logger } = makeService({ headSlot });

    const roots = await service.getRoots();

    expect(consensus.getBeaconHeader).toHaveBeenCalledWith('1');
    expect(consensus.getBeaconHeader).not.toHaveBeenCalledWith('0');
    expect(roots?.prev.root).toBe('0xroot1');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
