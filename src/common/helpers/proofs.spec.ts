import { generateBlockRootsProof, generateValidatorProof, toHex, verifyProof } from './proofs';

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

  // Gloas turns the state into a progressive container and `validators` into a progressive list
  // (EIP-7916), which re-merkleizes the registry. `ValidatorExitDelayVerifier` derives the leaf
  // index as GI_FIRST_VALIDATOR + validatorIndex and only switches GI_FIRST_VALIDATOR at a
  // configured PIVOT_SLOT; neither the constant nor the arithmetic survives the fork, so the
  // contract needs work before proofs can be submitted post-Gloas. This test pins that fact.
  it('changes the validator generalized index in Gloas, and it is no longer linear in the index', () => {
    const gindexOf = (fork: string, index: number) => ssz[fork].BeaconState.getPathInfo(['validators', index]).gindex;

    expect(gindexOf('gloas', 0).toString()).not.toBe(gindexOf('fulu', 0).toString());

    // Pre-Gloas the registry is a fixed-depth list: consecutive validators are consecutive leaves
    expect((gindexOf('fulu', 1) - gindexOf('fulu', 0)).toString()).toBe('1');
    expect((gindexOf('fulu', 1039010) - gindexOf('fulu', 0)).toString()).toBe('1039010');

    // Progressive lists grow in subtrees, so the offset from the first validator is not the index
    expect((gindexOf('gloas', 1) - gindexOf('gloas', 0)).toString()).not.toBe('1');
    expect((gindexOf('gloas', 1039010) - gindexOf('gloas', 0)).toString()).not.toBe('1039010');
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

describe('generateBlockRootsProof', () => {
  let ssz: any;

  beforeAll(async () => {
    ssz = await importSsz();
  });

  // This is how the deadline block reaches the verifier: proven against a recent state's block_roots
  // ring buffer instead of the EIP-4788 predeploy.
  it.each(['electra', 'gloas'])('proves a block root out of the %s state ring buffer', (fork) => {
    const state = ssz[fork].BeaconState.defaultViewDU();
    const rootIndex = 5983;
    state.blockRoots.set(rootIndex, new Uint8Array(32).fill(7));
    state.commit();

    const proof = generateBlockRootsProof(state, rootIndex);

    expect(() =>
      verifyProof(
        state.hashTreeRoot(),
        state.type.getPathInfo(['blockRoots', rootIndex]).gindex,
        proof.witnesses,
        state.blockRoots.get(rootIndex),
      ),
    ).not.toThrow();
  });
});

describe('toHex', () => {
  it('renders bytes as a 0x-prefixed lowercase hex string', () => {
    expect(toHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))).toBe('0xdeadbeef');
  });
});
