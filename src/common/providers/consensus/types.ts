export type BlockRoot = string;
export type Slot = number;

export interface BlockHeader {
  message: {
    slot: string;
    proposer_index: string;
    parent_root: string;
    state_root: string;
    body_root: string;
  };
}

export interface VoluntaryExit {
  message: {
    epoch: string;
    validator_index: string;
  };
}

export interface BeaconBlock {
  message: {
    slot: string;
    proposer_index: string;
    parent_root: string;
    state_root: string;
    body: {
      voluntary_exits: VoluntaryExit[];
    };
  };
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
}

export interface ValidatorResponse {
  index: string;
  balance: string;
  status: ValidatorStatus;
  validator: {
    pubkey: string;
    withdrawal_credentials: string;
    effective_balance: string;
    slashed: boolean;
    activation_eligibility_epoch: string;
    activation_epoch: string;
    exit_epoch: string;
    withdrawable_epoch: string;
  };
}

export type ValidatorStatus =
  | 'pending_initialized'
  | 'pending_queued'
  | 'active_ongoing'
  | 'active_exiting'
  | 'active_slashed'
  | 'exited_unslashed'
  | 'exited_slashed'
  | 'withdrawal_possible'
  | 'withdrawal_done';
