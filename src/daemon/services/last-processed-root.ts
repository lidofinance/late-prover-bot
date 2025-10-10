import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import { METRIC_DATA_ACTUALITY, METRIC_LAST_PROCESSED_SLOT_NUMBER, PrometheusService } from '../../common/prometheus';
import { Consensus } from '../../common/providers/consensus/consensus';
import { RootHex } from '../../common/providers/consensus/response.interface';

export interface ProcessedRoot {
  root: RootHex;
  slot: number;
}

interface LastProcessedRootStorage {
  lastProcessedRoot: ProcessedRoot | undefined;
}

@Injectable()
export class LastProcessedRoot implements OnModuleInit, OnApplicationBootstrap {
  private storage: Low<LastProcessedRootStorage>;

  constructor(
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initStorage();
  }

  async onApplicationBootstrap(): Promise<void> {
    this.setMetrics();
  }

  public async get(): Promise<ProcessedRoot | undefined> {
    return this.storage.data.lastProcessedRoot;
  }

  public async set(root: ProcessedRoot): Promise<void> {
    this.storage.data.lastProcessedRoot = root;
    await this.storage.write();
  }

  private async initStorage() {
    this.storage = new Low<LastProcessedRootStorage>(new JSONFile('storage/last-processed-root.json'), {
      lastProcessedRoot: undefined,
    });
    await this.storage.read();
  }

  private setMetrics() {
    const lastProcessed = () => this.storage.data.lastProcessedRoot?.slot;
    const getSlotTimeDiffWithNow = () => {
      const slot = lastProcessed();
      return slot ? Date.now() - this.consensus.slotToTimestamp(slot) * 1000 : 0;
    };

    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_DATA_ACTUALITY,
      help: 'Data actuality',
      labelNames: [],
      collect() {
        this.set(getSlotTimeDiffWithNow());
      },
    });

    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_LAST_PROCESSED_SLOT_NUMBER,
      help: 'Last processed slot',
      labelNames: [],
      collect() {
        this.set(lastProcessed() || 0);
      },
    });
  }
}
