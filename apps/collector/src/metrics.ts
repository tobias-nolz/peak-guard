import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { IntervalQuality } from '@peak-guard/core';

/** Collector metrics, served on the health port at /metrics (container-internal). */
export class CollectorMetrics {
  readonly registry = new Registry();
  private readonly polls = new Counter({
    name: 'peakguard_collector_polls_total',
    help: 'Inverter polls by result',
    labelNames: ['result'],
    registers: [this.registry],
  });
  private readonly pollDuration = new Histogram({
    name: 'peakguard_collector_poll_duration_seconds',
    help: 'Duration of successful inverter polls',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  private readonly samples = new Counter({
    name: 'peakguard_collector_samples_written_total',
    help: 'Raw samples written to the database',
    registers: [this.registry],
  });
  private readonly intervals = new Counter({
    name: 'peakguard_collector_intervals_closed_total',
    help: 'Closed quarter-hours by quality',
    labelNames: ['quality'],
    registers: [this.registry],
  });
  private readonly lastSuccess = new Gauge({
    name: 'peakguard_collector_last_success_timestamp_seconds',
    help: 'Unix time of the last successful poll',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'peakguard_collector_' });
  }

  pollOk(durationS: number): void {
    this.polls.inc({ result: 'ok' });
    this.pollDuration.observe(durationS);
    this.lastSuccess.set(Date.now() / 1000);
  }

  pollFailed(): void {
    this.polls.inc({ result: 'error' });
  }

  samplesWritten(n: number): void {
    this.samples.inc(n);
  }

  intervalClosed(quality: IntervalQuality): void {
    this.intervals.inc({ quality });
  }
}
