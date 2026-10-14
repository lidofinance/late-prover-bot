import { NodeOperatorsRegistryContract } from './nor.service';

export interface ExitRequestsData {
  data: string;
  dataFormat: number;
}

export interface BeaconBlockHeader {
  slot: number; // uint64
  proposerIndex: number; // uint64
  parentRoot: string; // bytes32
  stateRoot: string; // bytes32
  bodyRoot: string; // bytes32
}

export interface ProvableBeaconBlockHeader {
  header: BeaconBlockHeader;
  rootsTimestamp: number;
}

export interface HistoricalHeaderWitness {
  header: BeaconBlockHeader;
  proof: string[];
}

/**
 * A block header proven against a recent block's `state.block_roots` ring buffer.
 *
 * This is how the deadline block reaches the verifier: only the recent block is anchored through
 * EIP-4788, and the block being proven is reached from that block's state, so it does not need an
 * entry in the beacon roots buffer of its own.
 */
export interface BlockRootsHeaderWitness {
  header: BeaconBlockHeader;
  proof: string[];
}

export interface StakingModule {
  id: number;
  stakingModuleAddress: string;
  name: string;
}

export interface ValidatorWitness {
  exitRequestIndex: number; // uint32
  withdrawalCredentials: string; // bytes32
  effectiveBalance: number; // uint64
  slashed: boolean;
  activationEligibilityEpoch: number; // uint64
  activationEpoch: number; // uint64
  withdrawableEpoch: any; // uint64
  validatorProof: string[]; // bytes32[]
  moduleId: number;
  nodeOpId: number;
  pubkey: string;
}

export interface StakingModuleContractWrapper {
  id: number;
  name: string;
  address: string;
  contract: NodeOperatorsRegistryContract;
}
