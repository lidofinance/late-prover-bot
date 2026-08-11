# EIP-7732 (ePBS): what changes for the late-prover-bot

Spec: [`specs/gloas/beacon-chain.md`](https://github.com/ethereum/consensus-specs/blob/master/specs/gloas/beacon-chain.md)

From Gloas on, a beacon block no longer carries its execution payload. The block only commits to a
bid (`signed_execution_payload_bid`); the payload is revealed afterwards as a separate
`ExecutionPayloadEnvelope`, and it is applied to the beacon state while the **next** block is
processed (`process_parent_execution_payload`). The builder may also never reveal it.

Two independent things in this bot touch that, and they must not be confused:

| Concern | Layer | Effect of EIP-7732 |
|---|---|---|
| Which EL block range to scan for exit requests | EL anchor of a CL block | Read from the bid instead of the embedded payload |
| When a validator must have exited, and what to prove it against | CL only | Deadline math unchanged; only the EIP-4788 lookup needs care |

## 1. EL anchor of a CL block (`Consensus.getExecutionBlockHash`)

The daemon maps the previous and the current finalized CL block to EL block numbers and scans that
range for exit requests.

- Before EIP-7732: `block.body.executionPayload.blockHash`.
- From Gloas on: `block.body.signedExecutionPayloadBid.message.parentBlockHash`.

The bid's `parent_block_hash` is exactly `state.latest_block_hash` of the block's own post state —
`process_execution_payload_bid` asserts the equality, and nothing later in the block changes that
field. So the block body carries the anchor for free and no multi-gigabyte beacon state has to be
downloaded per cycle. (This is the same value `lido-oracle` reads from the state for its report
blockstamps.)

Post-fork the anchor lags the CL block by one slot — it is the payload of the parent slot, or an
older one where payloads were withheld. That is the safe direction for a scan range: both ends of
the range are resolved by the same rule, so the range simply ends short and the remainder is picked
up by the next cycle. Nothing is skipped.

## 2. The proof anchor and EIP-4788 (`ProverService.resolveProvableAnchor`)

`ValidatorExitDelayVerifier` reads a beacon block root out of the EIP-4788 predeploy at
`rootsTimestamp`, checks the submitted header against it, and derives `proofSlotTimestamp` from
`header.slot`. The root of a block is never stored by that block: it is stored by the execution
block of the **next proposed** beacon block, as its `parent_beacon_block_root`
(`envelope.parent_beacon_block_root == block.parent_root`), keyed by that execution block's own
timestamp (`payload.timestamp == compute_time_at_slot(state, state.slot)`).

Two things leave the ring buffer without an entry, and both revert with `RootNotFound()`:

1. **The next slot was missed.** No execution block carries its timestamp. The next *proposed* block
   is the one that stored the root — this is the case fixed in #38.
2. **The next block withheld its payload** (new in Gloas). Again no execution block carries that
   slot's timestamp. Scanning further forward does not help here: the block after it commits to
   *its own* parent, not to ours, so our anchor's root is never written and stays unreachable. The
   anchor itself has to move forward onto that block, and the search repeats.

Whether the payload of a block was revealed is decided from the next block's bid: it must commit to
`state.latest_block_hash`, which equals this block's payload hash only if the payload was applied.

Moving the anchor forward is safe for an exit-delay proof: it proves the validator had still not
exited at a *later* slot, which only increases the delay the verifier computes, and the validator
state is read at that same later slot.

## What does not change

- **Deadline math.** `eligibleExitRequestTimestamp`, the shard committee period, the exit deadline
  threshold and the resulting deadline slot/epoch are pure consensus-layer quantities. EIP-7732 does
  not touch validator records, so the deadline is still computed and proven the same way. In
  particular the proof anchor is **not** shifted to the child block the way `lido-oracle` shifts its
  reference blockstamp — the oracle does that because it needs EL-derived data (block hash, deposits,
  withdrawals) to be settled, while this bot only needs the validator registry.
- **Proof shape.** Gloas adds fields to `BeaconState` but keeps `validators` at the same position
  and the container within 64 fields, so the generalized index the verifier hardcodes is unchanged
  and no new `PIVOT_SLOT` is needed (covered by `proofs.spec.ts`).

## Dependency

Gloas containers require `@lodestar/types` ≥ 1.45.0; earlier versions alias `ssz.gloas` to the Fulu
types, which would silently decode post-fork blocks and states with the wrong layout.

## Known gap (pre-existing)

`isSlotOld` switches to the historical-summaries proof at `SLOTS_PER_HISTORICAL_ROOT` (8192 slots),
while the EIP-4788 ring buffer only holds 8191 slots (~27 h). A deadline slot in that one-slot gap
is proven through the current-slot path against a root that has already been evicted.
