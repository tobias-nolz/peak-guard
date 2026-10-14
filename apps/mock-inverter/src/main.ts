import { House, DEFAULT_PROFILE } from '@peak-guard/sim';
import { acceleratedClock, createMockServer } from './server.js';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

const speed = Number(env('MOCK_SPEED', '1'));
const start = process.env.MOCK_START ? Date.parse(process.env.MOCK_START) : Date.now();
const clock = acceleratedClock(start, speed);

const house = new House(start, {
  profile: {
    ...DEFAULT_PROFILE,
    seed: Number(env('MOCK_SEED', '42')),
    evW: Number(env('MOCK_EV_KW', '11')) * 1000,
  },
  pvPeakW: Number(env('MOCK_PV_KWP', '10')) * 1000,
  batteryWh: Number(env('MOCK_BATTERY_KWH', '10.24')) * 1000,
  batteryMaxW: Number(env('MOCK_BATTERY_MAX_KW', '6')) * 1000,
  revertSupported: env('MOCK_REVERT_SUPPORTED', 'true') === 'true',
});

// Keep the simulation advancing even without requests, so catch-up stays cheap.
setInterval(() => house.advanceTo(clock.now()), 1_000).unref();

const port = Number(env('PORT', '8080'));
createMockServer(house, clock, Number(env('MOCK_LATENCY_MS', '0'))).listen(port, () => {
  console.log(
    `mock inverter listening on :${port} (speed ×${speed}, sim start ${new Date(start).toISOString()})`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
