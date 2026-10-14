import { ChainNotReadyError } from '../errors/chain-not-ready.error';
import { Consensus } from '../providers/consensus/consensus';
import { BlockHeaderResponse } from '../providers/consensus/response.interface';

interface BlockNumberSource {
  getBlock(blockHashOrNumber: string): Promise<{ number: number } | null>;
}

/**
 * Lowest slot that can serve as an execution anchor. Not zero: the genesis block body is
 * default-constructed, so its execution block hash is all zeroes and no EL node knows that block.
 */
export const EARLIEST_ANCHORABLE_SLOT = 1;

/**
 * The execution block number a consensus block is anchored on. From Gloas on a slot can add no
 * execution block, so block numbers cannot be derived by counting slots.
 */
export async function resolveElBlockNumber(
  consensus: Consensus,
  provider: BlockNumberSource,
  header: BlockHeaderResponse,
): Promise<number> {
  const blockHash = await consensus.getExecutionBlockHash(header);
  const block = await provider.getBlock(blockHash);
  if (!block) {
    throw new ChainNotReadyError(
      `Execution block [${blockHash}] anchored at slot [${header.header.message.slot}] is unknown to the EL node`,
    );
  }
  return block.number;
}
