import { BigNumber, ethers } from 'ethers';

import { exitRequestsHash, extractExitRequestsData } from './exit-requests-calldata';
import veboJson from '../contracts/abi/validator-exit-bus-oracle.json';

const vebo = new ethers.utils.Interface(veboJson);
const wrapper = new ethers.utils.Interface(['function execute(address target, bytes data) payable returns (bytes)']);
// A forwarder that keeps an opaque word ahead of the nested calldata
const taggedWrapper = new ethers.utils.Interface(['function relay(bytes32 tag, bytes data)']);

/**
 * Real Hoodi transaction 0xe6f41e57f9b769613e411532da45255060c4ac54ed3597588d1fc58b995ba824 -
 * `execute(address,bytes)` wrapping `submitReportData` for validator 1527726 (module 6, node
 * operator 3). Kept verbatim: this is the shape that left the validator unreported.
 */
const WRAPPED_TX_DATA =
  '0x1cff79cd0000000000000000000000008664d394c2b3278f26a1b44b967aef99707eeab2000000000000000000000000' +
  '000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000' +
  '00000164294492c800000000000000000000000000000000000000000000000000000000000000400000000000000000' +
  '000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000' +
  '000000000000000500000000000000000000000000000000000000000000000000000000003a725f0000000000000000' +
  '000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000' +
  '000000000000000200000000000000000000000000000000000000000000000000000000000000a00000000000000000' +
  '00000000000000000000000000000000000000000000004800000600000000030000000000174fae0000000000000000' +
  'b500d4ecef2ddb90257b472f314bebc5a20313194201ea654ae35bd1badeac6779e07af943111c761d3a0ed1837df06d' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '00000000';
const WRAPPED_TX_HASH = '0xec2e53cf5f6e09bf9e8b012dfe21d8d03bca4b7c51aaedbf3de07b0105ea6c29';
const WRAPPED_TX_BLOB =
  '0x00000600000000030000000000174fae0000000000000000b500d4ecef2ddb90257b472f314bebc5' +
  'a20313194201ea654ae35bd1badeac6779e07af943111c761d3a0ed1837df06d';

/** 72-byte format-2 entry: moduleId(3) + nodeOpId(5) + validatorIndex(8) + keyIndex(8) + pubkey(48) */
const blob = (moduleId: number, nodeOpId: number, validatorIndex: number, pubkeyByte = 0xab) =>
  ethers.utils.hexlify(
    ethers.utils.concat([
      ethers.utils.zeroPad(ethers.utils.hexlify(moduleId), 3),
      ethers.utils.zeroPad(ethers.utils.hexlify(nodeOpId), 5),
      ethers.utils.zeroPad(ethers.utils.hexlify(validatorIndex), 8),
      ethers.utils.zeroPad('0x00', 8),
      new Uint8Array(48).fill(pubkeyByte),
    ]),
  );

const encodeSubmitReportData = (data: string, dataFormat: number) =>
  vebo.encodeFunctionData('submitReportData', [[3, 1234, 1, dataFormat, data], 2]);

const encodeSubmitExitRequestsData = (data: string, dataFormat: number) =>
  vebo.encodeFunctionData('submitExitRequestsData', [[data, dataFormat]]);

const wrap = (inner: string) => wrapper.encodeFunctionData('execute', [ethers.constants.AddressZero, inner]);

describe('exitRequestsHash', () => {
  it('reproduces the hash the exit bus emitted for the real Hoodi request', () => {
    expect(exitRequestsHash(WRAPPED_TX_BLOB, 2)).toBe(WRAPPED_TX_HASH);
  });

  it('does not depend on whether dataFormat arrives as a number or a BigNumber', () => {
    expect(exitRequestsHash(WRAPPED_TX_BLOB, BigNumber.from(2))).toBe(WRAPPED_TX_HASH);
  });

  it('differs from the tuple-encoded variant (wrong preimage would silently reject everything)', () => {
    const tupleEncoded = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(['tuple(bytes,uint256)'], [[WRAPPED_TX_BLOB, 2]]),
    );
    expect(tupleEncoded).not.toBe(WRAPPED_TX_HASH);
  });
});

describe('extractExitRequestsData - real world regression', () => {
  it('recovers the payload nested in execute(address,bytes) (validator 1527726 of CSM 0x02)', () => {
    const extracted = extractExitRequestsData(WRAPPED_TX_DATA, WRAPPED_TX_HASH);

    expect(extracted).not.toBeNull();
    expect(extracted!.method).toBe('submitReportData');
    expect(extracted!.dataFormat).toBe(2);
    expect(extracted!.offset).toBe(100);
    expect(extracted!.data).toBe(WRAPPED_TX_BLOB);
  });

  it('yields a blob the prover decodes as module 6, node operator 3, validator 1527726', () => {
    const { data } = extractExitRequestsData(WRAPPED_TX_DATA, WRAPPED_TX_HASH)!;
    const entry = Buffer.from(data.slice(2), 'hex');

    expect(entry.length).toBe(72);
    expect(BigInt('0x' + entry.subarray(0, 3).toString('hex'))).toBe(BigInt(6));
    expect(BigInt('0x' + entry.subarray(3, 8).toString('hex'))).toBe(BigInt(3));
    expect(BigInt('0x' + entry.subarray(8, 16).toString('hex'))).toBe(BigInt(1527726));
  });
});

describe('extractExitRequestsData - supported carriers', () => {
  const data = blob(6, 3, 1527726);
  const hash = exitRequestsHash(data, 2);

  it('finds a direct submitReportData call at offset 0 (behaviour before forwarding)', () => {
    const extracted = extractExitRequestsData(encodeSubmitReportData(data, 2), hash);

    expect(extracted).toMatchObject({ data, dataFormat: 2, method: 'submitReportData', offset: 0 });
  });

  it('finds a direct submitExitRequestsData call, format 1', () => {
    const listData = ethers.utils.hexlify(new Uint8Array(64).fill(0x11));
    const listHash = exitRequestsHash(listData, 1);

    const extracted = extractExitRequestsData(encodeSubmitExitRequestsData(listData, 1), listHash);

    expect(extracted).toMatchObject({ data: listData, dataFormat: 1, method: 'submitExitRequestsData', offset: 0 });
  });

  it('finds a wrapped submitExitRequestsData call', () => {
    const extracted = extractExitRequestsData(wrap(encodeSubmitExitRequestsData(data, 2)), hash);

    expect(extracted!.method).toBe('submitExitRequestsData');
    expect(extracted!.offset).toBeGreaterThan(0);
  });

  it('finds the payload through two levels of wrapping (offset off the 32-byte grid)', () => {
    const extracted = extractExitRequestsData(wrap(wrap(encodeSubmitReportData(data, 2))), hash);

    expect(extracted!.data).toBe(data);
    expect(extracted!.offset % 32).not.toBe(4);
  });

  it('finds the payload when the nested call is not the last thing in the calldata', () => {
    const padded = wrap(encodeSubmitReportData(data, 2)) + 'dead'.repeat(20);

    expect(extractExitRequestsData(padded, hash)!.data).toBe(data);
  });
});

describe('extractExitRequestsData - rejection', () => {
  const data = blob(6, 3, 1527726);
  const hash = exitRequestsHash(data, 2);

  it('returns null when the payload does not hash to the expected value', () => {
    const otherHash = exitRequestsHash(blob(1, 36, 1200521), 2);

    expect(extractExitRequestsData(wrap(encodeSubmitReportData(data, 2)), otherHash)).toBeNull();
  });

  it('returns null for a truncated payload, which ethers decodes without throwing', () => {
    const truncated = encodeSubmitReportData(data, 2).slice(0, -64);

    expect(extractExitRequestsData(truncated, hash)).toBeNull();
  });

  it.each([
    ['empty calldata', '0x'],
    ['shorter than a selector', '0x1234'],
    ['odd number of hex characters', '0x123'],
    ['not hex at all', 'definitely-not-calldata'],
    ['selector only', '0x294492c8'],
  ])('returns null for %s instead of throwing', (_label, calldata) => {
    expect(extractExitRequestsData(calldata, hash)).toBeNull();
  });

  it('stops after the attempt budget rather than scanning selector-padded calldata forever', () => {
    const decoys = '294492c8'.repeat(70);
    const genuine = encodeSubmitReportData(data, 2).slice(2);

    expect(extractExitRequestsData('0x' + decoys + genuine, hash)).toBeNull();
  });
});

describe('extractExitRequestsData - decoys and multiple payloads', () => {
  it('ignores a selector-shaped word sitting ahead of the real nested call', () => {
    const data = blob(6, 3, 1527726);
    const hash = exitRequestsHash(data, 2);
    const tag = ethers.utils.hexZeroPad('0x294492c8', 32);

    const calldata = taggedWrapper.encodeFunctionData('relay', [tag, encodeSubmitReportData(data, 2)]);

    expect(extractExitRequestsData(calldata, hash)!.data).toBe(data);
  });

  it('ignores a selector planted inside the exit requests blob itself', () => {
    const data = ethers.utils.hexlify(
      ethers.utils.concat([blob(6, 3, 1527726), '0x294492c8', new Uint8Array(68).fill(0x00)]),
    );
    const hash = exitRequestsHash(data, 2);

    expect(extractExitRequestsData(wrap(encodeSubmitReportData(data, 2)), hash)!.data).toBe(data);
  });

  it('picks the payload matching each hash when one transaction carries two of them', () => {
    const first = blob(6, 3, 1527726);
    const second = blob(1, 36, 1200521, 0xcd);
    const calldata = wrap(encodeSubmitReportData(first, 2)) + wrap(encodeSubmitReportData(second, 2)).slice(2);

    expect(extractExitRequestsData(calldata, exitRequestsHash(first, 2))!.data).toBe(first);
    expect(extractExitRequestsData(calldata, exitRequestsHash(second, 2))!.data).toBe(second);
  });
});
