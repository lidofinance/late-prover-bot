// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {BeaconBlockHeader, Validator} from "contracts/common/lib/BeaconTypes.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {ValidatorExitDelayVerifier__Harness} from "./contracts/ValidatorExitDelayVerifier__Harness.sol";

/**
 * Feeds proofs built by late-prover-bot from a live Gloas devnet through the verifier's own
 * generalized index derivation.
 *
 * The fixture (scripts/devnet-proof-fixture.ts in late-prover-bot) carries real chain data and
 * proofs made by the bot's own helpers. Nothing here is synthesised, so a passing run means the bot
 * and the contract agree on the state layout on both sides of the fork - including the
 * progressive-list validator index introduced by EIP-7916 and a pre-Gloas block proven from a
 * Gloas state.
 *
 * FIXTURE=<path> forge test --match-path test/0.8.25/gloasVerifierDevnet.t.sol
 */
contract GloasVerifierDevnetTest is Test {
    using stdJson for string;

    string internal fixture;
    ValidatorExitDelayVerifier__Harness internal verifier;

    function setUp() public {
        fixture = vm.readFile(vm.envOr("FIXTURE", string("fixture.json")));

        uint64 capellaSlot = uint64(fixture.readUint(".chain.capellaSlot"));
        verifier = new ValidatorExitDelayVerifier__Harness(
            fixture.readAddress(".chain.lidoLocator"),
            capellaSlot, // firstSupportedSlot
            uint64(fixture.readUint(".chain.gloasSlot")),
            capellaSlot,
            uint64(fixture.readUint(".chain.slotsPerHistoricalRoot")),
            uint32(fixture.readUint(".chain.slotsPerEpoch")),
            uint32(fixture.readUint(".chain.secondsPerSlot")),
            uint64(fixture.readUint(".chain.genesisTime")),
            uint32(fixture.readUint(".chain.shardCommitteePeriodInSeconds"))
        );
    }

    /// SSZ computed these indices off the real states; the contract derives its own. If they ever
    /// diverge, every proof the bot builds for that layout is rejected on chain.
    function test_validatorGIndexMatchesSSZ() public view {
        _assertValidatorGIndex(".current.validator", fixture.readUint(".current.block.slot"));
        _assertValidatorGIndex(".historical.validator", fixture.readUint(".historical.old.slot"));
        _assertValidatorGIndex(".historicalPreGloas.validator", fixture.readUint(".historicalPreGloas.old.slot"));
    }

    function test_currentValidatorProofVerifies() public view {
        _verifyValidator(".current.validator", ".current.block");
    }

    function test_historicalBlockProofVerifies() public {
        _verifyHistoricalBlock(".historical");
    }

    function test_historicalValidatorProofVerifies() public view {
        _verifyValidator(".historical.validator", ".historical.old");
    }

    /// The anchor is a Gloas state, the proven block is not: the summary index is taken from the
    /// Gloas layout and the validator index from the pre-Gloas one
    function test_preGloasBlockProvenFromGloasState() public {
        assertLt(fixture.readUint(".historicalPreGloas.old.slot"), fixture.readUint(".chain.gloasSlot"));
        assertGe(fixture.readUint(".historicalPreGloas.anchor.slot"), fixture.readUint(".chain.gloasSlot"));

        _verifyHistoricalBlock(".historicalPreGloas");
        _verifyValidator(".historicalPreGloas.validator", ".historicalPreGloas.old");
    }

    /// The same proof must not verify at a neighbouring validator index. Progressive lists make the
    /// branch length depend on the index, so this can fail on the branch length rather than the root.
    function test_validatorProofFailsAtWrongIndex() public {
        uint64 slot = uint64(fixture.readUint(".current.block.slot"));
        GIndex wrongGI = verifier.getValidatorGI(fixture.readUint(".current.validator.index") + 1, slot);
        bytes32[] memory proof = fixture.readBytes32Array(".current.validator.witness.validatorProof");
        bytes32 root = fixture.readBytes32(".current.block.stateRoot");
        bytes32 leaf = SSZ.hashTreeRoot(_validator(".current.validator"));

        vm.expectRevert();
        this.verifyProofExternal(proof, root, leaf, wrongGI);
    }

    /// SSZ.verifyProof takes the proof as calldata, so it is reached through an external call
    function verifyProofExternal(bytes32[] calldata proof, bytes32 root, bytes32 leaf, GIndex gI) external view {
        SSZ.verifyProof({proof: proof, root: root, leaf: leaf, gI: gI});
    }

    function _assertValidatorGIndex(string memory key, uint256 stateSlot) internal view {
        GIndex actual = verifier.getValidatorGI(fixture.readUint(string.concat(key, ".index")), uint64(stateSlot));
        assertEq(actual.unwrap(), fixture.readUint(string.concat(key, ".gindex")), key);
    }

    /// The validator, proven against the state root of `block`, with the leaf rebuilt exactly the way
    /// the verifier rebuilds it - exitEpoch pinned to FAR_FUTURE_EPOCH
    function _verifyValidator(string memory key, string memory blockKey) internal view {
        this.verifyProofExternal(
            fixture.readBytes32Array(string.concat(key, ".witness.validatorProof")),
            fixture.readBytes32(string.concat(blockKey, ".stateRoot")),
            SSZ.hashTreeRoot(_validator(key)),
            verifier.getValidatorGI(
                fixture.readUint(string.concat(key, ".index")),
                uint64(fixture.readUint(string.concat(blockKey, ".slot")))
            )
        );
    }

    /// The old block's header, proven against the anchor state's historical summaries
    function _verifyHistoricalBlock(string memory key) internal {
        uint64 anchorSlot = uint64(fixture.readUint(string.concat(key, ".anchor.slot")));
        uint64 oldSlot = uint64(fixture.readUint(string.concat(key, ".old.slot")));

        this.verifyProofExternal(
            fixture.readBytes32Array(string.concat(key, ".old.proof")),
            fixture.readBytes32(string.concat(key, ".anchor.stateRoot")),
            SSZ.hashTreeRoot(_header(string.concat(key, ".old"))),
            verifier.getHistoricalBlockRootGI(anchorSlot, oldSlot)
        );
    }

    function _header(string memory key) internal view returns (BeaconBlockHeader memory) {
        return
            BeaconBlockHeader({
                slot: uint64(fixture.readUint(string.concat(key, ".slot"))),
                proposerIndex: uint64(fixture.readUint(string.concat(key, ".proposerIndex"))),
                parentRoot: fixture.readBytes32(string.concat(key, ".parentRoot")),
                stateRoot: fixture.readBytes32(string.concat(key, ".stateRoot")),
                bodyRoot: fixture.readBytes32(string.concat(key, ".bodyRoot"))
            });
    }

    function _validator(string memory key) internal view returns (Validator memory) {
        return
            Validator({
                pubkey: fixture.readBytes(string.concat(key, ".pubkey")),
                withdrawalCredentials: fixture.readBytes32(string.concat(key, ".witness.withdrawalCredentials")),
                effectiveBalance: uint64(fixture.readUint(string.concat(key, ".witness.effectiveBalance"))),
                slashed: fixture.readBool(string.concat(key, ".witness.slashed")),
                activationEligibilityEpoch: uint64(
                    fixture.readUint(string.concat(key, ".witness.activationEligibilityEpoch"))
                ),
                activationEpoch: uint64(fixture.readUint(string.concat(key, ".witness.activationEpoch"))),
                exitEpoch: type(uint64).max,
                withdrawableEpoch: uint64(fixture.readUint(string.concat(key, ".witness.withdrawableEpoch")))
            });
    }
}
