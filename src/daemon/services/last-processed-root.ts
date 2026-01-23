import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { METRIC_DATA_ACTUALITY, METRIC_LAST_PROCESSED_SLOT_NUMBER, PrometheusService } from '../../common/prometheus';
import { Consensus } from '../../common/providers/consensus/consensus';
import { RootHex } from '../../common/providers/consensus/response.interface';

export interface ProcessedRoot {
  root: RootHex;
  slot: number;
}

@Injectable()
export class LastProcessedRoot implements OnApplicationBootstrap {
  private lastProcessedRoot: RootHex | undefined;
  private lastProcessedSlot: number | undefined;

  constructor(
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.setMetrics();
  }

  public async get(): Promise<ProcessedRoot | undefined> {
    if (!this.lastProcessedRoot) {
      return undefined;
    }
    return {
      root: this.lastProcessedRoot,
      slot: this.lastProcessedSlot!,
    };
  }

  public async set(processedRoot: ProcessedRoot): Promise<void> {
    this.lastProcessedRoot = processedRoot.root;
    this.lastProcessedSlot = processedRoot.slot;
  }

  private setMetrics() {
    const lastProcessed = () => this.lastProcessedSlot;
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
