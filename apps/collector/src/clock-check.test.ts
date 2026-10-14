import { describe, expect, it } from 'vitest';
import { DuplicateTimestampDetector } from './clock-check.js';

describe('DuplicateTimestampDetector', () => {
  it('stays quiet for strictly increasing timestamps (mock with ms resolution)', () => {
    const d = new DuplicateTimestampDetector(20, 0.2);
    for (let i = 0; i < 200; i++) expect(d.record(1_000_000 + i * 3_000 + 17)).toBe(false);
  });

  it('reports once when a whole-second clock is polled every 100 ms', () => {
    const d = new DuplicateTimestampDetector(20, 0.2);
    const hits: number[] = [];
    for (let i = 0; i < 200; i++) {
      if (d.record(Math.floor((1_000_000 + i * 100) / 1000) * 1000)) hits.push(i);
    }
    expect(hits).toEqual([20]);
  });

  it('tolerates occasional repeats from a slow device', () => {
    const d = new DuplicateTimestampDetector(20, 0.2);
    let reported = false;
    for (let i = 0; i < 200; i++) {
      const ts = 1_000_000 + Math.floor(i / 1) * 2_000 - (i % 10 === 5 ? 2_000 : 0);
      reported ||= d.record(ts);
    }
    expect(reported).toBe(false);
  });
});
