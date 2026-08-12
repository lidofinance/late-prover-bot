# End-to-end: a proof from this bot through the Gloas verifier

Runs a proof built by this bot's own code, from a live Gloas devnet, through
`ValidatorExitDelayVerifier` as it exists in [lidofinance/core#1940](https://github.com/lidofinance/core/pull/1940),
on a fork of that devnet's execution layer.

```bash
CL_API_URLS=<cl> EL_API_URL=<el> LIDO_LOCATOR=<addr> ./test/e2e-verifier/run.sh
```

The script needs a `lido/core` checkout (`CORE_REPO`, default `../core`) to take the contract from
(`CORE_REF`, default `origin/gloas-verifier`) and `forge` on PATH. It works in a temporary git
worktree and removes it afterwards, so the core checkout is left untouched. `FIXTURE=<path>` reuses a
fixture instead of regenerating one.

## What is real

Everything the proof is made of comes off the chain:

- `recent` — a finalized block whose root the generator **reads back from the EIP-4788 predeploy** at
  the `rootsTimestamp` it computed, so a stale fixture fails at generation time instead of passing
  silently on chain;
- `target` — an older block, proven against `recent.header.stateRoot` through `state.block_roots`;
- `validator` — a Lido key of module 1 / operator 0 that is actually deposited on that devnet, proven
  against `target.header.stateRoot`;
- `exitRequests` — a `dataFormat = 2` blob for that key, unpacked by the **real** VEB on the fork;
- the report lands in the real `StakingRouter` and `NodeOperatorsRegistry`, which records the delay.

## What is faked, and why

Both are deliberate and neither is Gloas-specific:

1. **The upgrade is not a real upgrade.** The new verifier is deployed and its runtime code is
   `vm.etch`ed onto the address `LidoLocator` already points at, because `StakingRouter` grants
   `REPORT_VALIDATOR_EXITING_STATUS_ROLE` to exactly that address and the verifier keeps all of its
   configuration in immutables, which live in runtime code. The governance/proxy path an actual
   upgrade would take is **not** covered here.
2. **`IValidatorsExitBus.getDeliveryTimestamp` is mocked** to a moment before the validator became
   eligible to exit. A fork cannot be made to have submitted an exit request in its own past. The
   delay that gets reported is still derived from chain data, since the contract takes
   `max(delivered, activationEligible)`.

## The two suites

`gloasVerifierDevnet.t.sol` — no fork needed. Checks that the generalized indices the contract derives
equal the ones SSZ computed off the real Gloas state, and that both proofs verify. This is the part
EIP-7916 makes worth pinning: `Validators` is a progressive list, so the leaf index is no longer
`GI_FIRST_VALIDATOR + validatorIndex` and is not even linear in the index.

`gloasVerifierDevnetFork.t.sol` — the whole call on the fork, asserting the module recorded the delay
for the proven key, plus a negative case where the target block's slot is shifted by one.

## Last run

`glamsterdam-kurtosis-7` (Lighthouse v8.2.0 / Besu, `GLOAS_FORK_EPOCH=3`), core at
`origin/gloas-verifier`, 7/7 green:

```
recent slot 180064 (rootsTimestamp 1786460801, verified against EIP-4788)
target slot 180000 (block_roots[7968])
validator 385 0x92f46b0dcc7db24f

emit ValidatorExitStatusUpdated(nodeOperatorId: 0,
  publicKey: 0x92f46b0dcc7db24f...,
  eligibleToExitInSec: 2011776,     # from activation epoch 130 + shard committee period
  proofSlotTimestamp: 1786460021)   # target slot 180000
```

The committed `fixture.json` is from that run. Regenerate it whenever the devnet, the spec or the
client versions move — a fixture older than the EIP-4788 ring buffer (~27 h) will fail at generation.
