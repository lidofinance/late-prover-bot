import type { ValueOfFields } from '@chainsafe/ssz/lib/view/container';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { ssz as sszType } from '@lodestar/types';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';
import { hexlify } from 'ethers/lib/utils';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

import { BeaconConfig, BlockHeaderResponse, BlockId, GenesisResponse, StateId } from './response.interface';
import { ConfigService } from '../../config/config.service';
import { PrometheusService, TrackCLRequest } from '../../prometheus';
import { BaseRestProvider, RequestError } from '../base/rest-provider';
import { RequestOptions } from '../base/utils/func';

let ssz: typeof sszType;

export enum SupportedFork {
  capella = 'capella',
  deneb = 'deneb',
  electra = 'electra',
  fulu = 'fulu',
  gloas = 'gloas',
}

export type SupportedBlock =
  | ValueOfFields<typeof ssz.capella.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.deneb.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.electra.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.fulu.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.gloas.BeaconBlock.fields>;

export interface State {
  bodyBytes: Uint8Array;
  forkName: SupportedFork;
}

/** A proposed block: its header, its decoded body and the fork the body was decoded with. */
export interface AvailableBlock {
  slot: number;
  header: BlockHeaderResponse;
  block: SupportedBlock;
  forkName: SupportedFork;
}

/** How many slots to scan forward before giving up on finding a proposed block (one epoch). */
const MAX_SLOTS_SCANNED_FORWARD = 32;

/**
 * The two block body fields this service reads. Every fork carries exactly one of them: the
 * embedded payload up to Fulu, the bid for the separately revealed payload from Gloas (EIP-7732)
 * on. `SupportedBlock` is a union of per-fork containers with no discriminant to narrow on, hence
 * the cast.
 */
interface BlockBodyFields {
  executionPayload?: { blockHash: Uint8Array };
  signedExecutionPayloadBid?: { message: { blockHash: Uint8Array; parentBlockHash: Uint8Array } };
}

const blockBody = (block: SupportedBlock): BlockBodyFields => block.body as unknown as BlockBodyFields;

/** The execution payload a pre-EIP-7732 block embeds; `undefined` from Gloas on. */
export const getExecutionPayload = (block: SupportedBlock): BlockBodyFields['executionPayload'] =>
  blockBody(block).executionPayload;

/** The bid a Gloas block commits to; `undefined` before EIP-7732. */
export const getExecutionPayloadBid = (block: SupportedBlock): BlockBodyFields['signedExecutionPayloadBid'] =>
  blockBody(block).signedExecutionPayloadBid;

/**
 * Whether the execution payload committed to by `block` was actually revealed, i.e. whether an
 * execution block carrying that slot's timestamp exists.
 *
 * Before EIP-7732 the payload is part of the block, so it exists whenever the block does. From
 * Gloas on the builder may withhold it, and only the next proposed block settles the question:
 * `process_execution_payload_bid` makes that block's bid commit to `state.latest_block_hash`, and
 * `process_parent_execution_payload` sets that field to the parent's payload hash only when the
 * parent's payload was applied. So the payload of `block` was revealed exactly when the bid of the
 * next block points at it.
 */
export function isPayloadRevealed(block: SupportedBlock, nextBlock: SupportedBlock): boolean {
  if (getExecutionPayload(block)) {
    return true;
  }

  const bid = getExecutionPayloadBid(block);
  const nextBid = getExecutionPayloadBid(nextBlock);
  if (!bid || !nextBid) {
    throw new Error('Post EIP-7732 block carries neither an execution payload nor an execution payload bid');
  }

  return hexlify(nextBid.message.parentBlockHash) === hexlify(bid.message.blockHash);
}

@Injectable()
export class Consensus extends BaseRestProvider implements OnModuleInit {
  private readonly endpoints = {
    config: 'eth/v1/config/spec',
    version: 'eth/v1/node/version',
    genesis: 'eth/v1/beacon/genesis',
    blockInfo: (blockId: BlockId): string => `eth/v2/beacon/blocks/${blockId}`,
    beaconHeader: (blockId: BlockId): string => `eth/v1/beacon/headers/${blockId}`,
    state: (stateId: StateId): string => `eth/v2/debug/beacon/states/${stateId}`,
    validators: (stateId: StateId): string => `eth/v1/beacon/states/${stateId}/validators`,
  };

  public genesisTimestamp: number;
  public beaconConfig: BeaconConfig;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {
    super(
      config.get('CL_API_URLS') as Array<string>,
      config.get('CL_API_RESPONSE_TIMEOUT_MS'),
      config.get('CL_API_MAX_RETRIES'),
      config.get('CL_API_RETRY_DELAY_MS'),
      logger,
      prometheus,
    );
  }

  public async onModuleInit(): Promise<void> {
    this.logger.log(`Getting genesis timestamp`);
    const genesis = await this.getGenesis();
    this.genesisTimestamp = Number(genesis.genesis_time);
    this.beaconConfig = await this.getConfig();
    ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  }

  public slotToTimestamp(slot: number): number {
    return this.genesisTimestamp + slot * Number(this.beaconConfig.SECONDS_PER_SLOT);
  }

  public timestampToSlot(timestamp: number): number {
    return Math.floor((timestamp - this.genesisTimestamp) / Number(this.beaconConfig.SECONDS_PER_SLOT));
  }

  public epochToSlot(epoch: number): number {
    return epoch * Number(this.beaconConfig.SLOTS_PER_EPOCH);
  }

  public slotToEpoch(slot: number): number {
    return Math.floor(slot / Number(this.beaconConfig.SLOTS_PER_EPOCH));
  }

  public async getConfig(): Promise<BeaconConfig> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.config));
    const jsonBody = (await body.json()) as { data: BeaconConfig };
    return jsonBody.data;
  }

  public async getGenesis(): Promise<GenesisResponse> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.genesis));
    const jsonBody = (await body.json()) as { data: GenesisResponse };
    return jsonBody.data;
  }

  public async getBlockInfo(blockId: BlockId): Promise<{ block: SupportedBlock; forkName: SupportedFork }> {
    const { body, headers } = await this.retryRequest((baseUrl) =>
      this.baseGet(baseUrl, this.endpoints.blockInfo(blockId)),
    );
    const forkName = this.getForkName(headers);
    if (!Object.values(SupportedFork).includes(forkName as SupportedFork)) {
      throw new Error(`Fork name [${forkName}] is not supported`);
    }
    const jsonBody = (await body.json()) as { data: { message: JSON } };
    const block = ssz[forkName as SupportedFork].BeaconBlock.fromJson(jsonBody.data.message);
    return { block, forkName: forkName as SupportedFork };
  }

  /**
   * Find the next proposed (non-missed) slot at or after `startSlot` and return its header.
   *
   * The beacon chain can have missed slots where no block was proposed.
   */
  public async findNextAvailableHeader(
    startSlot: number,
    maxAttempts: number = MAX_SLOTS_SCANNED_FORWARD,
  ): Promise<{ slot: number; header: BlockHeaderResponse }> {
    let currentSlot = startSlot;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const header = await this.getBeaconHeader(currentSlot.toString());
        // Successfully got header - this slot has a block
        this.logger.log(
          `Found available slot ${currentSlot}` +
            (currentSlot !== startSlot ? ` (requested: ${startSlot}, missed: ${currentSlot - startSlot})` : ''),
        );
        return { slot: currentSlot, header };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry for 404 errors (missed slots), throw all other errors
        if (!(error instanceof RequestError && error.statusCode === 404)) {
          throw error;
        }

        this.logger.debug?.(`Slot ${currentSlot} is missed (404), trying next slot`);
        currentSlot++;
      }
    }

    throw new Error(
      `Failed to find available slot after ${maxAttempts} attempts starting from slot ${startSlot}. Last error: ${lastError?.message}`,
    );
  }

  /**
   * The execution block the given beacon block is anchored on - the EL head as of that CL block.
   *
   * Before EIP-7732 the block embeds the very payload it was built with. From Gloas on the payload
   * is revealed separately and only reaches the beacon state while the *next* block is processed,
   * so a block's execution anchor is `state.latest_block_hash` of its own post state. The block
   * body carries that value for free: `process_execution_payload_bid` asserts
   * `bid.parent_block_hash == state.latest_block_hash`, and nothing else in the block changes that
   * field afterwards. Reading the bid avoids downloading a multi-gigabyte beacon state per cycle.
   *
   * Post-fork the anchor therefore lags the block by one slot - it is the payload of the parent
   * slot, or an earlier one when payloads were withheld. That is the safe direction for the
   * daemon's log scan range: the range ends short, and since both ends of the range are resolved by
   * the same rule the remainder is picked up by the next cycle instead of being skipped.
   */
  public async getExecutionBlockHash(header: BlockHeaderResponse): Promise<string> {
    const { block } = await this.getBlockInfo(header.root);

    const payload = getExecutionPayload(block);
    if (payload) {
      return hexlify(payload.blockHash);
    }

    const bid = getExecutionPayloadBid(block);
    if (!bid) {
      throw new Error(
        `Block at slot [${header.header.message.slot}] carries neither an execution payload nor a payload bid`,
      );
    }

    return hexlify(bid.message.parentBlockHash);
  }

  public async getBeaconHeader(blockId: BlockId): Promise<BlockHeaderResponse> {
    // TODO: change to ssz type in case of header struct update
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.beaconHeader(blockId)));
    const jsonBody = (await body.json()) as { data: BlockHeaderResponse };
    return jsonBody.data;
  }

  public async getState(stateId: StateId, signal?: AbortSignal): Promise<State> {
    this.logger.log(`Getting state response for state id [${stateId}]`);
    let bodyBytes!: Uint8Array;

    const { headers } = await this.retryRequest(async (baseUrl) => {
      const { body, headers } = await this.baseGet(baseUrl, this.endpoints.state(stateId), {
        signal,
        headers: { accept: 'application/octet-stream' },
      });

      bodyBytes = await body.bytes();
      if (bodyBytes.length === 0) {
        // throwing here causes retryRequest to try the next baseUrl
        throw new Error(`Empty beacon state data received for state id [${stateId}]`);
      }

      return { body, headers };
    });

    const forkName = this.getForkName(headers);
    if (!Object.values(SupportedFork).includes(forkName as SupportedFork)) {
      throw new Error(`Fork name [${forkName}] is not supported`);
    }

    // Log the size for debugging
    this.logger.log(`Received beacon state data for [${stateId}]: ${bodyBytes.length} bytes, fork: ${forkName}`);

    return { bodyBytes, forkName: forkName as SupportedFork };
  }

  @TrackCLRequest()
  protected baseGet(
    baseUrl: string,
    endpoint: string,
    options?: RequestOptions,
  ): Promise<{ body: BodyReadable; headers: IncomingHttpHeaders }> {
    return super.baseGet(baseUrl, endpoint, options);
  }

  private getForkName(headers: IncomingHttpHeaders): string {
    // Try to get fork name from headers first
    const headerForkName = headers['eth-consensus-version'] as string;
    if (headerForkName) {
      return headerForkName;
    }

    // Fallback to environment variable (defaults to 'electra')
    return this.config.get('FORK_NAME') as string;
  }
}
