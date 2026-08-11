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
That is the spec's own test, without the state - `process_parent_execution_payload` compares the
child's `bid.parent_block_hash` against `state.latest_execution_payload_bid.block_hash`, which is
where the parent's bid was recorded when the parent was processed.

Two things that do *not* create a missing bid, and so need no special case here:

- **A self-built block.** A proposer building without a builder still submits a bid, with
  `builder_index = BUILDER_INDEX_SELF_BUILD` (`UINT64_MAX`), `value = 0` and the signature set to the
  G2 point at infinity; `parent_block_hash` and `block_hash` are real. Every proposer on the devnet
  self-builds, which is exactly the shape the code was exercised against.
- **An "empty" parent.** In the spec that word describes a parent whose *payload* was withheld, not a
  block without a bid. `signed_execution_payload_bid` is a plain member of `BeaconBlockBody`, and a
  zeroed bid cannot pass `bid.parent_block_hash == state.latest_block_hash`, so every valid post-fork
  block carries a bid with the real hash.

This applies to the **recent** block a submission is anchored on — the finalized block whose state
also carries the `block_roots` ring and the historical summaries. Moving that anchor forward is
harmless: it changes neither the delay the verifier computes nor the block the validators are proven
at, both of which come from the target block (see section 4). The cost is that the anchor may sit a
slot or two ahead of finalization, where a reorg would make the submission revert.

## What does not change

**Deadline math.** `eligibleExitRequestTimestamp`, the shard committee period, the exit deadline
threshold and the resulting deadline slot/epoch are pure consensus-layer quantities. EIP-7732 does
not touch validator records, so the deadline is still computed and proven the same way. In particular
the block the validators are proven at is **not** shifted to the child block the way `lido-oracle`
shifts its reference blockstamp — the oracle does that because it needs EL-derived data (block hash,
deposits, withdrawals) to be settled, while this bot only needs the validator registry.

## 3. No fixed number of execution blocks per slot

Pre-fork a slot either had a block, payload included, or was missed. From Gloas on a slot can have a
block *and* no execution block, so "one execution block per 12 s" is a weaker assumption than it
already was. Three places relied on it:

- `ProverService.resolveLookbackFromBlock` (was `days * 86400 / 12` execution blocks back): since a
  slot produces at most one execution block, that count always reaches *further* back than
  `START_LOOKBACK_DAYS` asks for, and the drift grows with the share of slots that produce none. On
  the devnet a one-day window started ~12 h too early (block 115006 instead of 117376). It never
  loses events, it just scans a window whose length nobody configured. Now the start block is the
  execution anchor of the slot at the lookback timestamp.
- `RootsProvider.getPrevRoot`: the lookback slot may never have been proposed, and asking for a
  missed slot 404s — the daemon was then left without a starting root, cycle after cycle. Now it
  scans forward. (Not Gloas-specific, but far more likely on a chain with frequent missed slots: the
  devnet had 397 missed slots in 1197.)
- `RootsProcessor`: an empty EL range is now legitimate (two consecutive anchors can be the same
  block), so the per-block timing log no longer divides by zero.

Left as is, deliberately:

- `BLOCKS_PER_HOUR` in `execution.ts` sizes the gas fee history cache. Fewer blocks per hour means the
  cache refreshes less often and spans more time than configured — a heuristic for fee estimation,
  not a correctness invariant.
- A 404 for a missed slot still goes through the generic retry policy (two retries, ~1.5 s, two
  `warn` lines per missed slot). Skipping retries on 404 would be wrong near the chain tip, where the
  node may simply not have imported the block yet and the retry is what saves the cycle. On a chain
  with many missed slots this shows up as log noise during anchor resolution; it is not a failure.

## 4. The verifier's Gloas shape (lidofinance/core#1940)

The Gloas verifier does not anchor the deadline block through EIP-4788 any more:

```solidity
verifyValidatorExitDelay(
    ProvableBeaconBlockHeader recentBlock,   // root read from EIP-4788
    BlockRootsHeaderWitness  targetBlock,    // proven against recentBlock.header.stateRoot
    ValidatorWitness[]       witnesses,      // proven against targetBlock.header.stateRoot
    ExitRequestData          exitRequests)
```

That resolves the withheld-payload problem for the deadline block outright: its root is read out of
the recent state's `block_roots` ring, so it no longer matters whether an execution block carried its
successor's timestamp. Only the recent block still needs an entry in the beacon roots buffer, which
is what `resolveProvableAnchor` guarantees for the finalized anchor.

Consequences for the bot:

- the deadline block is simply the first proposed block at or after the deadline - no forward walk;
- `proofSlotTimestamp` comes from the target block, so moving it would change the reported delay;
- the current-slot path is bounded by `recentSlot - targetSlot <= SLOTS_PER_HISTORICAL_ROOT`, the
  size of the ring, which is exactly where the historical-summaries path takes over;
- a deadline that is not yet behind the finalized anchor waits for the next cycle rather than being
  proven against a state that cannot contain it.

## Progressive SSZ lists (EIP-7916)

Glamsterdam also brings **EIP-7916 progressive SSZ lists**. In the current spec `BeaconState` is a
`ProgressiveContainer` and `Validators` is a `ProgressiveList`, which re-merkleizes the registry:

| | `validators[0]` gindex | `validators[n] - validators[0]` |
|---|---|---|
| Electra / Fulu | `164926744166400` | `n` |
| Gloas | `1432` | not `n` (grows in subtrees) |

The verifier in lidofinance/core#1940 handles this: post-pivot it derives the leaf as
`GI_VALIDATORS.concat(progressiveListNodeGIndex(index))` instead of `GI_FIRST_VALIDATOR + index`.
Verified against a live devnet - the contract's index matches the one SSZ computes off the real
state, and a proof built by this bot is accepted end to end, down to the module recording the delay.
The bot side needs no arithmetic of its own: it asks SSZ for the generalized index. `proofs.spec.ts`
pins the difference between the forks.

## Dependency

`@lodestar/types` is pinned to **1.46.0-rc.1**, the first version whose Gloas containers hash the
same way the devnet clients do:

- 1.34.x aliases `ssz.gloas` to the Fulu containers, so post-fork blocks and states decode with the
  wrong layout, silently.
- 1.45.0 (current `latest`) predates EIP-7916. It serializes a Gloas state byte-identically to what
  the node serves, but hashes it to a different root, so every proof built from it would be rejected.
  This is easy to miss precisely because deserialization succeeds.

Move to 1.46.0 final once it is released. Whenever the Gloas spec moves, re-run the devnet check
below rather than trusting a green unit suite.

## Devnet check

`scripts/devnet-gloas-check.ts` runs the real provider and the real anchor resolution against a
Gloas node and validates every conclusion against the chain (EIP-4788 buffer contents, EL block
existence, state root vs the block header):

```bash
CL_API_URLS=<cl> EL_API_URL=<el> npx ts-node -r tsconfig-paths/register scripts/devnet-gloas-check.ts
```

It covers block decoding, the EL anchor, the payload-revealed predicate against the ring buffer, the
anchors the prover would submit, the state at the anchor slot with a validator proof, and the
historical-summaries proof.

Last run against `glamsterdam-kurtosis-7` (Lighthouse v8.2.0 / Besu, `GLOAS_FORK_EPOCH=3`): all
checks pass. Over 1197 slots that devnet had 397 missed slots and **no withheld payloads** — every
proposer self-builds (`builder_index = BUILDER_INDEX_SELF_BUILD`) — so the missed-slot path is
exercised against real data while the withheld-payload path is covered by unit tests only.

## Dry-run against the devnet

With a `LidoLocator` deployed on the devnet the whole daemon loop was run with `DRY_RUN=true` (which
stops after the `callStatic` emulation, before any transaction is sent):

```
Initializing storage with recent validator events...
Found available slot 170892            # lookback window resolved through the CL
Scanning ... Current block: 122206, From block: 117376, range 4830 blocks (1 days)
Found available slot 177955 (requested: 177953, missed: 2)
Fetching beacon state at slot 177952 -> 3281761 bytes, fork: gloas
Batch 1/1: Found 9 exit requests       # decoded, dataFormat 2
Processing accumulated validators from storage: current slot 177952
Block range processing completed: 117376 -> 122106, 4730 blocks
Successfully processed roots transition: slot 170892 -> 177952
```

The devnet has exit requests but all with an empty validator list, so no proof was built and nothing
reached the verifier — expected, and the part that is blocked on the contract anyway.

## Known gap (pre-existing)

`isSlotOld` switches to the historical-summaries proof at `SLOTS_PER_HISTORICAL_ROOT` (8192 slots),
while the EIP-4788 ring buffer only holds 8191 slots (~27 h). A deadline slot in that one-slot gap
is proven through the current-slot path against a root that has already been evicted.
