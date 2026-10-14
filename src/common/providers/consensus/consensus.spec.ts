import { Consensus, SupportedFork } from './consensus';
import { RequestError } from '../base/rest-provider';

// @lodestar/types is ESM-only, so it is loaded the same way the services load it
const importSsz = async () => await eval(`import('@lodestar/types').then((m) => m.ssz)`);

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

const makeConsensus = () =>
  new (Consensus as any)(makeLogger(), undefined, makeConfigService()) as InstanceType<typeof Consensus> & {
    [k: string]: any;
  };

const makeHeader = (slot: number, root = `0xroot${slot}`, parentRoot = `0xroot${slot - 1}`) => ({
  root,
  canonical: true,
  header: {
    message: {
      slot: slot.toString(),
      proposer_index: '1',
      parent_root: parentRoot,
      state_root: `0xstate${slot}`,
      body_root: `0xbody${slot}`,
    },
    signature: '0xsig',
  },
});

const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const hex = (fill: number) => '0x' + Buffer.from(bytes(fill)).toString('hex');

describe('Consensus.getExecutionBlockHash', () => {
  let ssz: any;

  beforeAll(async () => {
    ssz = await importSsz();
  });

  it('reads the embedded execution payload before EIP-7732', async () => {
    const consensus = makeConsensus();
    const block = ssz.fulu.BeaconBlock.defaultValue();
    block.body.executionPayload.blockHash = bytes(0x11);
    jest.spyOn(consensus, 'getBlockInfo').mockResolvedValue({ block, forkName: SupportedFork.fulu });

    const blockHash = await consensus.getExecutionBlockHash(makeHeader(100));

    expect(blockHash).toBe(hex(0x11));
  });

  // After EIP-7732 the block only bids for a payload that is revealed later. The execution block
  // the CL block is anchored on is the one already settled in its state - `state.latest_block_hash`,
  // which the bid commits to as `parent_block_hash`. The block's own `bid.block_hash` is a promise
  // about a payload that may never be revealed, so it must not be used.
  it('reads the bid parent block hash from Gloas on, not the bid block hash', async () => {
    const consensus = makeConsensus();
    const block = ssz.gloas.BeaconBlock.defaultValue();
    block.body.signedExecutionPayloadBid.message.parentBlockHash = bytes(0x22);
    block.body.signedExecutionPayloadBid.message.blockHash = bytes(0x33);
    jest.spyOn(consensus, 'getBlockInfo').mockResolvedValue({ block, forkName: SupportedFork.gloas });

    const blockHash = await consensus.getExecutionBlockHash(makeHeader(100));

    expect(blockHash).toBe(hex(0x22));
    expect(blockHash).not.toBe(hex(0x33));
  });

  it('throws when a block carries neither an execution payload nor a bid', async () => {
    const consensus = makeConsensus();
    jest
      .spyOn(consensus, 'getBlockInfo')
      .mockResolvedValue({ block: { body: {} } as any, forkName: SupportedFork.gloas });

    await expect(consensus.getExecutionBlockHash(makeHeader(100))).rejects.toThrow(
      'neither an execution payload nor a payload bid',
    );
  });
});

describe('Consensus.findNextAvailableHeader', () => {
  // Real Hoodi history around the RootNotFound() incident: slot 3624534 was never proposed
  const PROPOSED_SLOT = 3624533;
  const MISSED_SLOT = 3624534;
  const NEXT_PROPOSED_SLOT = 3624535;

  const withMissedSlots = (missed: number[]) => {
    const consensus = makeConsensus();
    jest.spyOn(consensus, 'getBeaconHeader').mockImplementation(async (blockId: any) => {
      const slot = Number(blockId);
      if (missed.includes(slot)) {
        throw new RequestError(`NOT_FOUND: beacon block at slot ${slot}`, 404);
      }
      return makeHeader(slot) as any;
    });
    return consensus;
  };

  it('returns the requested slot when it was proposed', async () => {
    const consensus = withMissedSlots([]);

    const { slot } = await consensus.findNextAvailableHeader(PROPOSED_SLOT);

    expect(slot).toBe(PROPOSED_SLOT);
  });

  it('skips a run of missed slots', async () => {
    const consensus = withMissedSlots([MISSED_SLOT, NEXT_PROPOSED_SLOT]);

    const { slot, header } = await consensus.findNextAvailableHeader(MISSED_SLOT);

    expect(slot).toBe(NEXT_PROPOSED_SLOT + 1);
    expect(Number(header.header.message.slot)).toBe(NEXT_PROPOSED_SLOT + 1);
  });

  it('rethrows errors that are not a missed slot', async () => {
    const consensus = makeConsensus();
    jest.spyOn(consensus, 'getBeaconHeader').mockRejectedValue(new RequestError('BAD_GATEWAY', 502));

    await expect(consensus.findNextAvailableHeader(PROPOSED_SLOT)).rejects.toThrow('BAD_GATEWAY');
  });

  it('gives up after the requested number of attempts', async () => {
    const consensus = makeConsensus();
    jest.spyOn(consensus, 'getBeaconHeader').mockRejectedValue(new RequestError('NOT_FOUND', 404));

    await expect(consensus.findNextAvailableHeader(PROPOSED_SLOT, 3)).rejects.toThrow(
      'Failed to find available slot after 3 attempts',
    );
  });
});
