/**
 * Detects when CLOCK_SOURCE=inverter is used with timestamps too coarse for the poll
 * rate. Real Gen24s report whole seconds, so polling faster than 1 s (or a slow device
 * returning the same second twice) yields duplicate timestamps whose samples the
 * interval tracker has to drop.
 */
export class DuplicateTimestampDetector {
  private last: number | null = null;
  private checked = 0;
  private duplicates = 0;
  private reported = false;

  constructor(
    private readonly window = 20,
    private readonly maxRatio = 0.2,
  ) {}

  /** Record a sample timestamp; returns true exactly once when the problem is detected. */
  record(ts: number): boolean {
    if (this.reported) return false;
    if (this.last != null) {
      this.checked++;
      if (ts <= this.last) this.duplicates++;
    }
    this.last = Math.max(ts, this.last ?? ts);
    if (this.checked < this.window) return false;
    if (this.duplicates / this.checked > this.maxRatio) {
      this.reported = true;
      return true;
    }
    // Healthy window: start over so a later problem is still noticed.
    this.checked = 0;
    this.duplicates = 0;
    return false;
  }

  get duplicateRatio(): number {
    return this.checked > 0 ? this.duplicates / this.checked : 0;
  }
}
