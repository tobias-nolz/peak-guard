import { describe, expect, it } from 'vitest';
import { CollectorMetrics } from './metrics.js';

describe('CollectorMetrics', () => {
  it('counts polls, samples and intervals', async () => {
    const m = new CollectorMetrics();
    m.pollOk(0.2);
    m.pollOk(0.3);
    m.pollFailed();
    m.samplesWritten(5);
    m.intervalClosed('exact');
    m.intervalClosed('estimated');
    m.intervalClosed('exact');
    const text = await m.registry.metrics();
    expect(text).toMatch(/^peakguard_collector_polls_total\{result="ok"\} 2$/m);
    expect(text).toMatch(/^peakguard_collector_polls_total\{result="error"\} 1$/m);
    expect(text).toMatch(/^peakguard_collector_samples_written_total 5$/m);
    expect(text).toMatch(/^peakguard_collector_intervals_closed_total\{quality="exact"\} 2$/m);
    expect(text).toMatch(/^peakguard_collector_poll_duration_seconds_count 2$/m);
  });
});
