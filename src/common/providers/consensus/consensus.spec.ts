import { Consensus, SupportedFork } from './consensus';

// ─── helpers ──────────────────────────────────────────────────────────────────

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const makeConfigService = () => ({
  get: jest.fn((key: string) => {
    const cfg: Record<string, any> = {
      CL_API_URLS: ['http://cl:5052'],
      CL_API_RESPONSE_TIMEOUT_MS: 10_000,
      CL_API_MAX_RETRIES: 1,
      CL_API_RETRY_DELAY_MS: 0,
      FORK_NAME: 'fulu',
    };
    return cfg[key];
  }),
});

/** Minimal BeaconConfig returned by /eth/v1/config/spec */
const BEACON_CONFIG = {
  SLOTS_PER_EPOCH: '32',
  SECONDS_PER_SLOT: '12',
  CAPELLA_FORK_EPOCH: '194048',
  ETH1_FOLLOW_DISTANCE: '2048',
  EPOCHS_PER_ETH1_VOTING_PERIOD: '64',
  SLOTS_PER_HISTORICAL_ROOT: '8192',
  MIN_VALIDATOR_WITHDRAWABILITY_DELAY: '256',
};

/** Genesis response */
const GENESIS = {
  genesis_time: '1606824023',
  genesis_validators_root: '0x' + '00'.repeat(32),
  genesis_fork_version: '0x00000000',
};

/**
 * Create a minimal Consensus instance and stub out onModuleInit network calls
 * so SSZ is loaded without making real HTTP requests.
 */
async function makeInitialisedConsensus() {
  const consensus = new (Consensus as any)(makeLogger(), undefined, makeConfigService()) as InstanceType<
    typeof Consensus
  > & { [k: string]: any };

  jest.spyOn(consensus, 'getGenesis').mockResolvedValue(GENESIS as any);
  jest.spyOn(consensus, 'getConfig').mockResolvedValue(BEACON_CONFIG as any);

  await consensus.onModuleInit();
  return consensus;
}

// ─── SupportedFork ────────────────────────────────────────────────────────────

describe('SupportedFork enum', () => {
  it('includes gloas', () => {
    expect(SupportedFork.gloas).toBe('gloas');
  });

  it('includes all pre-GLOAS forks', () => {
    expect(SupportedFork.capella).toBe('capella');
    expect(SupportedFork.deneb).toBe('deneb');
    expect(SupportedFork.electra).toBe('electra');
    expect(SupportedFork.fulu).toBe('fulu');
  });
});

// ─── getBlockInfo ─────────────────────────────────────────────────────────────

describe('Consensus.getBlockInfo', () => {
  let consensus: Awaited<ReturnType<typeof makeInitialisedConsensus>>;

  beforeAll(async () => {
    consensus = await makeInitialisedConsensus();
  });

  const stubBlockRequest = (forkName: string, blockJson: object) => {
    jest.spyOn(consensus, 'retryRequest').mockResolvedValue({
      body: { json: jest.fn().mockResolvedValue({ data: { message: blockJson } }) } as any,
      headers: { 'eth-consensus-version': forkName } as any,
    });
  };

  it('returns { block, forkName } for each supported fork', async () => {
    const testSsz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
    for (const fork of [SupportedFork.fulu, SupportedFork.gloas]) {
      // Use fulu minimal block JSON (gloas SSZ types = fulu in lodestar 1.34.x)
      const fuluBlock = testSsz.fulu.BeaconBlock.toJson(testSsz.fulu.BeaconBlock.defaultValue());
      stubBlockRequest(fork, fuluBlock as object);

      const result = await consensus.getBlockInfo('head');
      expect(result).toHaveProperty('block');
      expect(result).toHaveProperty('forkName', fork);
    }
  });

  it('throws when the fork name returned by the CL client is unsupported', async () => {
    jest.spyOn(consensus, 'retryRequest').mockResolvedValue({
      body: { json: jest.fn().mockResolvedValue({ data: { message: {} } }) } as any,
      headers: { 'eth-consensus-version': 'unknown_fork_xyz' } as any,
    });

    await expect(consensus.getBlockInfo('head')).rejects.toThrow('Fork name [unknown_fork_xyz] is not supported');
  });
});

// ─── getStateElBlockInfo ──────────────────────────────────────────────────────

describe('Consensus.getStateElBlockInfo', () => {
  let consensus: Awaited<ReturnType<typeof makeInitialisedConsensus>>;
  let ssz: Awaited<ReturnType<typeof import('@lodestar/types').then>>;

  beforeAll(async () => {
    consensus = await makeInitialisedConsensus();
    // eval() bypasses Jest's CommonJS resolver for this ESM-only package,
    // matching how consensus.ts itself loads the library in onModuleInit.
    ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  });

  const makeStateBytes = (forkName: keyof typeof ssz, blockHash: Uint8Array, blockNumber: number): Uint8Array => {
    const defaultState = (ssz[forkName] as any).BeaconState.defaultValue();
    defaultState.latestExecutionPayloadHeader.blockHash = blockHash;
    defaultState.latestExecutionPayloadHeader.blockNumber = blockNumber;
    return (ssz[forkName] as any).BeaconState.serialize(defaultState);
  };

  it('returns blockHash as a 0x-prefixed hex string', async () => {
    const expectedHash = new Uint8Array(32).fill(0xab);
    const stateBytes = makeStateBytes('fulu', expectedHash, 42);

    jest.spyOn(consensus, 'getState').mockResolvedValue({ bodyBytes: stateBytes, forkName: SupportedFork.fulu });

    const result = await consensus.getStateElBlockInfo('finalized');

    expect(result.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.blockHash).toBe('0x' + Buffer.from(expectedHash).toString('hex'));
  });

  it('returns blockNumber as a number', async () => {
    const stateBytes = makeStateBytes('fulu', new Uint8Array(32), 21_500_000);

    jest.spyOn(consensus, 'getState').mockResolvedValue({ bodyBytes: stateBytes, forkName: SupportedFork.fulu });

    const result = await consensus.getStateElBlockInfo('finalized');

    expect(result.blockNumber).toBe(21_500_000);
  });

  it('reads from latestExecutionPayloadHeader (not executionPayload in block body)', async () => {
    const KNOWN_HASH = new Uint8Array(32).fill(0xcc);
    const KNOWN_NUMBER = 99_999_999;
    const stateBytes = makeStateBytes('fulu', KNOWN_HASH, KNOWN_NUMBER);

    jest.spyOn(consensus, 'getState').mockResolvedValue({ bodyBytes: stateBytes, forkName: SupportedFork.fulu });

    const result = await consensus.getStateElBlockInfo('0xsome_state_root');

    expect(result.blockHash).toBe('0x' + Buffer.from(KNOWN_HASH).toString('hex'));
    expect(result.blockNumber).toBe(KNOWN_NUMBER);
  });

  it('passes the stateId through to getState', async () => {
    const stateBytes = makeStateBytes('fulu', new Uint8Array(32), 0);
    const getStateSpy = jest.spyOn(consensus, 'getState').mockResolvedValue({
      bodyBytes: stateBytes,
      forkName: SupportedFork.fulu,
    });

    await consensus.getStateElBlockInfo('0xmy_custom_state_root');

    expect(getStateSpy).toHaveBeenCalledWith('0xmy_custom_state_root');
  });

  it('propagates errors from getState', async () => {
    jest.spyOn(consensus, 'getState').mockRejectedValue(new Error('state fetch failed'));

    await expect(consensus.getStateElBlockInfo('finalized')).rejects.toThrow('state fetch failed');
  });

  it('works with the gloas fork name (same SSZ structure as fulu in lodestar 1.34.x)', async () => {
    const KNOWN_HASH = new Uint8Array(32).fill(0xde);
    const stateBytes = makeStateBytes('gloas', KNOWN_HASH, 777);

    jest.spyOn(consensus, 'getState').mockResolvedValue({ bodyBytes: stateBytes, forkName: SupportedFork.gloas });

    const result = await consensus.getStateElBlockInfo('head');

    expect(result.blockHash).toBe('0x' + Buffer.from(KNOWN_HASH).toString('hex'));
    expect(result.blockNumber).toBe(777);
  });
});
