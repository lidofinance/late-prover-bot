#!/usr/bin/env bash
#
# Run a proof built by this bot through the ValidatorExitDelayVerifier from a lido/core branch,
# against a fork of a live devnet. See README.md for what it proves and what it fakes.
#
#   CL_API_URLS=<cl> EL_API_URL=<el> LIDO_LOCATOR=<addr> ./test/e2e-verifier/run.sh
#
# Environment:
#   CORE_REPO   path to a lido/core checkout          (default ../core)
#   CORE_REF    commit holding the verifier under test (default: the lidofinance/core#1940 head it
#               was last run against; move it together with the ABI in src/common/contracts/abi)
#   FIXTURE     reuse an existing fixture instead of regenerating it
#   ETCH        false runs the full calls against the verifier already deployed on the devnet
set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE_REPO="${CORE_REPO:-$BOT_DIR/../core}"
CORE_REF="${CORE_REF:-28a94485ffdf09e09e7b46f7cfb7b59ad3228e35}"
WORKTREE="$(mktemp -d)/core-e2e"

: "${EL_API_URL:?set EL_API_URL to the devnet execution node}"

cleanup() {
  git -C "$CORE_REPO" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. A fixture: real chain data, with the beacon roots entry read back from the predeploy so a stale
#    fixture fails here rather than passing silently on chain.
if [[ -n "${FIXTURE:-}" ]]; then
  echo "==> reusing fixture $FIXTURE"
  if [[ "$(realpath "$FIXTURE")" != "$(realpath "$BOT_DIR/test/e2e-verifier/fixture.json")" ]]; then
    cp "$FIXTURE" "$BOT_DIR/test/e2e-verifier/fixture.json"
  fi
else
  : "${CL_API_URLS:?set CL_API_URLS to the devnet consensus node}"
  : "${LIDO_LOCATOR:?set LIDO_LOCATOR to the devnet LidoLocator address}"
  echo "==> building a fixture from the live devnet"
  (cd "$BOT_DIR" && TS_NODE_COMPILER_OPTIONS='{"esModuleInterop":true}' \
    NODE_OPTIONS=--experimental-vm-modules \
    npx ts-node -r tsconfig-paths/register scripts/devnet-proof-fixture.ts test/e2e-verifier/fixture.json)
fi

# 2. The contract under test, from the core branch. A worktree keeps that checkout untouched;
#    node_modules is borrowed from it for the Solidity imports.
echo "==> checking out $CORE_REF of $CORE_REPO"
git -C "$CORE_REPO" worktree add -q --detach "$WORKTREE" "$CORE_REF"
ln -sfn "$CORE_REPO/node_modules" "$WORKTREE/node_modules"
# Submodules are not checked out in a worktree; git leaves an empty directory in their place
rmdir "$WORKTREE/foundry/lib/forge-std" 2>/dev/null || true
ln -sfn "$CORE_REPO/foundry/lib/forge-std" "$WORKTREE/foundry/lib/forge-std"

cp "$BOT_DIR/test/e2e-verifier/"*.t.sol "$WORKTREE/test/0.8.25/"
mkdir -p "$WORKTREE/test/fixtures"
cp "$BOT_DIR/test/e2e-verifier/fixture.json" "$WORKTREE/test/fixtures/gloas-devnet-proof.json"

# vm.readFile needs the fixture directory allow-listed
if ! grep -q 'fs_permissions' "$WORKTREE/foundry.toml"; then
  perl -0pi -e 's/\[profile\.default\]\n/[profile.default]\nfs_permissions = [{ access = "read", path = ".\/test\/fixtures" }]\n/' \
    "$WORKTREE/foundry.toml"
fi

# 3. First the proofs on their own, then the whole call against the forked protocol.
echo "==> forge test"
cd "$WORKTREE"
FIXTURE=test/fixtures/gloas-devnet-proof.json EL_API_URL="$EL_API_URL" ETCH="${ETCH:-true}" \
  forge test --match-path 'test/0.8.25/gloasVerifierDevnet*' -v
