import { BigNumber } from 'ethers';

export interface KeyInfo {
  operatorId: number;
  keyIndex: number;
  pubKey: string;
}

export type KeyInfoFn = (valIndex: number) => KeyInfo | undefined;

export type WithdrawalsProofPayload = {
  beaconBlock: ProvableBeaconBlockHeader;
  witness: WithdrawalWitness;
  nodeOperatorId: number;
  keyIndex: number;
};

export type HistoricalWithdrawalsProofPayload = {
  beaconBlock: ProvableBeaconBlockHeader;
  oldBlock: HistoricalHeaderWitness;
  witness: WithdrawalWitness;
  nodeOperatorId: number;
  keyIndex: number;
};

export type ProvableBeaconBlockHeader = {
  header: BeaconBlockHeader;
  rootsTimestamp: BigNumber;
};

export type HistoricalHeaderWitness = {
  header: BeaconBlockHeader;
  proof: string[]; // bytes32[]
};

export type BeaconBlockHeader = {
  slot: BigNumber;
  proposerIndex: BigNumber;
  parentRoot: string; // bytes32
  stateRoot: string; // bytes32
  bodyRoot: string; // bytes32
};

export type WithdrawalWitness = {
  withdrawalOffset: number;
  withdrawalIndex: number;
  validatorIndex: number;
  amount: number;
  withdrawalCredentials: string; // bytes32
  effectiveBalance: number;
  slashed: boolean;
  activationEligibilityEpoch: number;
  activationEpoch: number;
  exitEpoch: number;
  withdrawableEpoch: number;
  withdrawalProof: string[]; // bytes32[]
  validatorProof: string[]; // bytes32[]
};
