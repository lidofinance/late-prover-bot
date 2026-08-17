import { Consensus } from '../providers/consensus/consensus';
import { BlockHeaderResponse } from '../providers/consensus/response.interface';

/** The bit of an execution provider needed to turn a block hash into a block number. */
interface BlockNumberSource {
  getBlock(blockHashOrNumber: string): Promise<{ number: number } | null>;
}

/**
 * Lowest slot that can serve as an execution anchor. Not zero: the genesis block body is
 * default-constructed, so its execution block hash is all zeroes and no EL node knows that block.
 */
export const EARLIEST_ANCHORABLE_SLOT = 1;

/**
 * The execution block number a consensus block is anchored on.
 *
 * From Gloas on there is no longer one execution block per slot - a proposed block whose payload was
 * withheld adds none - so an execution block number can only be derived through the anchor of a
 * specific consensus block, never by counting slots. See {@link Consensus.getExecutionBlockHash}.
 */
export async function resolveElBlockNumber(
  consensus: Consensus,
  provider: BlockNumberSource,
  header: BlockHeaderResponse,
): Promise<number> {
  const blockHash = await consensus.getExecutionBlockHash(header);
  const block = await provider.getBlock(blockHash);
  if (!block) {
    throw new Error(
      `Execution block [${blockHash}] anchored at slot [${header.header.message.slot}] is unknown to the EL node`,
    );
  }
  return block.number;
}
