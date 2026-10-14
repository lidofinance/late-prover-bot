import { RootsProvider } from './roots-provider';
import { RequestError } from '../../common/providers/base/rest-provider';

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const GENESIS = 1742213400;
const SECONDS_PER_SLOT = 12;
const NOW_SLOT = 400_000;
const LOOKBACK_DAYS = 7;
const LOOKBACK_SLOTS = (LOOKBACK_DAYS * 24 * 60 * 60) / SECONDS_PER_SLOT;
const LOOKBACK_SLOT = NOW_SLOT - LOOKBACK_SLOTS;

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
const makeService = ({ headSlot = NOW_SLOT, missed = [] as number[], lastProcessed = null as any } = {}) => {
  jest.setSystemTime((GENESIS + headSlot * SECONDS_PER_SLOT) * 1000);

  const nextProposed = (slot: number) => {
    let current = slot;
    while (missed.includes(current)) current++;
    return current;
  };

  const consensus = {
    timestampToSlot: (ts: number) => Math.floor((ts - GENESIS) / SECONDS_PER_SLOT),
    getBeaconHeader: jest.fn(async (blockId: string) => {
      if (blockId === 'finalized') return makeHeader(headSlot - 64);
      const slot = Number(blockId);
      if (Number.isNaN(slot)) return makeHeader(headSlot - 1000); // by root
      if (missed.includes(slot)) throw new RequestError(`NOT_FOUND: slot ${slot}`, 404);
      return makeHeader(slot);
    }),
    findNextAvailableHeader: jest.fn(async (startSlot: number) => {
      // What a CL answers for a slot that cannot exist.
      if (startSlot < 0) throw new RequestError(`Request failed with status code [400]`, 400);
      const slot = nextProposed(startSlot);
      return { slot, header: makeHeader(slot) };
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

  it('starts from the last processed root when there is one', async () => {
    const { service } = makeService({ lastProcessed: { root: '0xstored', slot: NOW_SLOT - 500 } });

    const roots = await service.getRoots();

    expect(roots?.prev.root).toBe(`0xroot${NOW_SLOT - 1000}`);
    expect(roots?.latest.root).toBe(`0xroot${NOW_SLOT - 64}`);
  });

  it('falls back to the lookback slot when nothing was processed yet', async () => {
    const { service } = makeService();

    const roots = await service.getRoots();

    expect(roots?.prev.root).toBe(`0xroot${LOOKBACK_SLOT}`);
  });

  // Asking for a missed slot 404s. Before the forward scan that returned no previous root at all, so
  // the daemon would idle cycle after cycle - and missed slots are common on an ePBS chain.
  it('scans forward when the lookback slot was never proposed', async () => {
    const { service } = makeService({ missed: [LOOKBACK_SLOT, LOOKBACK_SLOT + 1, LOOKBACK_SLOT + 2] });

    const roots = await service.getRoots();

    expect(roots?.prev.root).toBe(`0xroot${LOOKBACK_SLOT + 3}`);
  });

  // A chain younger than the lookback window puts the computed slot before genesis. Unclamped, the
  // CL rejects it with a 400 on every cycle and the daemon never gets a previous root. Slot 0 is no
  // good either: the genesis block hashes to a zero execution block that no EL node knows.
  it('clamps the lookback slot to the first anchorable slot on a chain younger than the window', async () => {
    const { service, consensus, logger } = makeService({ headSlot: LOOKBACK_SLOTS / 2 });

    const roots = await service.getRoots();

    expect(consensus.findNextAvailableHeader).toHaveBeenCalledWith(1);
    expect(roots?.prev.root).toBe('0xroot1');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
