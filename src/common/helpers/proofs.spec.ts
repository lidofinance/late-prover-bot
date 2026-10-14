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

/**
 * The generalized index arithmetic of ValidatorExitDelayVerifier (lidofinance/core#1940,
 * contracts/common/lib/GIndex.sol and CLGIndices.sol). The contract derives every index itself, so a
 * proof the bot builds from SSZ is only accepted when SSZ lands on the same leaf.
 */
const fls = (x: bigint) => BigInt(x.toString(2).length - 1);
const concat = (lhs: bigint, rhs: bigint) => (lhs << fls(rhs)) | (rhs ^ (1n << fls(rhs)));
const staticListNodeGIndex = (i: bigint, depth: bigint) => (2n << depth) + i;
const vectorNodeGIndex = (i: bigint, length: bigint) => (1n << BigInt((length - 1n).toString(2).length)) + i;
const progressiveListNodeGIndex = (i: bigint) => {
  const k = fls(i * 3n + 1n) >> 1n;
  return ((((3n << k) - 1n) << 1n) << (2n * k)) + i - ((1n << (2n * k)) - 1n) / 3n;
};

const CL_GINDICES = {
  VALIDATORS_PRE_GLOAS: 0x4bn,
  VALIDATORS_DEPTH_PRE_GLOAS: 40n,
  HISTORICAL_SUMMARIES_PRE_GLOAS: 0x5bn,
  HISTORICAL_SUMMARIES_DEPTH: 24n,
  VALIDATORS: 0x166n,
  HISTORICAL_SUMMARIES: 0xb86n,
  BLOCK_ROOT_IN_SUMMARY: 2n,
};

const contractValidatorGIndex = (fork: string, index: bigint) =>
  fork === 'gloas'
    ? concat(CL_GINDICES.VALIDATORS, progressiveListNodeGIndex(index))
    : concat(CL_GINDICES.VALIDATORS_PRE_GLOAS, staticListNodeGIndex(index, CL_GINDICES.VALIDATORS_DEPTH_PRE_GLOAS));

const contractSummaryRootGIndex = (fork: string, summaryIndex: bigint) =>
  concat(
    concat(
      fork === 'gloas' ? CL_GINDICES.HISTORICAL_SUMMARIES : CL_GINDICES.HISTORICAL_SUMMARIES_PRE_GLOAS,
      staticListNodeGIndex(summaryIndex, CL_GINDICES.HISTORICAL_SUMMARIES_DEPTH),
    ),
    CL_GINDICES.BLOCK_ROOT_IN_SUMMARY,
  );

describe('generateValidatorProof', () => {
  let ssz: any;

  beforeAll(async () => {
    ssz = await importSsz();
  });

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

describe('generalized indices the verifier derives', () => {
  let ssz: any;

  beforeAll(async () => {
    ssz = await importSsz();
  });

  const VALIDATOR_INDICES = [0, 1, 2, 3, 4, 20, 21, 1039010, 2 ** 31];

  it.each(['electra', 'fulu', 'gloas'])('match SSZ for validators in %s', (fork) => {
    for (const index of VALIDATOR_INDICES) {
      const sszGIndex = ssz[fork].BeaconState.getPathInfo(['validators', index]).gindex;
      expect(contractValidatorGIndex(fork, BigInt(index))).toBe(sszGIndex);
    }
  });

  it.each(['electra', 'fulu', 'gloas'])('match SSZ for historical summary block roots in %s', (fork) => {
    for (const summaryIndex of [0, 1, 975]) {
      const sszGIndex = ssz[fork].BeaconState.getPathInfo([
        'historicalSummaries',
        summaryIndex,
        'blockSummaryRoot',
      ]).gindex;
      expect(contractSummaryRootGIndex(fork, BigInt(summaryIndex))).toBe(sszGIndex);
    }

    // The leaf inside the summary is a block_roots entry of the state the summary was taken from
    const blockRoots = ssz[fork].BeaconState.fields.blockRoots;
    for (const rootIndex of [0, 1, 4095, 8191]) {
      expect(vectorNodeGIndex(BigInt(rootIndex), 8192n)).toBe(blockRoots.getPathInfo([rootIndex]).gindex);
    }
  });
});
