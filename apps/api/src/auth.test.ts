import { describe, expect, it } from 'vitest';
import {
  AttemptLimiter,
  hashPassword,
  parseCookies,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.js';

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('sessions', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const t = signSession({ user: 'tobias', exp: 2_000 }, 'secret');
    expect(verifySession(t, 'secret', 1_000)).toEqual({ user: 'tobias', exp: 2_000 });
    expect(verifySession(t, 'other', 1_000)).toBeNull();
    expect(verifySession(t, 'secret', 3_000)).toBeNull();
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ user: 'admin', exp: 9e9 })).toString('base64url');
    expect(verifySession(`${forged}.${s}`, 'secret', 1_000)).toBeNull();
    expect(verifySession(`${p}`, 'secret', 1_000)).toBeNull();
    expect(verifySession(undefined, 'secret')).toBeNull();
  });
});

describe('helpers', () => {
  it('parses cookies', () => {
    expect(parseCookies('a=1; pg_session=x.y%3D; b=')).toEqual({
      a: '1',
      pg_session: 'x.y=',
      b: '',
    });
  });

  it('limits attempts per window', () => {
    const l = new AttemptLimiter(2, 1_000);
    expect([l.take('ip', 0), l.take('ip', 1), l.take('ip', 2)]).toEqual([true, true, false]);
    expect(l.take('ip', 1_001)).toBe(true);
    expect(l.take('other', 2)).toBe(true);
  });
});
