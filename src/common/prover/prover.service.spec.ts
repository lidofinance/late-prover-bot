import { ProverService } from './prover.service';
import { RequestError } from '../providers/base/rest-provider';

// Minimal prometheus mock covering every counter/timer used in processValidator
const makePrometheusMock = () => ({
  validatorProcessingDuration: { startTimer: jest.fn(() => jest.fn()) },
  exitAlreadyProcessedCount: { inc: jest.fn() },
  exitInitiatedCount: { inc: jest.fn() },
  validatorsSkippedCount: { inc: jest.fn() },
  exitDeadlineFutureCount: { inc: jest.fn() },
  validatorsEligibleCount: { set: jest.fn() },
  validatorsProcessedCount: { inc: jest.fn() },
  validatorsPenaltyApplicableCount: { inc: jest.fn() },
  proofGenerationDuration: { startTimer: jest.fn(() => jest.fn()) },
  proofGenerationCount: { inc: jest.fn() },
});

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

// Minimal validator input as returned by decodeValidatorsData
const makeValidatorInput = (
  overrides: Partial<{ validatorIndex: bigint; moduleId: bigint; nodeOpId: bigint; validatorPubkey: string }> = {},
) => ({
  validatorIndex: BigInt(1039010),
  moduleId: BigInt(1),
  nodeOpId: BigInt(42),
  validatorPubkey: '0xaabbcc',
  exitDataIndex: 0,
  ...overrides,
});

// Minimal stateView mock: returns a validator with a given exitEpoch
const makeStateView = (exitEpoch: number | typeof Infinity) => ({
  validators: {
    getReadonly: jest.fn(() => ({
      exitEpoch,
      withdrawalCredentials: new Uint8Array(32),
      effectiveBalance: BigInt(32_000_000_000),
      slashed: false,
      activationEligibilityEpoch: 244578,
      activationEpoch: 244687,
      withdrawableEpoch: Infinity,
    })),
  },
});

// Build a ProverService instance with all deps stubbed out
const makeService = (overrides: Record<string, any> = {}) => {
  const consensus = {
    genesisTimestamp: 1606824023,
    beaconConfig: { SLOTS_PER_EPOCH: 32, SECONDS_PER_SLOT: 12 },
    slotToTimestamp: jest.fn((slot: number) => 1606824023 + slot * 12),
    ...overrides.consensus,
  };

  const service = new (ProverService as any)(
    makeLogger(), // loggerService
    consensus, // consensus
    {}, // exitRequests
    {}, // verifier
    {}, // stakingRouter
    overrides.execution ?? {}, // execution
    makePrometheusMock(), // prometheus
    {}, // config
    50, // validatorBatchSize
  );

  // Set private fields that are normally initialised in onModuleInit
  service.SHARD_COMMITTEE_PERIOD_IN_SECONDS = 2_764_800; // 256 epochs × 32 slots × 12 s

  return service;
};

// ─── processValidator — exit epoch filtering ──────────────────────────────────

describe('ProverService.processValidator - exit epoch filtering', () => {
  const DEADLINE_EPOCH = 443778; // epoch of deadline slot 14200917
  const PROOF_SLOT_TIMESTAMP = 1_777_235_027; // timestamp of slot 14200917
  const ACTIVATION_EPOCH = 244687;
  const DELIVERED_TIMESTAMP = 1_776_000_000; // far enough in the past

  const callProcessValidator = (service: any, exitEpoch: number | typeof Infinity) =>
    (service as any).processValidator(
      makeValidatorInput(),
      ACTIVATION_EPOCH,
      DEADLINE_EPOCH,
      makeStateView(exitEpoch),
      PROOF_SLOT_TIMESTAMP,
      DELIVERED_TIMESTAMP,
      0, // fromBlock
      100, // toBlock
    );

  it('returns null when exitEpoch < exitDeadlineEpoch (validator already exited before deadline)', async () => {
    const service = makeService();
    const result = await callProcessValidator(service, DEADLINE_EPOCH - 1);
    expect(result).toBeNull();
  });

  it('returns null when exitEpoch equals exitDeadlineEpoch (exited exactly at deadline boundary)', async () => {
    const service = makeService();
    const result = await callProcessValidator(service, DEADLINE_EPOCH);
    // DEADLINE_EPOCH is NOT < DEADLINE_EPOCH, so falls through to the new Infinity check
    // exitEpoch (443778) !== Infinity → skipped
    expect(result).toBeNull();
  });

  it('returns null when exitEpoch > exitDeadlineEpoch but is not Infinity (exit initiated after deadline)', async () => {
    const service = makeService();
    // This is the exact case that caused InvalidProof(): exit_epoch=443824, deadline=443778
    const result = await callProcessValidator(service, 443824);
    expect(result).toBeNull();
  });

  it('increments exit_initiated skip counter when exitEpoch is set but >= deadline', async () => {
    const prometheus = makePrometheusMock();
    const service = makeService();
    service.prometheus = prometheus;

    await callProcessValidator(service, 443824);

    expect(prometheus.validatorsSkippedCount.inc).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit_initiated' }),
    );
  });

  it('does NOT increment exit_initiated counter when exitEpoch < deadline (uses already_exited reason)', async () => {
    const prometheus = makePrometheusMock();
    const service = makeService();
    service.prometheus = prometheus;

    await callProcessValidator(service, DEADLINE_EPOCH - 1);

    expect(prometheus.validatorsSkippedCount.inc).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'already_exited' }),
    );
    expect(prometheus.validatorsSkippedCount.inc).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit_initiated' }),
    );
  });

  it('proceeds past the exit epoch checks when exitEpoch is Infinity (FAR_FUTURE_EPOCH)', async () => {
    const service = makeService();
    // proofSlotTimestamp is set so that the validator is not yet eligible,
    // triggering the 'not_eligible_yet' early return — confirms the exit epoch
    // checks were both passed (the method went further into the function).
    const tooEarlyTimestamp = 0;
    const result = await (service as any).processValidator(
      makeValidatorInput(),
      ACTIVATION_EPOCH,
      DEADLINE_EPOCH,
      makeStateView(Infinity),
      tooEarlyTimestamp,
      DELIVERED_TIMESTAMP,
      0,
      100,
    );
    expect(result).toBeNull(); // skipped for not_eligible_yet, not exit epoch reasons
    expect(service.prometheus.validatorsSkippedCount.inc).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'not_eligible_yet' }),
    );
    expect(service.prometheus.validatorsSkippedCount.inc).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit_initiated' }),
    );
    expect(service.prometheus.validatorsSkippedCount.inc).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'already_exited' }),
    );
  });
});

// ─── decodeValidatorsData ─────────────────────────────────────────────────────

describe('ProverService.decodeValidatorsData', () => {
  const decode = (hex: string, dataFormat: number) => (makeService() as any).decodeValidatorsData(hex, dataFormat);

  // Real tx 0xaa8dad0ec045cf251ed2c530e25c139dd71bd6dea35a99230715a40ae613b822
  // submitReportData on Hoodi (chain 559024), block 2894999
  // dataFormat=2 (DATA_FORMAT_LIST_WITH_KEY_INDEX), requestsCount=1
  const REAL_TX_DATA_FORMAT_2 =
    '0x' +
    '000001' + // moduleId = 1  (3 bytes)
    '0000000007' + // nodeOpId = 7  (5 bytes)
    '0000000000103f8e' + // validatorIndex = 1064846  (8 bytes)
    '0000000000000009' + // keyIndex = 9  (8 bytes)  ← format-2 extra field
    'ae2fd379751dc0256d7ea54eca4d14f8456aec60bcd55397f17f2f01fee04381f5ee7c388ef1bcf0a53f9c5520798eba'; // pubkey (48 bytes)

  it('format 2: correctly decodes the 72-byte real-world entry (regression for BigInt crash)', () => {
    const entries = decode(REAL_TX_DATA_FORMAT_2, 2);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      exitDataIndex: 0,
      moduleId: BigInt(1),
      nodeOpId: BigInt(7),
      validatorIndex: BigInt(1064846),
      validatorPubkey:
        '0xae2fd379751dc0256d7ea54eca4d14f8456aec60bcd55397f17f2f01fee04381f5ee7c388ef1bcf0a53f9c5520798eba',
    });
  });

  it('format 2: old ENTRY_SIZE=64 code would have thrown "Cannot convert 0x to a BigInt"', () => {
    // Manually reproduce the old broken behaviour so the regression is documented
    const hex = REAL_TX_DATA_FORMAT_2.slice(2); // strip 0x
    const data = Buffer.from(hex, 'hex');
    expect(data.byteLength).toBe(72);

    const ENTRY_SIZE_OLD = 64;
    const entries = [];
    for (let offset = 0; offset < data.byteLength; offset += ENTRY_SIZE_OLD) {
      const entry = data.subarray(offset, offset + ENTRY_SIZE_OLD);
      if (offset > 0) {
        // second iteration: entry is 8 bytes, subarray(8,16) is empty → BigInt crash
        expect(entry.subarray(8, 16).toString('hex')).toBe('');
        expect(() => BigInt('0x' + entry.subarray(8, 16).toString('hex'))).toThrow(SyntaxError);
        break;
      }
      entries.push(entry);
    }
  });

  it('format 2: correctly assigns exitDataIndex when multiple 72-byte entries are present', () => {
    // Two identical entries back-to-back
    const single = REAL_TX_DATA_FORMAT_2.slice(2); // strip 0x
    const twoEntries = '0x' + single + single;

    const entries = decode(twoEntries, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].exitDataIndex).toBe(0);
    expect(entries[1].exitDataIndex).toBe(1);
    expect(entries[1].moduleId).toBe(BigInt(1));
  });

  it('format 1: correctly decodes a 64-byte entry (existing behaviour unchanged)', () => {
    // Build a format-1 entry (no keyIndex field)
    const moduleId = '000001'; // 3 bytes
    const nodeOpId = '0000000007'; // 5 bytes
    const validatorIndex = '0000000000103f8e'; // 8 bytes
    const pubkey = 'ab'.repeat(48); // 48 bytes
    const hex = '0x' + moduleId + nodeOpId + validatorIndex + pubkey;

    const entries = decode(hex, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].moduleId).toBe(BigInt(1));
    expect(entries[0].nodeOpId).toBe(BigInt(7));
    expect(entries[0].validatorIndex).toBe(BigInt(1064846));
    expect(entries[0].validatorPubkey).toBe('0x' + pubkey);
  });

  it('throws for unsupported data formats', () => {
    expect(() => decode('0x', 3)).toThrow('Unsupported data format: 3');
    expect(() => decode('0x', 0)).toThrow('Unsupported data format: 0');
  });

  it('returns empty array for empty data in any supported format', () => {
    expect(decode('0x', 1)).toEqual([]);
    expect(decode('0x', 2)).toEqual([]);
  });
});

// ─── resolveProvableAnchor — EIP-4788 lookup key ──────────────────────────────

// Hoodi (chain 560048) constants, taken from the network that produced the RootNotFound() incident
const HOODI_GENESIS = 1742213400;
const SECONDS_PER_SLOT = 12;

// Real Hoodi history around the failing proof: slot 3624534 was never proposed, so the block root
// of slot 3624533 was stored by the block at slot 3624535 under its own timestamp.
const PROVABLE_SLOT = 3624533;
const MISSED_SLOT = 3624534;
const NEXT_PROPOSED_SLOT = 3624535;

const rootOf = (slot: number) => `0xroot${slot}`;

/**
 * Chain stub. `missed` slots have no block; `unstored` slots produce no beacon roots entry - a
 * missed execution block before Gloas, a withheld payload after it. Everything else is answered by
 * the predeploy the way the real one would.
 */
const makeAnchorService = ({ missed = [] as number[], unstored = [] as number[] } = {}) => {
  const getBeaconHeader = jest.fn(async (blockId: string) => {
    const slot = Number(blockId);
    if (missed.includes(slot)) {
      throw new RequestError(`NOT_FOUND: beacon block at slot ${slot}`, 404);
    }
    return { root: rootOf(slot), header: { message: { slot: blockId } } };
  });

  // The execution block of slot W stores the root of W's parent under ts(W)
  const call = jest.fn(async ({ data }: { to: string; data: string }) => {
    const timestamp = Number(BigInt(data));
    const writerSlot = (timestamp - HOODI_GENESIS) / SECONDS_PER_SLOT;
    if (unstored.includes(writerSlot)) return '0x';
    let parent = writerSlot - 1;
    while (missed.includes(parent)) parent--;
    return rootOf(parent);
  });

  const service = makeService({
    consensus: {
      genesisTimestamp: HOODI_GENESIS,
      beaconConfig: { SLOTS_PER_EPOCH: 32, SECONDS_PER_SLOT },
      slotToTimestamp: (slot: number) => HOODI_GENESIS + slot * SECONDS_PER_SLOT,
      getBeaconHeader,
    },
    execution: { provider: { call } },
  });

  return { service, call };
};

describe('ProverService.resolveProvableAnchor', () => {
  it('skips a missed slot and keys on the next proposed slot (regression for RootNotFound)', async () => {
    const { service } = makeAnchorService({ missed: [MISSED_SLOT] });

    const anchor = await (service as any).resolveProvableAnchor(PROVABLE_SLOT);

    expect(anchor.slot).toBe(PROVABLE_SLOT);
    // Timestamp of slot 3624535 - the block that actually stored the slot-3624533 root.
    // Verified on Hoodi: BEACON_ROOTS.get(1785707820) == 0x37350b7f...3702a00c
    expect(anchor.rootsTimestamp).toBe(1785707820);
    // The old `genesis + (slot + 1) * SECONDS_PER_SLOT` formula produced this, and the beacon roots
    // predeploy reverts on it because no execution block carries a missed slot's timestamp.
    expect(anchor.rootsTimestamp).not.toBe(1785707808);
  });

  it('keys on slot + 1 when that slot was proposed', async () => {
    const { service } = makeAnchorService();

    const anchor = await (service as any).resolveProvableAnchor(PROVABLE_SLOT);

    expect(anchor.slot).toBe(PROVABLE_SLOT);
    expect(anchor.rootsTimestamp).toBe(HOODI_GENESIS + (PROVABLE_SLOT + 1) * SECONDS_PER_SLOT);
  });

  it('skips a run of consecutive missed slots', async () => {
    const { service } = makeAnchorService({
      missed: [MISSED_SLOT, NEXT_PROPOSED_SLOT, NEXT_PROPOSED_SLOT + 1],
    });

    const anchor = await (service as any).resolveProvableAnchor(PROVABLE_SLOT);

    expect(anchor.rootsTimestamp).toBe(HOODI_GENESIS + (NEXT_PROPOSED_SLOT + 2) * SECONDS_PER_SLOT);
  });

  it('confirms the root against the predeploy rather than assuming it is there', async () => {
    const { service, call } = makeAnchorService();

    const anchor = await (service as any).resolveProvableAnchor(PROVABLE_SLOT);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].to).toBe('0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02');
    expect(anchor.rootsTimestamp).toBe(HOODI_GENESIS + (PROVABLE_SLOT + 1) * SECONDS_PER_SLOT);
  });

  // No execution block carried that slot's timestamp, so nothing stored the anchor's root and no
  // later timestamp ever will - the anchor itself has to move.
  it('moves the anchor forward when nothing stored its root', async () => {
    const { service } = makeAnchorService({ unstored: [PROVABLE_SLOT + 1] });

    const anchor = await (service as any).resolveProvableAnchor(PROVABLE_SLOT);

    expect(anchor.slot).toBe(PROVABLE_SLOT + 1);
    expect(anchor.rootsTimestamp).toBe(HOODI_GENESIS + (PROVABLE_SLOT + 2) * SECONDS_PER_SLOT);
  });

  it('moves the anchor past a run of unstored roots and missed slots', async () => {
    const { service } = makeAnchorService({
      missed: [PROVABLE_SLOT + 2],
      unstored: [PROVABLE_SLOT + 1, PROVABLE_SLOT + 3],
    });

    const anchor = await (service as any).resolveProvableAnchor(PROVABLE_SLOT);

    expect(anchor.slot).toBe(PROVABLE_SLOT + 3);
    expect(anchor.rootsTimestamp).toBe(HOODI_GENESIS + (PROVABLE_SLOT + 4) * SECONDS_PER_SLOT);
  });

  it('gives up when the predeploy holds none of the candidate roots', async () => {
    const unstored = Array.from({ length: 32 }, (_, i) => PROVABLE_SLOT + 1 + i);
    const { service } = makeAnchorService({ unstored });

    await expect((service as any).resolveProvableAnchor(PROVABLE_SLOT)).rejects.toThrow(
      'Failed to find a provable anchor',
    );
  });
});
