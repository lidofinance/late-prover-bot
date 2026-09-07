import { BigNumber, BigNumberish, ethers } from 'ethers';

import veboJson from '../contracts/abi/validator-exit-bus-oracle.json';

/**
 * The call to the exit bus is not necessarily the top-level call of the transaction that emitted
 * `ExitDataProcessing`: a forwarding contract nests it inside its own arguments. The payload is
 * therefore searched for at any offset, and a candidate is accepted only when it hashes to the
 * `exitRequestsHash` from the event - the same commitment the verifier recomputes on-chain.
 */

/** Functions delivering a `(bytes data, uint256 dataFormat)` blob, with its key in their arguments */
const CARRIERS = {
  submitReportData: 'data',
  submitExitRequestsData: 'request',
} as const;

type CarrierMethod = keyof typeof CARRIERS;

/** Real submissions yield one or two candidates; the bound keeps selector-shaped padding cheap */
const MAX_DECODE_ATTEMPTS = 64;

const iface = new ethers.utils.Interface(veboJson);

export interface ExtractedExitRequestsData {
  data: string;
  dataFormat: number;
  method: CarrierMethod;
  /** Byte offset of the matched selector; 0 means a direct, unwrapped call */
  offset: number;
}

/** Preimage of the hash the ValidatorsExitBus stores per delivered exit requests blob. */
export function exitRequestsHash(data: string, dataFormat: BigNumberish): string {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes', 'uint256'], [data, dataFormat]));
}

/** @returns the blob hashing to `expectedHash`, or null when this calldata carries no such payload */
export function extractExitRequestsData(txData: string, expectedHash: string): ExtractedExitRequestsData | null {
  const size = ethers.utils.hexDataLength(txData);
  if (size == null || size < 4) return null;

  const target = expectedHash.toLowerCase();
  let attempts = 0;

  for (const method of Object.keys(CARRIERS) as CarrierMethod[]) {
    for (const offset of findSelectorOffsets(txData, iface.getSighash(method))) {
      if (attempts++ >= MAX_DECODE_ATTEMPTS) return null;

      const payload = decodeCarrier(method, ethers.utils.hexDataSlice(txData, offset));
      if (!payload) continue;

      // A stray selector decodes into garbage, and truncated calldata decodes without throwing;
      // neither survives the hash, which is also why the format is narrowed only afterwards -
      // toNumber() would throw on a value too large for it
      if (exitRequestsHash(payload.data, payload.dataFormat) !== target) continue;

      return { data: payload.data, dataFormat: payload.dataFormat.toNumber(), method, offset };
    }
  }

  return null;
}

function findSelectorOffsets(txData: string, selector: string): number[] {
  const body = txData.slice(2).toLowerCase();
  const needle = selector.slice(2).toLowerCase();
  const offsets: number[] = [];

  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    // Odd positions sit mid-byte, so they cannot start a call
    if (at % 2 === 0) offsets.push(at / 2);
  }

  return offsets;
}

function decodeCarrier(method: CarrierMethod, calldata: string): { data: string; dataFormat: BigNumber } | null {
  try {
    // Bytes past the end of the call are tolerated, so a nested call that is not the last one
    // in the calldata still decodes
    const payload = iface.decodeFunctionData(method, calldata)[CARRIERS[method]];
    if (typeof payload?.data !== 'string' || !BigNumber.isBigNumber(payload.dataFormat)) return null;

    return { data: payload.data, dataFormat: payload.dataFormat };
  } catch {
    return null;
  }
}
