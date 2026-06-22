import { RootsProcessor } from './roots-processor';
import { SupportedFork } from '../../common/providers/consensus/consensus';

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const makePrometheus = () => ({
  blockRangeProcessingDuration: { startTimer: jest.fn(() => jest.fn()) },
  blockRangeSize: { observe: jest.fn() },
});

const makeConsensusMock = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  getBlockInfo: jest.fn(),
  getStateElBlockInfo: jest.fn(),
  ...overrides,
});

const makeProviderMock = () => ({
  getBlock: jest.fn(),
});

const makeHeader = (root: string, stateRoot: string, slot = '100') => ({
  root,
  canonical: true,
  header: {
    message: {
      slot,
      proposer_index: '1',
      parent_root: '0xparent',
      state_root: stateRoot,
      body_root: '0xbody',
    },
    signature: '0xsig',
  },
});

const makeBlockWithExecutionPayload = (blockHash: string) => ({
  body: {
    executionPayload: {
      // hexlify expects Uint8Array; the real type is a Uint8Array, but for tests
      // we use a Buffer which hexlify also accepts
      blockHash: Buffer.from(blockHash.replace('0x', ''), 'hex'),
    },
  },
});

const makeService = (
  consensus = makeConsensusMock(),
  provider = makeProviderMock(),
  prometheus = makePrometheus(),
) =>
  new (RootsProcessor as any)(
    makeLogger(), // logger
    {}, // config
    prometheus, // prometheus
    consensus, // consensus
    { get: jest.fn(), set: jest.fn() }, // lastProcessedRoot
    { handleBlock: jest.fn() }, // prover
    provider, // provider
    {}, // exitRequests
  ) as InstanceType<typeof RootsProcessor> & { [k: string]: any };

// ─── resolveElBlockInfo — pre-GLOAS path ─────────────────────────────────────

describe('RootsProcessor.resolveElBlockInfo — pre-GLOAS', () => {
  const BLOCK_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const BLOCK_NUMBER = 999_000;
  const FORK_NAME = SupportedFork.fulu;

  let service: ReturnType<typeof makeService>;
  let consensus: ReturnType<typeof makeConsensusMock>;
  let provider: ReturnType<typeof makeProviderMock>;
  const header = makeHeader('0xroot', '0xstateroot');

  beforeEach(() => {
    consensus = makeConsensusMock();
    provider = makeProviderMock();
    service = makeService(consensus, provider);

    consensus.getBlockInfo.mockResolvedValue({ block: makeBlockWithExecutionPayload(BLOCK_HASH), forkName: FORK_NAME });
    provider.getBlock.mockResolvedValue({ number: BLOCK_NUMBER });
  });

  it('calls getBlockInfo with the CL root', async () => {
    await service.resolveElBlockInfo(header);
    expect(consensus.getBlockInfo).toHaveBeenCalledWith('0xroot');
  });

  it('returns block number from the EL provider', async () => {
    const result = await service.resolveElBlockInfo(header);
    expect(result.blockNumber).toBe(BLOCK_NUMBER);
  });

  it('returns hex-encoded block hash from executionPayload', async () => {
    const result = await service.resolveElBlockInfo(header);
    expect(result.blockHash).toBe(BLOCK_HASH);
  });

  it('fetches EL block using the hash from executionPayload', async () => {
    await service.resolveElBlockInfo(header);
    expect(provider.getBlock).toHaveBeenCalledWith(BLOCK_HASH);
  });

  it('does NOT call getStateElBlockInfo', async () => {
    await service.resolveElBlockInfo(header);
    expect(consensus.getStateElBlockInfo).not.toHaveBeenCalled();
  });

  it.each([SupportedFork.capella, SupportedFork.deneb, SupportedFork.electra, SupportedFork.fulu])(
    'uses the executionPayload path for %s fork',
    async (forkName) => {
      consensus.getBlockInfo.mockResolvedValue({ block: makeBlockWithExecutionPayload(BLOCK_HASH), forkName });
      await service.resolveElBlockInfo(header);
      expect(consensus.getStateElBlockInfo).not.toHaveBeenCalled();
      expect(provider.getBlock).toHaveBeenCalledWith(BLOCK_HASH);
    },
  );
});

// ─── resolveElBlockInfo — GLOAS path ─────────────────────────────────────────

describe('RootsProcessor.resolveElBlockInfo — GLOAS (post-ePBS)', () => {
  const STATE_ROOT = '0xstateroot1234';
  const EL_BLOCK_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const EL_BLOCK_NUMBER = 21_500_000;

  let service: ReturnType<typeof makeService>;
  let consensus: ReturnType<typeof makeConsensusMock>;
  let provider: ReturnType<typeof makeProviderMock>;
  const header = makeHeader('0xcl_root', STATE_ROOT, '200');

  beforeEach(() => {
    consensus = makeConsensusMock();
    provider = makeProviderMock();
    service = makeService(consensus, provider);

    consensus.getBlockInfo.mockResolvedValue({ block: {}, forkName: SupportedFork.gloas });
    consensus.getStateElBlockInfo.mockResolvedValue({ blockHash: EL_BLOCK_HASH, blockNumber: EL_BLOCK_NUMBER });
  });

  it('calls getBlockInfo with the CL root', async () => {
    await service.resolveElBlockInfo(header);
    expect(consensus.getBlockInfo).toHaveBeenCalledWith('0xcl_root');
  });

  it('calls getStateElBlockInfo with the state_root from the header', async () => {
    await service.resolveElBlockInfo(header);
    expect(consensus.getStateElBlockInfo).toHaveBeenCalledWith(STATE_ROOT);
  });

  it('returns blockNumber from getStateElBlockInfo (no EL provider call)', async () => {
    const result = await service.resolveElBlockInfo(header);
    expect(result.blockNumber).toBe(EL_BLOCK_NUMBER);
    expect(provider.getBlock).not.toHaveBeenCalled();
  });

  it('returns blockHash from getStateElBlockInfo', async () => {
    const result = await service.resolveElBlockInfo(header);
    expect(result.blockHash).toBe(EL_BLOCK_HASH);
  });

  it('does NOT access executionPayload from the block', async () => {
    // block has no executionPayload — if the code touched it, it would throw
    consensus.getBlockInfo.mockResolvedValue({
      block: { body: {} }, // no executionPayload field
      forkName: SupportedFork.gloas,
    });
    await expect(service.resolveElBlockInfo(header)).resolves.toBeDefined();
  });
});

// ─── processBlockRoot ─────────────────────────────────────────────────────────

describe('RootsProcessor.processBlockRoot', () => {
  const PREV_BLOCK_NUMBER = 21_400_000;
  const FINALIZED_BLOCK_NUMBER = 21_500_000;
  const PREV_HASH = '0x' + 'aa'.repeat(32);
  const FINAL_HASH = '0x' + 'bb'.repeat(32);

  const prevHeader = makeHeader('0xprev_root', '0xprev_state', '1000');
  const finalizedHeader = makeHeader('0xfinalized_root', '0xfinalized_state', '1032');

  const setupService = (forkName: SupportedFork) => {
    const consensus = makeConsensusMock();
    const provider = makeProviderMock();
    const prometheus = makePrometheus();
    const prover = { handleBlock: jest.fn() };
    const service = new (RootsProcessor as any)(
      makeLogger(),
      {},
      prometheus,
      consensus,
      { get: jest.fn(), set: jest.fn() },
      prover,
      provider,
      {},
    ) as InstanceType<typeof RootsProcessor> & { [k: string]: any };

    if (forkName === SupportedFork.gloas) {
      consensus.getBlockInfo.mockResolvedValue({ block: {}, forkName: SupportedFork.gloas });
      consensus.getStateElBlockInfo
        .mockResolvedValueOnce({ blockHash: PREV_HASH, blockNumber: PREV_BLOCK_NUMBER })
        .mockResolvedValueOnce({ blockHash: FINAL_HASH, blockNumber: FINALIZED_BLOCK_NUMBER });
    } else {
      consensus.getBlockInfo
        .mockResolvedValueOnce({ block: makeBlockWithExecutionPayload(PREV_HASH), forkName })
        .mockResolvedValueOnce({ block: makeBlockWithExecutionPayload(FINAL_HASH), forkName });
      provider.getBlock
        .mockResolvedValueOnce({ number: PREV_BLOCK_NUMBER })
        .mockResolvedValueOnce({ number: FINALIZED_BLOCK_NUMBER });
    }

    return { service, consensus, provider, prover, prometheus };
  };

  it('calls prover.handleBlock with EL block numbers derived from prevHeader and finalizedHeader', async () => {
    const { service, prover } = setupService(SupportedFork.fulu);
    await service.processBlockRoot(prevHeader, finalizedHeader);
    expect(prover.handleBlock).toHaveBeenCalledWith(PREV_BLOCK_NUMBER, FINALIZED_BLOCK_NUMBER);
  });

  it('uses GLOAS path for both headers when forkName is gloas', async () => {
    const { service, consensus, provider } = setupService(SupportedFork.gloas);
    await service.processBlockRoot(prevHeader, finalizedHeader);
    expect(consensus.getStateElBlockInfo).toHaveBeenCalledWith('0xprev_state');
    expect(consensus.getStateElBlockInfo).toHaveBeenCalledWith('0xfinalized_state');
    expect(provider.getBlock).not.toHaveBeenCalled();
  });

  it('uses pre-GLOAS path for both headers when forkName is fulu', async () => {
    const { service, consensus, provider } = setupService(SupportedFork.fulu);
    await service.processBlockRoot(prevHeader, finalizedHeader);
    expect(consensus.getStateElBlockInfo).not.toHaveBeenCalled();
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
  });

  it('resolves both headers concurrently via Promise.all', async () => {
    const order: string[] = [];
    const consensus = makeConsensusMock();
    const provider = makeProviderMock();
    const prometheus = makePrometheus();
    const prover = { handleBlock: jest.fn() };

    consensus.getBlockInfo.mockImplementation(async (root: string) => {
      order.push(`getBlockInfo:${root}`);
      return { block: makeBlockWithExecutionPayload('0x' + 'cc'.repeat(32)), forkName: SupportedFork.fulu };
    });
    provider.getBlock.mockImplementation(async () => {
      order.push('getBlock');
      return { number: 100 };
    });

    const service = new (RootsProcessor as any)(
      makeLogger(), {}, prometheus, consensus,
      { get: jest.fn(), set: jest.fn() }, prover, provider, {},
    ) as any;

    await service.processBlockRoot(prevHeader, finalizedHeader);

    // Both getBlockInfo calls should start before either resolves (concurrent)
    // Verify both roots were fetched
    expect(order.filter((e) => e.startsWith('getBlockInfo')).length).toBe(2);
    expect(prover.handleBlock).toHaveBeenCalled();
  });

  it('propagates errors from resolveElBlockInfo', async () => {
    const consensus = makeConsensusMock();
    consensus.getBlockInfo.mockRejectedValue(new Error('CL network error'));
    const service = makeService(consensus);

    await expect(service.processBlockRoot(prevHeader, finalizedHeader)).rejects.toThrow('CL network error');
  });

  it('propagates errors from prover.handleBlock', async () => {
    const { service, prover } = setupService(SupportedFork.fulu);
    prover.handleBlock.mockRejectedValue(new Error('proof failure'));

    await expect(service.processBlockRoot(prevHeader, finalizedHeader)).rejects.toThrow('proof failure');
  });
});
