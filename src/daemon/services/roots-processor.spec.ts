import { RootsProcessor } from './roots-processor';

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const makePrometheus = () => ({
  blockRangeProcessingDuration: { startTimer: jest.fn(() => jest.fn()) },
  blockRangeSize: { observe: jest.fn() },
  // Used by the @TrackTask decorator on process()
  taskDuration: { startTimer: jest.fn(() => jest.fn()) },
  taskCount: { inc: jest.fn() },
});

const makeHeader = (slot: number, root = `0xroot${slot}`) => ({
  root,
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

const makeService = (overrides: Record<string, any> = {}) => {
  const consensus = { getExecutionBlockHash: jest.fn(), ...overrides.consensus };
  const provider = { getBlock: jest.fn(), ...overrides.provider };
  const prover = { handleBlock: jest.fn(), ...overrides.prover };
  const lastProcessedRoot = { get: jest.fn(), set: jest.fn(), ...overrides.lastProcessedRoot };

  const service = new (RootsProcessor as any)(
    makeLogger(), // logger
    {}, // config
    makePrometheus(), // prometheus
    consensus, // consensus
    lastProcessedRoot, // lastProcessedRoot
    prover, // prover
    provider, // provider
    {}, // exitRequests
  );

  return { service, consensus, provider, prover, lastProcessedRoot };
};

const PREV_SLOT = 3_624_000;
const FINALIZED_SLOT = 3_624_533;

/** EL blocks the two CL blocks are anchored on */
const anchors: Record<string, { hash: string; number: number }> = {
  [`0xroot${PREV_SLOT}`]: { hash: '0xprevel', number: 3_046_593 },
  [`0xroot${FINALIZED_SLOT}`]: { hash: '0xfinalizedel', number: 3_343_347 },
};

const withAnchors = () =>
  makeService({
    consensus: {
      getExecutionBlockHash: jest.fn(async (header: any) => anchors[header.root].hash),
    },
    provider: {
      getBlock: jest.fn(async (hash: string) => {
        const anchor = Object.values(anchors).find((a) => a.hash === hash);
        return anchor ? { number: anchor.number } : null;
      }),
    },
  });

describe('RootsProcessor.process', () => {
  // The EL anchor of a CL block is fork-dependent (embedded payload before EIP-7732, payload bid
  // after), which is why it is resolved by the consensus provider - the daemon only turns the
  // resulting hashes into the block range to scan for exit requests.
  it('scans the EL range between the anchors of the two CL blocks', async () => {
    const { service, prover } = withAnchors();

    await service.process(makeHeader(PREV_SLOT), makeHeader(FINALIZED_SLOT));

    expect(prover.handleBlock).toHaveBeenCalledWith(3_046_593, 3_343_347);
  });

  it('stores the finalized root as processed', async () => {
    const { service, lastProcessedRoot } = withAnchors();

    await service.process(makeHeader(PREV_SLOT), makeHeader(FINALIZED_SLOT));

    expect(lastProcessedRoot.set).toHaveBeenCalledWith({
      root: `0xroot${FINALIZED_SLOT}`,
      slot: FINALIZED_SLOT,
    });
  });

  it('does not store the root when processing failed', async () => {
    const { service, lastProcessedRoot } = makeService({
      consensus: { getExecutionBlockHash: jest.fn(async (header: any) => anchors[header.root].hash) },
      provider: { getBlock: jest.fn(async () => ({ number: 1 })) },
      prover: { handleBlock: jest.fn().mockRejectedValue(new Error('boom')) },
    });

    await expect(service.process(makeHeader(PREV_SLOT), makeHeader(FINALIZED_SLOT))).rejects.toThrow('boom');
    expect(lastProcessedRoot.set).not.toHaveBeenCalled();
  });

  it('fails loudly when the EL node does not know the anchored block', async () => {
    const { service } = makeService({
      consensus: { getExecutionBlockHash: jest.fn(async () => '0xunknown') },
      provider: { getBlock: jest.fn(async () => null) },
    });

    await expect(service.process(makeHeader(PREV_SLOT), makeHeader(FINALIZED_SLOT))).rejects.toThrow(
      'is unknown to the EL node',
    );
  });
});
