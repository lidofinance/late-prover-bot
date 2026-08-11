/**
 * Ad-hoc verification of the EIP-7732 handling against a live Gloas devnet.
 *
 * Runs the real Consensus provider and the real ProverService anchor resolution against the node,
 * then checks every conclusion against the chain itself:
 *   - the EL anchor of a CL block is a block the EL actually knows, at that block's slot or earlier;
 *   - our "was the payload revealed" predicate agrees with the EIP-4788 beacon roots predeploy;
 *   - the anchor the prover would submit really does have its root in the ring buffer.
 *
 * Usage: CL_API_URLS=... EL_API_URL=... npx ts-node -r tsconfig-paths/register scripts/devnet-gloas-check.ts
 */
import { ethers } from 'ethers';

import { WorkingMode } from '../src/common/config/env.validation';
import { ProverService } from '../src/common/prover/prover.service';
import { Consensus, getExecutionPayload, isPayloadRevealed } from '../src/common/providers/consensus/consensus';

const CL_URL = process.env.CL_API_URLS as string;
const EL_URL = process.env.EL_API_URL as string;
const BEACON_ROOTS = '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02';
const SAMPLE_SLOTS = Number(process.env.SAMPLE_SLOTS ?? 64);

const logger = {
  log: (...a: any[]) => process.env.VERBOSE && console.log('  ·', ...a),
  warn: (...a: any[]) => console.warn('  ! ', ...a),
  error: (...a: any[]) => console.error('  ✗ ', ...a),
  debug: () => undefined,
};

const config = {
  get: (key: string) =>
    ({
      CL_API_URLS: [CL_URL],
      CL_API_RESPONSE_TIMEOUT_MS: 60_000,
      CL_API_MAX_RETRIES: 2,
      CL_API_RETRY_DELAY_MS: 500,
      FORK_NAME: 'gloas',
      WORKING_MODE: WorkingMode.CLI,
    })[key],
};

let failures = 0;
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${message}`);
  if (!ok) failures++;
};

/** The root the EIP-4788 predeploy holds for a timestamp, or null when it reverts */
async function beaconRootAt(el: ethers.providers.JsonRpcProvider, timestamp: number): Promise<string | null> {
  try {
    return await el.call({
      to: BEACON_ROOTS,
      data: ethers.utils.hexZeroPad(ethers.BigNumber.from(timestamp).toHexString(), 32),
    });
  } catch {
    return null;
  }
}

async function main() {
  const consensus = new (Consensus as any)(logger, {}, config) as Consensus & { [k: string]: any };
  await consensus.onModuleInit();
  const el = new ethers.providers.JsonRpcProvider(EL_URL);

  const prover = new (ProverService as any)(logger, consensus, {}, {}, {}, {}, {}, config, 50);

  const head = await consensus.getBeaconHeader('head');
  const finalized = await consensus.getBeaconHeader('finalized');
  const headSlot = Number(head.header.message.slot);
  const finalizedSlot = Number(finalized.header.message.slot);
  console.log(`\nhead slot ${headSlot}, finalized slot ${finalizedSlot}, EL head ${await el.getBlockNumber()}\n`);

  // ── 1. fork detection and decoding of a real Gloas block ───────────────────
  console.log('1. Block decoding');
  const { block, forkName } = await consensus.getBlockInfo(finalized.root);
  check(forkName === 'gloas', `finalized block reports fork ${forkName}`);
  check(getExecutionPayload(block) === undefined, 'no execution payload embedded in the block body (EIP-7732)');

  // ── 2. EL anchor of a CL block ────────────────────────────────────────────
  console.log('\n2. EL anchor of the finalized block');
  const anchorHash = await consensus.getExecutionBlockHash(finalized);
  const anchorBlock = await el.getBlock(anchorHash);
  check(anchorBlock != null, `EL knows the anchored block ${anchorHash.slice(0, 18)}`);
  if (anchorBlock) {
    const anchorSlot = consensus.timestampToSlot(anchorBlock.timestamp);
    check(
      anchorSlot <= finalizedSlot,
      `anchor is EL block ${anchorBlock.number} at slot ${anchorSlot} (${finalizedSlot - anchorSlot} slot(s) behind the CL block)`,
    );
  }

  // ── 3. payload presence predicate vs the chain ────────────────────────────
  console.log(`\n3. isPayloadRevealed vs EIP-4788, over the last ${SAMPLE_SLOTS} slots before finalization`);
  let proposed = 0;
  let withheld = 0;
  let agreed = 0;
  let checked = 0;

  let slot = finalizedSlot - SAMPLE_SLOTS;
  let current = await consensus.findNextAvailableBlock(slot);
  while (current.slot < finalizedSlot) {
    const next = await consensus.findNextAvailableBlock(current.slot + 1);
    proposed++;
    const revealed = isPayloadRevealed(current.block, next.block);
    if (!revealed) withheld++;

    // The root of `current`'s parent is stored by `current`'s execution block, under its timestamp.
    // So `revealed` must be exactly "the buffer holds `current.header.parent_root` at ts(current)".
    const stored = await beaconRootAt(el, consensus.slotToTimestamp(current.slot));
    const expected = current.header.header.message.parent_root;
    const holdsParentRoot = stored === expected;
    if (holdsParentRoot === revealed) agreed++;
    else
      console.log(
        `  ✗ slot ${current.slot}: predicate says revealed=${revealed}, buffer says ${stored ?? 'revert'} (expected ${expected})`,
      );
    checked++;

    current = next;
  }
  check(agreed === checked, `${agreed}/${checked} blocks agree (${proposed} proposed, ${withheld} payloads withheld)`);

  // ── 4. the anchor the prover would submit ─────────────────────────────────
  console.log('\n4. resolveProvableAnchor - what the prover would put on chain');
  for (const start of [finalizedSlot - SAMPLE_SLOTS, finalizedSlot - Math.floor(SAMPLE_SLOTS / 2), finalizedSlot]) {
    const anchor = await prover.resolveProvableAnchor(start);
    const stored = await beaconRootAt(el, anchor.rootsTimestamp);
    check(
      stored === anchor.header.root,
      `start ${start} -> anchor slot ${anchor.slot}` +
        `${anchor.slot === start ? '' : ` (moved +${anchor.slot - start})`}` +
        `, rootsTimestamp ${anchor.rootsTimestamp} holds ${stored === anchor.header.root ? 'its root' : `${stored ?? 'nothing'}`}`,
    );
  }

  // ── 5. state download, decoding and a validator proof ─────────────────────
  console.log('\n5. Beacon state at the anchor slot');
  const ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const state = await consensus.getState(finalizedSlot);
  check(state.forkName === 'gloas', `state at slot ${finalizedSlot} reports fork ${state.forkName}`);
  const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
  check(stateView.validators.length > 0, `decoded, ${stateView.validators.length} validators`);
  check(
    '0x' + Buffer.from(stateView.hashTreeRoot()).toString('hex') === finalized.header.message.state_root,
    'state root matches the finalized header',
  );

  const { generateHistoricalStateProof, generateValidatorProof, verifyProof } = await import(
    '../src/common/helpers/proofs'
  );
  const validatorIndex = stateView.validators.length - 1;
  const proof = generateValidatorProof(stateView, validatorIndex);
  let proofOk = true;
  try {
    verifyProof(
      stateView.hashTreeRoot(),
      stateView.type.getPathInfo(['validators', validatorIndex]).gindex,
      proof.witnesses,
      stateView.validators.get(validatorIndex).hashTreeRoot(),
    );
  } catch {
    proofOk = false;
  }
  check(proofOk, `validator ${validatorIndex} proof verifies against the state root`);

  // ── 6. historical summaries proof, the path taken for deadlines older than
  //       SLOTS_PER_HISTORICAL_ROOT ───────────────────────────────────────────
  console.log('\n6. Historical summaries proof');
  const slotsPerHistoricalRoot = Number(consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
  const capellaSlot = consensus.epochToSlot(Number(consensus.beaconConfig.CAPELLA_FORK_EPOCH));
  const oldSlot = finalizedSlot - slotsPerHistoricalRoot;
  const summaryIndex = Math.floor((oldSlot - capellaSlot) / slotsPerHistoricalRoot);
  const summarySlot = capellaSlot + (summaryIndex + 1) * slotsPerHistoricalRoot;

  if (summarySlot > finalizedSlot || oldSlot < capellaSlot) {
    console.log(`  - skipped: summary slot ${summarySlot} is not reachable yet (finalized ${finalizedSlot})`);
  } else {
    const summaryState = await consensus.getState(summarySlot);
    const summaryStateView = ssz[summaryState.forkName].BeaconState.deserializeToView(summaryState.bodyBytes);
    // generateHistoricalStateProof verifies its own output against the anchor state root
    let historicalOk = true;
    try {
      generateHistoricalStateProof(stateView, summaryStateView, summaryIndex, oldSlot % slotsPerHistoricalRoot);
    } catch (error) {
      historicalOk = false;
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    }
    check(historicalOk, `block root of slot ${oldSlot} proven through summary ${summaryIndex} (state ${summarySlot})`);
  }

  console.log(failures === 0 ? '\nAll checks passed\n' : `\n${failures} check(s) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
