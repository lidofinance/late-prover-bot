# End-to-end: proofs from this bot through the Gloas verifier

Runs proofs built by this bot's own code, from a live Gloas devnet, through `ValidatorExitDelayVerifier`
from [lidofinance/core#1940](https://github.com/lidofinance/core/pull/1940), on a fork of that devnet's
execution layer.

```bash
CL_API_URLS=<cl> EL_API_URL=<el> LIDO_LOCATOR=<addr> ./test/e2e-verifier/run.sh
```

The script needs a `lido/core` checkout (`CORE_REPO`, default `../core`) holding `CORE_REF` and `forge` on
PATH. It works in a temporary git worktree and removes it afterwards, so the core checkout is left
untouched.

| Variable | Default | |
|---|---|---|
| `CORE_REF` | `28a94485ffdf09e09e7b46f7cfb7b59ad3228e35` | The core#1940 head the ABI in `src/common/contracts/abi` is built from. Move both together. |
| `FIXTURE` | regenerated | Reuse a fixture instead of building one from the devnet. |
| `ETCH` | `true` | `false` runs the full calls against the verifier already deployed on the devnet. |

## What is proven

The fixture (`scripts/devnet-proof-fixture.ts`) makes every proof with the bot's own helpers, the way the
prover makes it:

- `current` — a recent Gloas block whose root is **read back from the EIP-4788 predeploy**, and a Lido
  validator proven against its state: the `verifyValidatorExitDelay` path;
- `historical` — an older Gloas block proven through the historical summaries of the finalized anchor,
  and the same validator proven against the old state: the `verifyHistoricalValidatorExitDelay` path;
- `historicalPreGloas` — a block from before the fork proven from the Gloas anchor, where the verifier
  takes the summary index from one layout and the validator index from the other. Proof-level only:
  Lido keys may not exist that early.

`gloasVerifierDevnet.t.sol` needs no fork. It checks that the generalized indices the contract derives
equal the ones SSZ computed off the real states, and that every proof verifies under them.

`gloasVerifierDevnetFork.t.sol` makes both full calls on the fork and asserts that the staking module
recorded the delay for the proven key, plus a negative case for each: a wrong `rootsTimestamp` and an
old block claimed at the wrong slot.

## What is arranged

Neither is Gloas-specific:

1. **The upgrade is not a real upgrade.** With `ETCH` the verifier built from `CORE_REF` is `vm.etch`ed
   onto the address `LidoLocator` points at, because `StakingRouter` grants
   `REPORT_VALIDATOR_EXITING_STATUS_ROLE` to exactly that address and the verifier keeps its
   configuration in immutables. The governance path an actual upgrade would take is not covered.
2. **`IValidatorsExitBus.getDeliveryTimestamp` is mocked** to a moment before the validator became
   eligible to exit, since a fork cannot have submitted an exit request in its own past. The reported
   delay is still derived from chain data.

## Last run

`lido-gloas-csn-1` (Lighthouse v8.3.0-rc.0 / Geth v1.17.7, `GLOAS_FORK_EPOCH=113`), core at `28a9448`,
10/10 green both with `ETCH=true` and against the verifier deployed there:

```
current: slot 36288, rootsTimestamp 1791986231
anchor: slot 36351, rootsTimestamp 1791986987
historical: slot 28672 (Gloas), slot 3552 (pre-Gloas, fork at 3616)
validator: 0x9948ea3862b88896 (key 3 of module 1)
```

The committed `fixture.json` is from that run. Regenerate it whenever the devnet, the spec or the client
versions move; a fixture older than the EIP-4788 ring buffer (~27 h) fails on the fork.
