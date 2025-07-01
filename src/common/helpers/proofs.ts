import { createHash } from 'node:crypto';

import { ProofType, SingleProof, Tree, concatGindices, createProof } from '@chainsafe/persistent-merkle-tree';
import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';
import type { ssz as sszType } from '@lodestar/types';

let ssz: typeof sszType;

export type SupportedStateView =
  | ContainerTreeViewType<typeof ssz.capella.BeaconState.fields>
  | ContainerTreeViewType<typeof ssz.deneb.BeaconState.fields>
  | ContainerTreeViewType<typeof ssz.electra.BeaconState.fields>;

export type SupportedBlockView =
  | ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
  | ContainerTreeViewType<typeof ssz.deneb.BeaconBlock.fields>
  | ContainerTreeViewType<typeof ssz.electra.BeaconBlock.fields>;

export function generateValidatorProof(stateView: SupportedStateView, valIndex: number): SingleProof {
  const gI = stateView.type.getPathInfo(['validators', Number(valIndex)]).gindex;
  return createProof(stateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
}

/**
 * generateHistoricalStateProof
 *
 * Construct a Merkle proof that a given `blockRoot` (from a historical summary)
 * actually appears in a finalized state tree.
 *
 * Internally, the finalized state is stored "lazily" (with accumulators rather than
 * real branch data). In order to build a genuine Merkle proof for one of the
 * historical summaries' block roots, we "patch" in the real leaf node from the summary
 * subtree, then generate a single proof on that patched tree.
 *
 * @param finalizedStateView - A view of the fully‐finalized state, including a root
 *   tree with lazy accumulators.
 * @param summaryStateView   - A view of the "summary" state at some earlier block
 *   that contains a list of block roots.
 * @param summaryIndex       - Index into `finalizedStateView.historicalSummaries` of
 *   the summary whose `blockSummaryRoot` we want to replace.
 * @param rootIndex          - Index within `summaryStateView.blockRoots` of the
 *   specific block root to prove.
 *
 * @returns A `SingleProof` which contains:
 *   - `gindex`: the absolute gindex (bigint) pointing to the chosen leaf in the patched tree
 *   - `witnesses`: the sibling‐hashes array needed to recompute the root from that leaf
 *
 * @remarks
 * 1. Compute the gindex of the `blockSummaryRoot` field inside the finalized state:
 *    ```ts
 *    const blockSummaryRootGI = finalizedStateView
 *      .type
 *      .getPathInfo([
 *        'historicalSummaries',
 *        summaryIndex,
 *        'blockSummaryRoot',
 *      ])
 *      .gindex;
 *    ```
 * 2. Create a "patched" copy of the finalized‐state tree and overwrite that path
 *    with the *real* subtree from the summary:
 *    ```ts
 *    const patchedTree = new Tree(finalizedStateView.node);
 *    patchedTree.setNode(
 *      blockSummaryRootGI,
 *      summaryStateView.blockRoots.node
 *    );
 *    ```
 * 3. Compute the gindex *within* that inserted subtree for the desired block root:
 *    ```ts
 *    const blockRootsGI = summaryStateView
 *      .blockRoots
 *      .type
 *      .getPropertyGindex(rootIndex) as bigint;
 *    ```
 * 4. Concatenate the two gindices (the path into the summary‐root and the path
 *    inside the blockRoots subtree) into one absolute gindex:
 *    ```ts
 *    const gI = concatGindices([blockSummaryRootGI, blockRootsGI]);
 *    ```
 * 5. Finally, call the low-level proof generator on the patched tree's root:
 *    ```ts
 *    return createProof(patchedTree.rootNode, {
 *      type: ProofType.single,
 *      gindex: gI,
 *    }) as SingleProof;
 *    ```
 *
 * This "ugly hack" is necessary because the original `finalizedStateView` only
 * holds accumulator metadata at that position, not real branch nodes. By injecting
 * the real `blockRoots.node` you force the tree to materialize the correct
 * hashes and produce a valid Merkle proof that the block root is indeed part of
 * the finalized state.
 */
export function generateHistoricalStateProof(
  finalizedStateView: SupportedStateView,
  summaryStateView: SupportedStateView,
  summaryIndex: number,
  rootIndex: number,
): SingleProof {
  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = new Tree(finalizedStateView.node);
  const blockSummaryRootGI = finalizedStateView.type.getPathInfo([
    'historicalSummaries',
    summaryIndex,
    'blockSummaryRoot',
  ]).gindex;
  patchedTree.setNode(blockSummaryRootGI, summaryStateView.blockRoots.node);
  const blockRootsGI = summaryStateView.blockRoots.type.getPropertyGindex(rootIndex) as bigint;
  const gI = concatGindices([blockSummaryRootGI, blockRootsGI]);
  const proof = createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;
  const value = summaryStateView.blockRoots.getReadonly(rootIndex);
  verifyProof(finalizedStateView.hashTreeRoot(), gI, proof.witnesses, value);
  return proof;
}

// port of https://github.com/ethereum/go-ethereum/blob/master/beacon/merkle/merkle.go
export function verifyProof(root: Uint8Array, gI: bigint, proof: Uint8Array[], value: Uint8Array) {
  console.log('Local verification parameters:', {
    root: toHex(root),
    gindex: gI.toString(16),
    proofLength: proof.length,
    proof: proof.map((p) => toHex(p)),
    value: toHex(value),
  });
  let buf = value;

  proof.forEach((p) => {
    const hasher = createHash('sha256');
    if (gI % 2n == 0n) {
      hasher.update(buf);
      hasher.update(p);
    } else {
      hasher.update(p);
      hasher.update(buf);
    }
    buf = hasher.digest();
    gI >>= 1n;
    if (gI == 0n) {
      throw new Error('Branch has extra item');
    }
  });

  if (gI != 1n) {
    throw new Error('Branch is missing items');
  }

  if (toHex(root) != toHex(buf)) {
    throw new Error('Proof is not valid');
  }
}

export function toHex(value: Uint8Array) {
  return '0x' + Buffer.from(value).toString('hex');
}
