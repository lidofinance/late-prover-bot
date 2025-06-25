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

export function generateWithdrawalProof(
  stateView: SupportedStateView,
  blockView: SupportedBlockView,
  withdrawalOffset: number,
): SingleProof {
  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = new Tree(stateView.node);
  const stateWdGindex = stateView.type.getPathInfo(['latestExecutionPayloadHeader', 'withdrawalsRoot']).gindex;
  patchedTree.setNode(stateWdGindex, blockView.body.executionPayload.withdrawals.node);
  const withdrawalGI = blockView.body.executionPayload.withdrawals.type.getPropertyGindex(withdrawalOffset) as bigint;
  const gI = concatGindices([stateWdGindex, withdrawalGI]);
  return createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;
}

/**
 * Validates that a gindex is well-formed and represents a valid path in a binary tree.
 * A valid gindex must:
 * 1. Be greater than 1 (1 is the root)
 * 2. Have a leading 1 bit
 * 3. Have the correct number of bits for its position in the tree
 */
function validateGindex(gindex: bigint, description: string): void {
  if (gindex <= 1n) {
    throw new Error(`Invalid ${description}: must be > 1`);
  }

  const binary = gindex.toString(2);
  if (!binary.startsWith('1')) {
    throw new Error(`Invalid ${description}: must start with 1`);
  }

  // The number of bits (including leading 1) should match the path length
  const expectedBits = binary.length;
  const actualBits = gindex.toString(2).length;
  if (actualBits !== expectedBits) {
    throw new Error(`Invalid ${description}: bit length mismatch (expected ${expectedBits}, got ${actualBits})`);
  }
}

/**
 * Concatenates two gindices while ensuring proper bit handling.
 * The resulting gindex will have the correct number of bits for the combined path.
 */
function concatGindicesWithValidation(gindexA: bigint, gindexB: bigint): bigint {
  // Get binary representations (including leading 1)
  const binaryA = gindexA.toString(2);
  const binaryB = gindexB.toString(2);

  // Calculate bit lengths (excluding leading 1)
  const bitsA = binaryA.length - 1;
  const bitsB = binaryB.length - 1;

  // The new gindex should have bitsA + bitsB significant bits
  const expectedBits = bitsA + bitsB;

  // Use library's concatGindices
  const result = concatGindices([gindexA, gindexB]);

  // Validate the result
  const resultBinary = result.toString(2);
  const actualBits = resultBinary.length - 1;

  if (actualBits !== expectedBits) {
    throw new Error(
      `Gindex concatenation produced invalid result: ` +
      `expected ${expectedBits} bits but got ${actualBits} bits\n` +
      `Input A (${bitsA} bits): ${binaryA}\n` +
      `Input B (${bitsB} bits): ${binaryB}\n` +
      `Result (${actualBits} bits): ${resultBinary}`
    );
  }

  return result;
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
  // Get the path to the historical summary root
  const historicalSummaryPath = finalizedStateView.type.getPathInfo([
    'historicalSummaries',
    summaryIndex,
    'blockSummaryRoot',
  ]);

  // Get the path to the specific block root within the summary
  const blockRootPath = summaryStateView.blockRoots.type.getPathInfo([rootIndex]);

  // Create a patched tree with the block roots from the summary state
  const patchedTree = new Tree(finalizedStateView.node);
  patchedTree.setNode(historicalSummaryPath.gindex, summaryStateView.blockRoots.node);

  // Calculate the combined gindex
  const historicalGI = BigInt(historicalSummaryPath.gindex);
  const blockRootGI = BigInt(blockRootPath.gindex);

  // Count significant bits (excluding leading 1)
  const countSignificantBits = (n: bigint): number => {
    const binary = n.toString(2);
    // Remove leading 1 and count remaining bits
    return binary.length - 1;
  };

  const historicalBits = countSignificantBits(historicalGI);
  const blockRootBits = countSignificantBits(blockRootGI);

  console.log('Gindex components:', {
    historicalGI: historicalGI.toString(16),
    blockRootGI: blockRootGI.toString(16),
    historicalBits,
    blockRootBits,
    historicalBinary: historicalGI.toString(2),
    blockRootBinary: blockRootGI.toString(2),
  });

  // Validate the gindices
  validateGindex(historicalGI, 'historical gindex');
  validateGindex(blockRootGI, 'block root gindex');

  // Calculate the combined gindex
  const gI = concatGindices([historicalGI, blockRootGI]);
  const gIBits = countSignificantBits(gI);

  // The number of witnesses should be equal to the number of significant bits
  const expectedWitnesses = gIBits;

  console.log('Final gindex:', {
    gI: gI.toString(16),
    gIBinary: gI.toString(2),
    gIBits,
    expectedWitnesses,
    historicalGI: historicalGI.toString(16),
    blockRootGI: blockRootGI.toString(16),
  });

  // Create proof from the patched tree
  const proof = createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;

  // Verify that we have the correct number of witnesses
  if (proof.witnesses.length !== expectedWitnesses) {
    throw new Error(
      `Witness count mismatch: expected ${expectedWitnesses} but got ${proof.witnesses.length}\n` +
      `Gindex binary (${gIBits} bits): ${gI.toString(2)}\n` +
      `Historical gindex (${historicalBits} bits): ${historicalGI.toString(2)}\n` +
      `Block root gindex (${blockRootBits} bits): ${blockRootGI.toString(2)}`
    );
  }

  // Verify each witness is a valid 32-byte value
  proof.witnesses.forEach((witness, index) => {
    if (witness.length !== 32) {
      throw new Error(
        `Invalid witness at index ${index}: length ${witness.length} (expected 32)\n` +
        `Witness: ${toHex(witness)}`
      );
    }
  });

  // Log the proof details
  console.log('Generated proof details: ', {
    gindex: gI.toString(),
    hexGindex: '0x' + gI.toString(16).padStart(64, '0'),
    proofLength: proof.witnesses.length,
    expectedWitnesses,
    witnesses: proof.witnesses.map(w => toHex(w))
  });

  // Verify the proof locally before returning
  try {
    const value = summaryStateView.blockRoots.getReadonly(rootIndex);
    verifyProof(patchedTree.rootNode.root, gI, proof.witnesses, value);
    console.log('Local proof verification succeeded');
  } catch (error) {
    console.error('Local proof verification failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        gindexBits: gI.toString(2),
        proofLength: proof.witnesses.length,
        expectedWitnesses,
        historicalBits,
        blockRootBits,
      });
    }
    throw error;
  }

  return proof;
}

// port of https://github.com/ethereum/go-ethereum/blob/master/beacon/merkle/merkle.go
export function verifyProof(root: Uint8Array, gI: bigint, proof: Uint8Array[], value: Uint8Array) {
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
