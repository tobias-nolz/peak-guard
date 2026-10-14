import { createContext, useContext } from 'react';
import type { LiveSnapshot } from '@peak-guard/shared';
import type { StreamState } from './use-live';

export const LiveContext = createContext<{ snapshot: LiveSnapshot | null; stream: StreamState }>({
  snapshot: null,
  stream: 'connecting',
});

export const useLiveContext = () => useContext(LiveContext);
