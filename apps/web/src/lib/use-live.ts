import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveSnapshot } from '@peak-guard/shared';

export type StreamState = 'connecting' | 'open' | 'error';

/**
 * Subscribe to the live SSE stream. EventSource reconnects automatically; when an
 * interval closes, cached history queries are invalidated so charts pick it up.
 */
export function useLive(): { snapshot: LiveSnapshot | null; stream: StreamState } {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [stream, setStream] = useState<StreamState>('connecting');
  const qc = useQueryClient();
  const lastInterval = useRef<number | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/live/stream');
    es.onopen = () => setStream('open');
    es.onerror = () => setStream('error');
    es.addEventListener('snapshot', (ev) => {
      const snap = JSON.parse((ev as MessageEvent<string>).data) as LiveSnapshot;
      setSnapshot(snap);
      setStream('open');
      if (lastInterval.current != null && lastInterval.current !== snap.interval.start) {
        void qc.invalidateQueries({ queryKey: ['intervals'] });
        void qc.invalidateQueries({ queryKey: ['month'] });
      }
      lastInterval.current = snap.interval.start;
    });
    return () => es.close();
  }, [qc]);

  return { snapshot, stream };
}
