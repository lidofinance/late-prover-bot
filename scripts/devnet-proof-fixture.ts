/**
 * Build a ValidatorExitDelayVerifier proof fixture from a live Gloas devnet.
 *
 * Produces everything the contract needs for `verifyValidatorExitDelay`, taken from real chain data:
 * a recent block anchored through EIP-4788, the target block proven against that block's
 * `state.block_roots`, and a validator proven against the target block's state. The generalized
 * indices SSZ used are written alongside so the contract's own derivation can be compared to them.
 *
 * Usage:
 *   CL_API_URLS=<cl> EL_API_URL=<el> LIDO_LOCATOR=<addr> \
 *     npx ts-node -r tsconfig-paths/register scripts/devnet-proof-fixture.ts [out.json]
 */
import { writeFileSync } from 'node:fs';

import { ethers } from 'ethers';

import { WorkingMode } from '../src/common/config/env.validation';
import { generateBlockRootsProof, generateValidatorProof, toHex, verifyProof } from '../src/common/helpers/proofs';
import { Consensus } from '../src/common/providers/consensus/consensus';

const CL_URL = process.env.CL_API_URLS as string;
const EL_URL = process.env.EL_API_URL as string;
const LOCATOR = process.env.LIDO_LOCATOR as string;
const OUT = process.argv[2] ?? 'devnet-proof-fixture.json';
/** How far behind the recent block the proven (deadline) block sits */
const TARGET_LAG_SLOTS = Number(process.env.TARGET_LAG_SLOTS ?? 64);

const FAR_FUTURE_EPOCH = '18446744073709551615';

const logger = {
  log: () => undefined,
  warn: () => undefined,
  error: console.error,
  debug: () => undefined,
};

const config = {
  get: (key: string) =>
    ({
      CL_API_URLS: [CL_URL],
      CL_API_RESPONSE_TIMEOUT_MS: 120_000,
      CL_API_MAX_RETRIES: 2,
      CL_API_RETRY_DELAY_MS: 500,
      FORK_NAME: 'gloas',
      WORKING_MODE: WorkingMode.CLI,
    })[key],
};

const headerFields = (header: any) => ({
  slot: Number(header.header.message.slot),
  proposerIndex: Number(header.header.message.proposer_index),
  parentRoot: header.header.message.parent_root,
  stateRoot: header.header.message.state_root,
  bodyRoot: header.header.message.body_root,
});

/** GIndex.sol packs a generalized index and the tree level power into one word */
const packGIndex = (gindex: bigint, pow: number) => ethers.utils.hexZeroPad('0x' + ((gindex << 8n) | BigInt(pow)).toString(16), 32);

async function main() {
  const consensus = new (Consensus as any)(logger, {}, config) as Consensus & { [k: string]: any };
  await consensus.onModuleInit();
  const el = new ethers.providers.JsonRpcProvider(EL_URL);
  const ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);

  const slotsPerHistoricalRoot = Number(consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
  const secondsPerSlot = Number(consensus.beaconConfig.SECONDS_PER_SLOT);
  const gloasForkSlot = consensus.epochToSlot(Number((consensus.beaconConfig as any).GLOAS_FORK_EPOCH));

  // ── the recent block: its root has to be readable through EIP-4788 ─────────
  const finalized = await consensus.getBeaconHeader('finalized');
  const recentSlot = Number(finalized.header.message.slot);
  const { slot: writerSlot } = await consensus.findNextAvailableHeader(recentSlot + 1);
  const rootsTimestamp = consensus.slotToTimestamp(writerSlot);

  const beaconRoot = await el.call({
    to: '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02',
    data: ethers.utils.hexZeroPad(ethers.BigNumber.from(rootsTimestamp).toHexString(), 32),
  });
  if (beaconRoot !== finalized.root) {
    throw new Error(`EIP-4788 holds ${beaconRoot} at ${rootsTimestamp}, expected ${finalized.root}`);
  }

  // ── the target block: proven against the recent block's state.block_roots ──
  const { slot: targetSlot, header: targetHeader } = await consensus.findNextAvailableHeader(
    recentSlot - TARGET_LAG_SLOTS,
  );
  if (targetSlot >= recentSlot) throw new Error('target block must be older than the recent block');

  const recentState = await consensus.getState(recentSlot);
  const recentStateView = ssz[recentState.forkName].BeaconState.deserializeToView(recentState.bodyBytes);
  const rootIndex = targetSlot % slotsPerHistoricalRoot;
  const blockRootsProof = generateBlockRootsProof(recentStateView, rootIndex);
  const blockRootsGIndex = recentStateView.type.getPathInfo(['blockRoots', rootIndex]).gindex;
  verifyProof(
    recentStateView.hashTreeRoot(),
    blockRootsGIndex,
    blockRootsProof.witnesses,
    recentStateView.blockRoots.get(rootIndex),
  );

  // ── the validator: proven against the target block's state ────────────────
  const targetState = await consensus.getState(targetSlot);
  const targetStateView = ssz[targetState.forkName].BeaconState.deserializeToView(targetState.bodyBytes);

  const locator = new ethers.Contract(
    LOCATOR,
    ['function stakingRouter() view returns (address)', 'function withdrawalVault() view returns (address)'],
    el,
  );
  const stakingRouter = new ethers.Contract(
    await locator.stakingRouter(),
    [
      'function getStakingModule(uint256) view returns (tuple(uint24 id, address stakingModuleAddress, uint16 stakingModuleFee, uint16 treasuryFee, uint16 stakeShareLimit, uint8 status, string name, uint64 lastDepositAt, uint256 lastDepositBlock, uint256 exitedValidatorsCount, uint16 priorityExitShareThreshold, uint64 maxDepositsPerBlock, uint64 minDepositBlockDistance))',
    ],
    el,
  );
  const nor = new ethers.Contract(
    (await stakingRouter.getStakingModule(1)).stakingModuleAddress,
    ['function getSigningKeys(uint256,uint256,uint256) view returns (bytes, bytes, bool[])'],
    el,
  );

  // A Lido key of module 1 / operator 0 that is still active on the CL
  const { 0: keys } = await nor.getSigningKeys(0, 0, 10);
  const pubkeys: string[] = [];
  for (let i = 0; i < (keys.length - 2) / 96; i++) pubkeys.push('0x' + keys.slice(2 + i * 96, 2 + (i + 1) * 96));

  let picked: { index: number; pubkey: string; keyIndex: number } | null = null;
  for (const [keyIndex, pubkey] of pubkeys.entries()) {
    const found = await fetch(`${CL_URL}/eth/v1/beacon/states/${targetSlot}/validators/${pubkey}`).then((r) =>
      r.ok ? (r.json() as any) : null,
    );
    if (!found) continue;
    const index = Number(found.data.index);
    if (targetStateView.validators.get(index).exitEpoch !== Infinity) continue;
    picked = { index, pubkey, keyIndex };
    break;
  }
  if (!picked) throw new Error('no Lido key of module 1 / operator 0 is an active non-exiting validator');

  const validator = targetStateView.validators.get(picked.index);
  const validatorProof = generateValidatorProof(targetStateView, picked.index);
  const validatorGIndex = targetStateView.type.getPathInfo(['validators', picked.index]).gindex;
  verifyProof(targetStateView.hashTreeRoot(), validatorGIndex, validatorProof.witnesses, validator.hashTreeRoot());

  // ── the exit request blob, dataFormat 2 ───────────────────────────────────
  const entry = ethers.utils.hexConcat([
    ethers.utils.hexZeroPad('0x01', 3), // moduleId
    ethers.utils.hexZeroPad('0x00', 5), // nodeOpId
    ethers.utils.hexZeroPad(ethers.BigNumber.from(picked.index).toHexString(), 8),
    ethers.utils.hexZeroPad(ethers.BigNumber.from(picked.keyIndex).toHexString(), 8),
    picked.pubkey,
  ]);

  const fixture = {
    chain: {
      genesisTime: consensus.genesisTimestamp,
      secondsPerSlot,
      slotsPerHistoricalRoot,
      gloasForkSlot,
      capellaSlot: consensus.epochToSlot(Number(consensus.beaconConfig.CAPELLA_FORK_EPOCH)),
      shardCommitteePeriodInSeconds: 98304,
      lidoLocator: LOCATOR,
    },
    gIndices: {
      // pre-Gloas `validators[0]`, list capacity 2**40
      gIFirstValidatorPreGloas: packGIndex(ssz.electra.BeaconState.getPathInfo(['validators', 0]).gindex, 40),
      // Gloas `validators` node - the contract walks into the progressive list itself
      gIValidators: packGIndex(ssz.gloas.BeaconState.getPathInfo(['validators']).gindex, 0),
      gIBlockRootsPreGloas: packGIndex(ssz.electra.BeaconState.getPathInfo(['blockRoots']).gindex, 0),
      gIBlockRoots: packGIndex(ssz.gloas.BeaconState.getPathInfo(['blockRoots']).gindex, 0),
      gIFirstHistoricalSummaryPreGloas: packGIndex(
        ssz.electra.BeaconState.getPathInfo(['historicalSummaries', 0]).gindex,
        24,
      ),
      gIFirstHistoricalSummary: packGIndex(ssz.gloas.BeaconState.getPathInfo(['historicalSummaries', 0]).gindex, 24),
      gIFirstBlockRootInSummary: packGIndex(
        ssz.electra.BeaconState.getPathInfo(['historicalSummaries', 0, 'blockSummaryRoot']).gindex,
        13,
      ),
    },
    recent: { ...headerFields(finalized), root: finalized.root, rootsTimestamp },
    target: {
      ...headerFields(targetHeader),
      root: targetHeader.root,
      rootIndex,
      gindex: blockRootsGIndex.toString(),
      proof: blockRootsProof.witnesses.map(toHex),
    },
    validator: {
      index: picked.index,
      pubkey: picked.pubkey,
      gindex: validatorGIndex.toString(),
      witness: {
        exitRequestIndex: 0,
        withdrawalCredentials: toHex(validator.withdrawalCredentials),
        effectiveBalance: validator.effectiveBalance.toString(),
        slashed: Boolean(validator.slashed),
        activationEligibilityEpoch: validator.activationEligibilityEpoch,
        activationEpoch: validator.activationEpoch,
        withdrawableEpoch: validator.withdrawableEpoch === Infinity ? FAR_FUTURE_EPOCH : validator.withdrawableEpoch,
        validatorProof: validatorProof.witnesses.map(toHex),
      },
    },
    exitRequests: { data: entry, dataFormat: 2, moduleId: 1, nodeOpId: 0, keyIndex: picked.keyIndex },
  };

  writeFileSync(OUT, JSON.stringify(fixture, null, 2));
  console.log(
    `fixture written to ${OUT}\n` +
      `  recent slot ${recentSlot} (rootsTimestamp ${rootsTimestamp}, verified against EIP-4788)\n` +
      `  target slot ${targetSlot} (block_roots[${rootIndex}], ${blockRootsProof.witnesses.length} nodes)\n` +
      `  validator ${picked.index} ${picked.pubkey.slice(0, 18)} (${validatorProof.witnesses.length} nodes)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
