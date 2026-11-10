// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {BeaconBlockHeader} from "contracts/common/lib/BeaconTypes.sol";
import {
    ValidatorExitDelayVerifier,
    ProvableBeaconBlockHeader,
    HistoricalHeaderWitness,
    ValidatorWitness,
    ExitRequestData
} from "contracts/0.8.25/ValidatorExitDelayVerifier.sol";

interface ILocator {
    function validatorExitDelayVerifier() external view returns (address);
    function validatorsExitBusOracle() external view returns (address);
    function stakingRouter() external view returns (address);
}

interface IVEB {
    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256);
}

/**
 * End-to-end run of late-prover-bot proofs against a live Gloas devnet, forked.
 *
 * The proofs are real (see gloasVerifierDevnet.t.sol for the fixture), the chain state is real - the
 * EIP-4788 roots come out of the forked predeploy, and the report lands in the real StakingRouter and
 * staking module for a Lido key that is actually deposited on that devnet. Both entry points the bot
 * calls are exercised: the current path and the historical-summaries path.
 *
 * Two things are arranged rather than observed, neither of them Gloas-specific:
 *   - with ETCH (the default) the verifier built from the pinned core commit is etched onto the
 *     address the LidoLocator points at, since StakingRouter authorises exactly that address. With
 *     ETCH=false the verifier already deployed on the devnet is used as is;
 *   - the VEB delivery timestamp is mocked to a moment before the validator became eligible to exit,
 *     because a fork cannot be made to have submitted an exit request in its own past. The reported
 *     delay is therefore still derived from real chain data, not from the mock.
 *
 * EL_API_URL=<el> FIXTURE=<path> forge test --match-path test/0.8.25/gloasVerifierDevnetFork.t.sol
 */
contract GloasVerifierDevnetForkTest is Test {
    using stdJson for string;

    event ValidatorExitStatusUpdated(
        uint256 indexed nodeOperatorId,
        bytes publicKey,
        uint256 eligibleToExitInSec,
        uint256 proofSlotTimestamp
    );

    string internal fixture;
    address internal verifierAddress;
    address internal veb;

    function setUp() public {
        vm.createSelectFork(vm.envString("EL_API_URL"));

        fixture = vm.readFile(vm.envOr("FIXTURE", string("test/fixtures/gloas-devnet-proof.json")));
        ILocator locator = ILocator(fixture.readAddress(".chain.lidoLocator"));
        verifierAddress = locator.validatorExitDelayVerifier();
        veb = locator.validatorsExitBusOracle();

        if (vm.envOr("ETCH", true)) {
            uint64 capellaSlot = uint64(fixture.readUint(".chain.capellaSlot"));
            ValidatorExitDelayVerifier deployed = new ValidatorExitDelayVerifier(
                address(locator),
                capellaSlot, // firstSupportedSlot
                uint64(fixture.readUint(".chain.gloasSlot")),
                capellaSlot,
                uint64(fixture.readUint(".chain.slotsPerHistoricalRoot")),
                uint32(fixture.readUint(".chain.slotsPerEpoch")),
                uint32(fixture.readUint(".chain.secondsPerSlot")),
                uint64(fixture.readUint(".chain.genesisTime")),
                uint32(fixture.readUint(".chain.shardCommitteePeriodInSeconds"))
            );
            // The verifier keeps all of its configuration in immutables, so moving the code is
            // enough to run the pinned implementation in the deployed one's place
            vm.etch(verifierAddress, address(deployed).code);
        }
    }

    function test_currentProofIsAcceptedAndReportsTheDelay() public {
        uint256 eligibleSince = _mockDelivery(".current.validator");
        vm.recordLogs();

        ValidatorExitDelayVerifier(verifierAddress).verifyValidatorExitDelay(
            _provable(".current.block"),
            _witnesses(".current.validator"),
            _exitRequests(".current.exitRequests")
        );

        _assertReported(".current", fixture.readUint(".current.block.slot"), eligibleSince);
    }

    function test_historicalProofIsAcceptedAndReportsTheDelay() public {
        uint256 eligibleSince = _mockDelivery(".historical.validator");
        vm.recordLogs();

        ValidatorExitDelayVerifier(verifierAddress).verifyHistoricalValidatorExitDelay(
            _provable(".historical.anchor"),
            _historical(".historical.old"),
            _witnesses(".historical.validator"),
            _exitRequests(".historical.exitRequests")
        );

        _assertReported(".historical", fixture.readUint(".historical.old.slot"), eligibleSince);
    }

    /// The current block, looked up under a timestamp that holds a different root
    function test_currentProofUnderWrongRootsTimestampIsRejected() public {
        _mockDelivery(".current.validator");
        ProvableBeaconBlockHeader memory beaconBlock = _provable(".current.block");
        beaconBlock.rootsTimestamp += uint64(fixture.readUint(".chain.secondsPerSlot"));

        vm.expectRevert();
        ValidatorExitDelayVerifier(verifierAddress).verifyValidatorExitDelay(
            beaconBlock,
            _witnesses(".current.validator"),
            _exitRequests(".current.exitRequests")
        );
    }

    /// The old block, claimed at a slot its summary proof was not taken from
    function test_historicalProofAtWrongSlotIsRejected() public {
        _mockDelivery(".historical.validator");
        HistoricalHeaderWitness memory oldBlock = _historical(".historical.old");
        oldBlock.header.slot -= 1;

        vm.expectRevert();
        ValidatorExitDelayVerifier(verifierAddress).verifyHistoricalValidatorExitDelay(
            _provable(".historical.anchor"),
            oldBlock,
            _witnesses(".historical.validator"),
            _exitRequests(".historical.exitRequests")
        );
    }

    /// Delivered before the validator could have exited, so the reported delay is the real one
    function _mockDelivery(string memory validatorKey) internal returns (uint256 eligibleSince) {
        eligibleSince =
            fixture.readUint(".chain.genesisTime") +
            fixture.readUint(string.concat(validatorKey, ".witness.activationEpoch")) *
            fixture.readUint(".chain.slotsPerEpoch") *
            fixture.readUint(".chain.secondsPerSlot") +
            fixture.readUint(".chain.shardCommitteePeriodInSeconds");
        vm.mockCall(veb, abi.encodeWithSelector(IVEB.getDeliveryTimestamp.selector), abi.encode(eligibleSince - 1 days));
    }

    /// The module recorded the delay for exactly this key, with the delay derived from the chain
    function _assertReported(string memory key, uint256 provenSlot, uint256 eligibleSince) internal {
        uint256 proofSlotTimestamp = fixture.readUint(".chain.genesisTime") +
            provenSlot *
            fixture.readUint(".chain.secondsPerSlot");
        bytes32 topic = keccak256("ValidatorExitStatusUpdated(uint256,bytes,uint256,uint256)");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != topic) continue;
            assertEq(uint256(logs[i].topics[1]), fixture.readUint(string.concat(key, ".exitRequests.nodeOpId")));
            (bytes memory pubkey, uint256 eligibleToExitInSec, uint256 reportedAt) = abi.decode(
                logs[i].data,
                (bytes, uint256, uint256)
            );
            assertEq(pubkey, fixture.readBytes(string.concat(key, ".validator.pubkey")), "public key");
            assertEq(eligibleToExitInSec, proofSlotTimestamp - eligibleSince, "reported exit delay");
            assertEq(reportedAt, proofSlotTimestamp, "proof slot timestamp");
            found = true;
        }
        assertTrue(found, "the module did not record the exit delay");
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

    function _provable(string memory key) internal view returns (ProvableBeaconBlockHeader memory) {
        return
            ProvableBeaconBlockHeader({
                header: _header(key),
                rootsTimestamp: uint64(fixture.readUint(string.concat(key, ".rootsTimestamp")))
            });
    }

    function _historical(string memory key) internal view returns (HistoricalHeaderWitness memory) {
        return
            HistoricalHeaderWitness({
                header: _header(key),
                proof: fixture.readBytes32Array(string.concat(key, ".proof"))
            });
    }

    function _witnesses(string memory key) internal view returns (ValidatorWitness[] memory witnesses) {
        string memory w = string.concat(key, ".witness");
        witnesses = new ValidatorWitness[](1);
        witnesses[0] = ValidatorWitness({
            exitRequestIndex: uint32(fixture.readUint(string.concat(w, ".exitRequestIndex"))),
            withdrawalCredentials: fixture.readBytes32(string.concat(w, ".withdrawalCredentials")),
            effectiveBalance: uint64(fixture.readUint(string.concat(w, ".effectiveBalance"))),
            slashed: fixture.readBool(string.concat(w, ".slashed")),
            activationEligibilityEpoch: uint64(fixture.readUint(string.concat(w, ".activationEligibilityEpoch"))),
            activationEpoch: uint64(fixture.readUint(string.concat(w, ".activationEpoch"))),
            withdrawableEpoch: uint64(fixture.readUint(string.concat(w, ".withdrawableEpoch"))),
            validatorProof: fixture.readBytes32Array(string.concat(w, ".validatorProof"))
        });
    }

    function _exitRequests(string memory key) internal view returns (ExitRequestData memory) {
        return
            ExitRequestData({
                data: fixture.readBytes(string.concat(key, ".data")),
                dataFormat: fixture.readUint(string.concat(key, ".dataFormat"))
            });
    }
}
