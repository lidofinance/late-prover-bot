import { ethers } from 'ethers';

export interface ExitRequestsData {
  data: string;
  dataFormat: number;
}

export interface BeaconBlockHeader {
  slot: ethers.BigNumber; // uint64
  proposerIndex: ethers.BigNumber; // uint64
  parentRoot: string; // bytes32
  stateRoot: string; // bytes32
  bodyRoot: string; // bytes32
}

export interface ProvableBeaconBlockHeader {
  header: BeaconBlockHeader;
  rootsTimestamp: ethers.BigNumber;
}

export interface ValidatorWitness {
  exitRequestIndex: number; // uint32
  withdrawalCredentials: string; // bytes32
  effectiveBalance: number; // uint64
  slashed: boolean;
  activationEligibilityEpoch: number; // uint64
  activationEpoch: number; // uint64
  withdrawableEpoch: number; // uint64
  validatorProof: string[]; // bytes32[]
  moduleId: number;
  nodeOpId: number;
  pubkey: string;
}