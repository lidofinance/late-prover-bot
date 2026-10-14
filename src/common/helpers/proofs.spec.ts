import { generateValidatorProof, toHex, verifyProof } from './proofs';

// @lodestar/types is ESM-only, so it is loaded the same way the services load it
const importSsz = async () => await eval(`import('@lodestar/types').then((m) => m.ssz)`);

const makeValidator = (ssz: any, pubkeyByte: number) =>
  ssz.phase0.Validator.toViewDU({
    pubkey: new Uint8Array(48).fill(pubkeyByte),
    withdrawalCredentials: new Uint8Array(32).fill(2),
    effectiveBalance: 32_000_000_000,
    slashed: false,
    activationEligibilityEpoch: 244578,
    activationEpoch: 244687,
    exitEpoch: Infinity,
    withdrawableEpoch: Infinity,
  });

const makeStateWithValidators = (ssz: any, fork: string, count: number) => {
  const state = ssz[fork].BeaconState.defaultViewDU();
  for (let i = 0; i < count; i++) {
    state.validators.push(makeValidator(ssz, i + 1));
  }
  state.commit();
  return state;
};

describe('generateValidatorProof', () => {
  let ssz: any;

  beforeAll(async () => {
    ssz = await importSsz();
  });

  // The bot builds the proof, the ValidatorExitDelayVerifier contract checks it against the state
  // root of a beacon block header. This is the round trip, run against the same @chainsafe/ssz and
  // @chainsafe/persistent-merkle-tree versions the daemon runs on.
  it.each(['electra', 'fulu', 'gloas'])('produces a proof that verifies against the %s state root', (fork) => {
    const state = makeStateWithValidators(ssz, fork, 4);
    const validatorIndex = 2;

    const proof = generateValidatorProof(state, validatorIndex);

    expect(() =>
      verifyProof(
        state.hashTreeRoot(),
        state.type.getPathInfo(['validators', validatorIndex]).gindex,
        proof.witnesses,
        state.validators.get(validatorIndex).hashTreeRoot(),
      ),
    ).not.toThrow();
  });

  // The verifier contract hardcodes the generalized index of the validator registry and only
  // switches it at a configured PIVOT_SLOT. Gloas adds fields to the state but keeps `validators`
  // at the same position and the container within 64 fields, so the index is unchanged and no new
  // pivot is needed for EIP-7732.
  it('keeps the validators generalized index unchanged from Electra through Gloas', () => {
    const gindexOf = (fork: string) =>
      ssz[fork].BeaconState.defaultViewDU().type.getPathInfo(['validators', 1039010]).gindex;

    expect(gindexOf('gloas')).toBe(gindexOf('fulu'));
    expect(gindexOf('gloas')).toBe(gindexOf('electra'));
  });

  it('produces a proof that does not verify against a different validator leaf', () => {
    const state = makeStateWithValidators(ssz, 'gloas', 4);

    const proof = generateValidatorProof(state, 2);

    expect(() =>
      verifyProof(
        state.hashTreeRoot(),
        state.type.getPathInfo(['validators', 2]).gindex,
        proof.witnesses,
        state.validators.get(3).hashTreeRoot(),
      ),
    ).toThrow('Proof is not valid');
  });
});

describe('toHex', () => {
  it('renders bytes as a 0x-prefixed lowercase hex string', () => {
    expect(toHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))).toBe('0xdeadbeef');
  });
});
