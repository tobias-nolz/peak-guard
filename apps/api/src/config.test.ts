import { describe, expect, it } from 'vitest';
import { loadEnv } from './config.js';

const base = { DATABASE_URL: 'postgres://x@y/z' };

describe('loadEnv', () => {
  it('treats empty strings from compose as unset', () => {
    const e = loadEnv({ ...base, AUTH_MODE: '', AUTH_SECRET: '', METRICS_TOKEN: '' });
    expect(e.AUTH_MODE).toBe('none');
    expect(e.AUTH_SECRET).toBeUndefined();
  });

  it('requires a password in password mode', () => {
    expect(() => loadEnv({ ...base, AUTH_MODE: 'password' })).toThrow(/AUTH_PASSWORD_HASH/);
    expect(
      loadEnv({ ...base, AUTH_MODE: 'password', AUTH_PASSWORD: 'long enough' }).AUTH_MODE,
    ).toBe('password');
  });

  it('rejects malformed hashes and short secrets', () => {
    expect(() => loadEnv({ ...base, AUTH_PASSWORD_HASH: 'plain' })).toThrow();
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow();
  });
});
