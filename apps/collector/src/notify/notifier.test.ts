import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { DEFAULT_SETTINGS, type Settings } from '@peak-guard/shared';
import { Notifier, type NotifierDeps } from './notifier.js';

function setup(
  config: NotifierDeps['config'],
  patch: Partial<Settings['notifications']> = {},
  failUrl?: string,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const mails: unknown[] = [];
  const records: string[] = [];
  let now = 0;
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...patch },
  };
  const n = new Notifier({
    config,
    getSettings: () => settings,
    log: pino({ level: 'silent' }),
    record: (kind, message) => {
      records.push(`${kind}: ${message}`);
      return Promise.resolve();
    },
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('', { status: url === failUrl ? 500 : 200 }));
    }) as typeof fetch,
    mailer: {
      sendMail: (m: unknown) => {
        mails.push(m);
        return Promise.resolve({} as never);
      },
    },
    now: () => now,
  });
  return { n, calls, mails, records, advance: (ms: number) => (now += ms) };
}

const peak = { kind: 'newPeak' as const, title: 'New month peak', message: '12.4 kW at 18:15' };

describe('Notifier', () => {
  it('sends to every configured channel', async () => {
    const t = setup({
      ntfyUrl: 'https://ntfy.example/peaks',
      telegramBotToken: 'TOKEN',
      telegramChatId: '42',
      webhookUrl: 'https://hooks.example/pg',
      smtpUrl: 'smtp://user:pw@mail.example:587',
      emailTo: 'me@example.org',
    });
    expect(t.n.channelNames).toEqual(['ntfy', 'telegram', 'webhook', 'email']);
    expect(await t.n.notify({ ...peak, urgent: true })).toBe(true);
    const [ntfy, tg, hook] = t.calls;
    expect(ntfy!.url).toBe('https://ntfy.example/peaks');
    expect(ntfy!.init.headers).toMatchObject({ Title: 'New month peak', Priority: 'high' });
    expect(ntfy!.init.body).toBe('12.4 kW at 18:15');
    expect(tg!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(tg!.init.body as string)).toMatchObject({ chat_id: '42' });
    expect(JSON.parse(hook!.init.body as string)).toMatchObject({
      source: 'peak-guard',
      kind: 'newPeak',
      title: 'New month peak',
    });
    expect(t.mails).toEqual([
      expect.objectContaining({ to: 'me@example.org', subject: '[!] Peak Guard: New month peak' }),
    ]);
  });

  it('applies the cooldown per kind and dedupe key, and respects disabled kinds', async () => {
    const t = setup({ webhookUrl: 'https://hooks.example/pg' }, { cooldownMinutes: 15 });
    const warn = {
      kind: 'approaching' as const,
      title: 'Approaching limit',
      message: '9.6 kW projected',
    };
    expect(await t.n.notify(warn, 'interval-1')).toBe(true);
    expect(await t.n.notify(warn, 'interval-1')).toBe(false);
    expect(await t.n.notify(warn, 'interval-2')).toBe(true);
    t.advance(16 * 60_000);
    expect(await t.n.notify(warn, 'interval-1')).toBe(true);
    expect(t.calls).toHaveLength(3);

    const off = setup(
      { webhookUrl: 'https://hooks.example/pg' },
      {
        events: { ...DEFAULT_SETTINGS.notifications.events, newPeak: false },
      },
    );
    expect(await off.n.notify(peak)).toBe(false);
    expect(off.calls).toHaveLength(0);
  });

  it('keeps going when one channel fails and records the error', async () => {
    const t = setup(
      { ntfyUrl: 'https://ntfy.example/x', webhookUrl: 'https://broken.example/' },
      {},
      'https://broken.example/',
    );
    expect(await t.n.notify(peak)).toBe(true);
    expect(
      t.records.some((r) => r.startsWith('notify_error') && r.includes('webhook: HTTP 500')),
    ).toBe(true);
  });

  it('encodes non-ASCII ntfy titles', async () => {
    const t = setup({ ntfyUrl: 'https://ntfy.example/x' });
    await t.n.notify({ kind: 'test', title: 'Größte Spitze', message: 'x' });
    expect((t.calls[0]!.init.headers as Record<string, string>).Title).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('does nothing without channels', async () => {
    expect(await setup({}).n.notify(peak)).toBe(false);
  });
});
