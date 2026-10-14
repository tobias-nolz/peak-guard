import type { Sql } from '@peak-guard/db';
import { liveSnapshotSchema, type LiveSnapshot } from '@peak-guard/shared';

export const LIVE_CHANNEL = 'live';
export const SETTINGS_CHANNEL = 'settings_changed';

type Listener = (s: LiveSnapshot) => void;

/** Fans out live snapshots (Postgres NOTIFY from the collector) to SSE clients. */
export class LiveHub {
  private latest: LiveSnapshot | null = null;
  private readonly listeners = new Set<Listener>();

  get snapshot(): LiveSnapshot | null {
    return this.latest;
  }

  get clientCount(): number {
    return this.listeners.size;
  }

  async listen(sql: Sql): Promise<void> {
    await sql.listen(LIVE_CHANNEL, (payload: string) => this.receive(payload));
  }

  receive(payload: string): void {
    const parsed = liveSnapshotSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) return;
    this.latest = parsed.data;
    for (const l of this.listeners) l(parsed.data);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
