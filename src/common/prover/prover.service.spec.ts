import { ProverService } from './prover.service';

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
const makeValidatorInput = (overrides: Partial<{ validatorIndex: bigint; moduleId: bigint; nodeOpId: bigint; validatorPubkey: string }> = {}) => ({
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
    makeLogger(),            // loggerService
    consensus,               // consensus
    {},                      // exitRequests
    {},                      // verifier
    {},                      // stakingRouter
    {},                      // execution
    makePrometheusMock(),    // prometheus
    {},                      // config
    50,                      // validatorBatchSize
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
      0,   // fromBlock
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
