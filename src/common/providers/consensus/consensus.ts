import type { ValueOfFields } from '@chainsafe/ssz/lib/view/container';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { ssz as sszType } from '@lodestar/types';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

import { BeaconConfig, BlockHeaderResponse, BlockId, GenesisResponse, StateId } from './response.interface';
import { ConfigService } from '../../config/config.service';
import { PrometheusService, TrackCLRequest } from '../../prometheus';
import { BaseRestProvider } from '../base/rest-provider';
import { RequestOptions } from '../base/utils/func';

let ssz: typeof sszType;

enum SupportedFork {
  capella = 'capella',
  deneb = 'deneb',
  electra = 'electra',
  fulu = 'fulu',
}

export type SupportedBlock =
  | ValueOfFields<typeof ssz.capella.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.deneb.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.electra.BeaconBlock.fields>
  | ValueOfFields<typeof ssz.fulu.BeaconBlock.fields>;

export interface State {
  bodyBytes: Uint8Array;
  forkName: SupportedFork;
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

  public async getBlockInfo(blockId: BlockId): Promise<SupportedBlock> {
    const { body, headers } = await this.retryRequest((baseUrl) =>
      this.baseGet(baseUrl, this.endpoints.blockInfo(blockId)),
    );
    const forkName = this.getForkName(headers);
    if (!Object.values(SupportedFork).includes(forkName as SupportedFork)) {
      throw new Error(`Fork name [${forkName}] is not supported`);
    }
    const jsonBody = (await body.json()) as { data: { message: JSON } };
    return ssz[forkName as SupportedFork].BeaconBlock.fromJson(jsonBody.data.message);
  }

  public async getBeaconHeader(blockId: BlockId): Promise<BlockHeaderResponse> {
    // TODO: change to ssz type in case of header struct update
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.beaconHeader(blockId)));
    const jsonBody = (await body.json()) as { data: BlockHeaderResponse };
    return jsonBody.data;
  }

  public async getState(stateId: StateId, signal?: AbortSignal): Promise<State> {
    const requestPromise = this.retryRequest(async (baseUrl) => {
      const { body, headers } = await this.baseGet(
        baseUrl,
        this.endpoints.state(stateId),
        {
          signal,
          headers: { accept: "application/octet-stream" },
        },
      );

      const bytes = await body.bytes();
      if (bytes.length === 0) {
        // throwing here causes retryRequest to try the next baseUrl
        throw new Error(`Empty beacon state data received for state id [${stateId}]`);
      }

      return { body, headers };
    });
    this.logger.log(`Getting state response for state id [${stateId}]`);
    const { body, headers } = await requestPromise;
    const forkName = this.getForkName(headers);
    if (!Object.values(SupportedFork).includes(forkName as SupportedFork)) {
      throw new Error(`Fork name [${forkName}] is not supported`);
    }
    const bodyBytes = await body.bytes();
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
