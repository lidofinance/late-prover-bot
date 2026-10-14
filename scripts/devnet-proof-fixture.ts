/**
 * Build ValidatorExitDelayVerifier proof fixtures from a live Gloas devnet.
 *
 * Every proof is made by the bot's own helpers from real chain data, the way the prover makes it:
 *   - current: a recent block whose root is read back from the EIP-4788 predeploy, and a validator
 *     proven against that block's state (`verifyValidatorExitDelay`);
 *   - historical: an older Gloas block proven through the historical summaries of a finalized
 *     anchor, and a validator proven against the old block's state
 *     (`verifyHistoricalValidatorExitDelay`);
 *   - historicalPreGloas: the same for a block from before the fork, proven from a Gloas state -
 *     the case where the verifier switches layouts between the anchor and the proven block.
 *
 * Usage:
 *   TS_NODE_COMPILER_OPTIONS='{"esModuleInterop":true}' CL_API_URLS=<cl> EL_API_URL=<el> \
 *     LIDO_LOCATOR=<addr> npx ts-node -r tsconfig-paths/register scripts/devnet-proof-fixture.ts [out.json]
 */
import { writeFileSync } from 'node:fs';

import { ethers } from 'ethers';

import { WorkingMode } from '../src/common/config/env.validation';
import { generateHistoricalStateProof, generateValidatorProof, toHex, verifyProof } from '../src/common/helpers/proofs';
import { Consensus } from '../src/common/providers/consensus/consensus';

const CL_URL = process.env.CL_API_URLS as string;
const EL_URL = process.env.EL_API_URL as string;
const LOCATOR = process.env.LIDO_LOCATOR as string;
const OUT = process.argv[2] ?? 'devnet-proof-fixture.json';
const BEACON_ROOTS = '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02';
/** How far behind finalization the block proven through EIP-4788 sits */
const CURRENT_LAG_SLOTS = 64;

const FAR_FUTURE_EPOCH = '18446744073709551615';

const logger = { log: () => undefined, warn: () => undefined, error: console.error, debug: () => undefined };

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

async function main() {
  const consensus = new (Consensus as any)(logger, {}, config) as Consensus & { [k: string]: any };
  await consensus.onModuleInit();
  const el = new ethers.providers.JsonRpcProvider(EL_URL);
  const ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);

  const slotsPerHistoricalRoot = Number(consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
  const capellaSlot = consensus.epochToSlot(Number(consensus.beaconConfig.CAPELLA_FORK_EPOCH));
  const gloasSlot = consensus.epochToSlot(Number((consensus.beaconConfig as any).GLOAS_FORK_EPOCH));

  const stateViewAt = async (slot: number) => {
    const state = await consensus.getState(slot);
    return ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
  };

  /** A proposed block at or after `slot` with its EIP-4788 key, confirmed against the predeploy */
  const provable = async (slot: number) => {
    const block = await consensus.findNextAvailableHeader(slot);
    const writer = await consensus.findNextAvailableHeader(block.slot + 1);
    const rootsTimestamp = consensus.slotToTimestamp(writer.slot);
    const stored = await el.call({
      to: BEACON_ROOTS,
      data: ethers.utils.hexZeroPad(ethers.BigNumber.from(rootsTimestamp).toHexString(), 32),
    });
    if (stored !== block.header.root) {
      throw new Error(`EIP-4788 holds ${stored} at ${rootsTimestamp}, not the root of slot ${block.slot}`);
    }
    return { ...headerFields(block.header), root: block.header.root, rootsTimestamp };
  };

  const validatorWitness = (stateView: any, index: number) => {
    const validator = stateView.validators.get(index);
    const proof = generateValidatorProof(stateView, index);
    const gindex = stateView.type.getPathInfo(['validators', index]).gindex;
    verifyProof(stateView.hashTreeRoot(), gindex, proof.witnesses, validator.hashTreeRoot());
    return {
      index,
      pubkey: toHex(validator.pubkey),
      gindex: gindex.toString(),
      witness: {
        exitRequestIndex: 0,
        withdrawalCredentials: toHex(validator.withdrawalCredentials),
        effectiveBalance: validator.effectiveBalance.toString(),
        slashed: Boolean(validator.slashed),
        activationEligibilityEpoch: validator.activationEligibilityEpoch,
        activationEpoch: validator.activationEpoch,
        withdrawableEpoch: validator.withdrawableEpoch === Infinity ? FAR_FUTURE_EPOCH : validator.withdrawableEpoch,
        validatorProof: proof.witnesses.map(toHex),
      },
    };
  };

  /** An old block proven against the anchor state's historical summaries, as processHistoricalSlot does */
  const historical = async (anchorStateView: any, slot: number) => {
    const { slot: oldSlot, header } = await consensus.findNextAvailableHeader(slot);
    const summaryIndex = Math.floor((oldSlot - capellaSlot) / slotsPerHistoricalRoot);
    const rootIndex = oldSlot % slotsPerHistoricalRoot;
    const summaryStateView = await stateViewAt(capellaSlot + (summaryIndex + 1) * slotsPerHistoricalRoot);
    const proof = generateHistoricalStateProof(anchorStateView, summaryStateView, summaryIndex, rootIndex);
    return {
      oldStateView: await stateViewAt(oldSlot),
      old: { ...headerFields(header), root: header.root, proof: proof.witnesses.map(toHex) },
    };
  };

  // ── the Lido key reported in the full calls ───────────────────────────────
  const locator = new ethers.Contract(LOCATOR, ['function stakingRouter() view returns (address)'], el);
  // StakingModule changes shape between protocol versions; it is returned as a dynamic tuple whose
  // first two head words are the id and the module address, so only those are decoded
  const moduleCall = await el.call({
    to: await locator.stakingRouter(),
    data: new ethers.utils.Interface(['function getStakingModule(uint256)']).encodeFunctionData('getStakingModule', [
      1,
    ]),
  });
  const module = {
    id: ethers.BigNumber.from(ethers.utils.hexDataSlice(moduleCall, 32, 64)).toNumber(),
    stakingModuleAddress: ethers.utils.getAddress(ethers.utils.hexDataSlice(moduleCall, 76, 96)),
  };
  const nor = new ethers.Contract(
    module.stakingModuleAddress,
    ['function getSigningKeys(uint256,uint256,uint256) view returns (bytes, bytes, bool[])'],
    el,
  );
  const { 0: keys } = await nor.getSigningKeys(0, 0, 10);
  const lidoKeys: string[] = [];
  for (let i = 0; i < (keys.length - 2) / 96; i++) lidoKeys.push('0x' + keys.slice(2 + i * 96, 2 + (i + 1) * 96));

  // ── the finalized anchor, the block the historical proofs are made against ─
  const finalized = await consensus.getBeaconHeader('finalized');
  const finalizedSlot = Number(finalized.header.message.slot);
  const anchorHeader = await consensus.getBeaconHeader(finalized.header.message.parent_root);
  const anchor = await provable(Number(anchorHeader.header.message.slot));
  const anchorStateView = await stateViewAt(anchor.slot);

  // A Lido key that is active and not exiting in every state it is proven in
  const activeIn = (stateView: any, pubkey: string) => {
    for (let i = 0; i < stateView.validators.length; i++) {
      const validator = stateView.validators.get(i);
      if (toHex(validator.pubkey) === pubkey) return validator.exitEpoch === Infinity ? i : null;
    }
    return null;
  };

  // ── current: proven through EIP-4788 itself ───────────────────────────────
  const currentBlock = await provable(finalizedSlot - CURRENT_LAG_SLOTS);
  const currentStateView = await stateViewAt(currentBlock.slot);

  // ── historical: the newest completed summary period that is entirely post-Gloas ─
  const lastSummary = Math.floor((anchor.slot - capellaSlot) / slotsPerHistoricalRoot) - 1;
  const gloasOldSlot = capellaSlot + lastSummary * slotsPerHistoricalRoot + slotsPerHistoricalRoot / 2;
  if (gloasOldSlot < gloasSlot) throw new Error('no completed historical summary period after the Gloas fork yet');
  const gloasOld = await historical(anchorStateView, gloasOldSlot);

  // ── historicalPreGloas: a block from before the fork, proven from the Gloas anchor ─
  const preGloasOld = await historical(anchorStateView, Math.max(capellaSlot + 1, gloasSlot - CURRENT_LAG_SLOTS));
  if (preGloasOld.old.slot >= gloasSlot) throw new Error('the pre-Gloas block landed after the fork');

  let picked: { pubkey: string; keyIndex: number; current: number; historical: number } | null = null;
  for (const [keyIndex, pubkey] of lidoKeys.entries()) {
    const current = activeIn(currentStateView, pubkey);
    const historicalIndex = activeIn(gloasOld.oldStateView, pubkey);
    if (current === null || historicalIndex === null) continue;
    picked = { pubkey, keyIndex, current, historical: historicalIndex };
    break;
  }
  if (!picked) throw new Error('no Lido key of the first module / operator 0 is active in both states');

  // dataFormat 2: moduleId (3) | nodeOpId (5) | validatorIndex (8) | keyIndex (8) | pubkey (48)
  const exitRequest = (validatorIndex: number) => ({
    data: ethers.utils.hexConcat([
      ethers.utils.hexZeroPad(ethers.BigNumber.from(module.id).toHexString(), 3),
      ethers.utils.hexZeroPad('0x00', 5),
      ethers.utils.hexZeroPad(ethers.BigNumber.from(validatorIndex).toHexString(), 8),
      ethers.utils.hexZeroPad(ethers.BigNumber.from(picked!.keyIndex).toHexString(), 8),
      picked!.pubkey,
    ]),
    dataFormat: 2,
    moduleId: Number(module.id),
    nodeOpId: 0,
  });

  const fixture = {
    chain: {
      genesisTime: consensus.genesisTimestamp,
      secondsPerSlot: Number(consensus.beaconConfig.SECONDS_PER_SLOT),
      slotsPerEpoch: Number(consensus.beaconConfig.SLOTS_PER_EPOCH),
      slotsPerHistoricalRoot,
      capellaSlot,
      gloasSlot,
      shardCommitteePeriodInSeconds: 256 * 32 * Number(consensus.beaconConfig.SECONDS_PER_SLOT),
      lidoLocator: LOCATOR,
    },
    current: {
      block: currentBlock,
      validator: validatorWitness(currentStateView, picked.current),
      exitRequests: exitRequest(picked.current),
    },
    historical: {
      anchor,
      old: gloasOld.old,
      validator: validatorWitness(gloasOld.oldStateView, picked.historical),
      exitRequests: exitRequest(picked.historical),
    },
    // Proof-level only: Lido keys may not exist yet before the fork, so any validator will do
    historicalPreGloas: {
      anchor,
      old: preGloasOld.old,
      validator: validatorWitness(preGloasOld.oldStateView, 0),
    },
  };

  writeFileSync(OUT, JSON.stringify(fixture, null, 2));
  console.log(
    `fixture written to ${OUT}\n` +
      `  current: slot ${currentBlock.slot}, rootsTimestamp ${currentBlock.rootsTimestamp}\n` +
      `  anchor: slot ${anchor.slot}, rootsTimestamp ${anchor.rootsTimestamp}\n` +
      `  historical: slot ${gloasOld.old.slot} (Gloas), slot ${preGloasOld.old.slot} (pre-Gloas, fork at ${gloasSlot})\n` +
      `  validator: ${picked.pubkey.slice(0, 18)} (key ${picked.keyIndex} of module ${module.id})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
