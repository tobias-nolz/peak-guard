import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { House } from '@peak-guard/sim';
import { meterSystem, powerFlow, storageSystem } from './responses.js';

export interface SimClock {
  /** Current simulated time (epoch ms). */
  now(): number;
}

/** Real-time clock running `speed` times faster than wall time from `startTs`. */
export function acceleratedClock(
  startTs: number,
  speed: number,
  realNow = () => Date.now(),
): SimClock {
  const realStart = realNow();
  return { now: () => startTs + (realNow() - realStart) * speed };
}

interface MockState {
  /** Until this sim time all Solar API requests fail (communication loss). */
  outageUntil: number;
}

export function createMockServer(house: House, clock: SimClock, latencyMs = 0): Server {
  const mock: MockState = { outageUntil: 0 };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const now = clock.now();
      const s = house.advanceTo(now);

      if (url.pathname === '/health')
        return json(res, 200, { ok: true, simTime: new Date(now).toISOString() });

      if (url.pathname.startsWith('/solar_api/')) {
        if (now < mock.outageUntil) {
          res.socket?.destroy(); // simulate a dead connection
          return;
        }
        if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
        switch (url.pathname) {
          case '/solar_api/v1/GetPowerFlowRealtimeData.fcgi':
            return json(res, 200, powerFlow(s));
          case '/solar_api/v1/GetMeterRealtimeData.cgi':
            return json(res, 200, meterSystem(s));
          case '/solar_api/v1/GetStorageRealtimeData.cgi':
            return json(res, 200, storageSystem(s, house.config.batteryWh));
          case '/solar_api/GetAPIVersion.cgi':
            return json(res, 200, {
              APIVersion: 1,
              BaseURL: '/solar_api/v1/',
              CompatibilityRange: '1.8-1',
            });
          default:
            return json(res, 404, { error: 'unknown endpoint' });
        }
      }

      // Test hooks (mock only).
      if (url.pathname === '/mock/state') {
        return json(res, 200, { state: s, control: house.control, config: house.config });
      }
      if (url.pathname === '/mock/disturbance' && req.method === 'POST') {
        const body = await readBody(req);
        const kw = Number(body.kw ?? 8);
        const minutes = Number(body.minutes ?? 10);
        house.addDisturbance({
          extraW: kw * 1000,
          until: now + minutes * 60_000,
          name: typeof body.name === 'string' ? body.name : 'injected load',
        });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/mock/outage' && req.method === 'POST') {
        const body = await readBody(req);
        mock.outageUntil = now + Number(body.seconds ?? 60) * 1000;
        return json(res, 200, { ok: true, until: new Date(mock.outageUntil).toISOString() });
      }
      return json(res, 404, { error: 'not found' });
    })().catch((err: unknown) => json(res, 500, { error: String(err) }));
  });
}
