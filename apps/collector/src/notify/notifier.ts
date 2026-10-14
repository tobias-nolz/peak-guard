import type { Logger } from 'pino';
import type { Transporter } from 'nodemailer';
import { createTransport } from 'nodemailer';
import type { NotificationKind, Settings } from '@peak-guard/shared';

/** Channel configuration from the environment (secrets never go to the database). */
export interface NotifyChannelsConfig {
  /** e.g. https://ntfy.sh/my-topic */
  ntfyUrl?: string | undefined;
  ntfyToken?: string | undefined;
  telegramBotToken?: string | undefined;
  telegramChatId?: string | undefined;
  webhookUrl?: string | undefined;
  /** smtp(s)://user:pass@host:port */
  smtpUrl?: string | undefined;
  emailFrom?: string | undefined;
  emailTo?: string | undefined;
}

export interface Notification {
  kind: NotificationKind | 'test';
  title: string;
  message: string;
  /** high-priority alerts (ntfy priority, e-mail subject marker) */
  urgent?: boolean;
  data?: Record<string, unknown>;
}

export interface NotifierDeps {
  config: NotifyChannelsConfig;
  getSettings: () => Settings;
  log: Logger;
  /** Record sent notifications / errors (event log). */
  record?: (kind: string, message: string, data?: unknown) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  mailer?: Pick<Transporter, 'sendMail'>;
}

type Channel = { name: string; send: (n: Notification) => Promise<void> };

/** Sends notifications to all configured channels, with per-kind cooldown and dedupe. */
export class Notifier {
  private readonly channels: Channel[] = [];
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly deps: NotifierDeps) {
    const c = deps.config;
    const f = deps.fetch ?? fetch;
    const ok = async (res: Response, name: string) => {
      if (!res.ok)
        throw new Error(`${name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    };
    if (c.ntfyUrl) {
      this.channels.push({
        name: 'ntfy',
        send: async (n) =>
          ok(
            await f(c.ntfyUrl!, {
              method: 'POST',
              body: n.message,
              headers: {
                Title: encodeHeader(n.title),
                Priority: n.urgent ? 'high' : 'default',
                Tags: n.urgent ? 'warning,zap' : 'zap',
                ...(c.ntfyToken ? { Authorization: `Bearer ${c.ntfyToken}` } : {}),
              },
              signal: AbortSignal.timeout(10_000),
            }),
            'ntfy',
          ),
      });
    }
    if (c.telegramBotToken && c.telegramChatId) {
      this.channels.push({
        name: 'telegram',
        send: async (n) =>
          ok(
            await f(`https://api.telegram.org/bot${c.telegramBotToken}/sendMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                chat_id: c.telegramChatId,
                text: `${n.urgent ? '⚠️ ' : ''}${n.title}\n${n.message}`,
              }),
              signal: AbortSignal.timeout(10_000),
            }),
            'telegram',
          ),
      });
    }
    if (c.webhookUrl) {
      this.channels.push({
        name: 'webhook',
        send: async (n) =>
          ok(
            await f(c.webhookUrl!, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ source: 'peak-guard', ts: (deps.now ?? Date.now)(), ...n }),
              signal: AbortSignal.timeout(10_000),
            }),
            'webhook',
          ),
      });
    }
    if (c.smtpUrl && c.emailTo) {
      const mailer = deps.mailer ?? createTransport(c.smtpUrl);
      this.channels.push({
        name: 'email',
        send: async (n) => {
          await mailer.sendMail({
            from: c.emailFrom ?? 'Peak Guard <peak-guard@localhost>',
            to: c.emailTo,
            subject: `${n.urgent ? '[!] ' : ''}Peak Guard: ${n.title}`,
            text: n.message,
          });
        },
      });
    }
  }

  get channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  /**
   * Send if the kind is enabled and not in cooldown. `dedupeKey` narrows the cooldown
   * (e.g. one "approaching" alert per quarter-hour). Never throws.
   */
  async notify(n: Notification, dedupeKey = ''): Promise<boolean> {
    const s = this.deps.getSettings().notifications;
    if (n.kind !== 'test' && !s.events[n.kind]) return false;
    if (this.channels.length === 0) return false;
    const now = (this.deps.now ?? Date.now)();
    const key = `${n.kind}:${dedupeKey}`;
    const last = this.lastSent.get(key);
    if (n.kind !== 'test' && last != null && now - last < s.cooldownMinutes * 60_000) return false;
    this.lastSent.set(key, now);

    const results = await Promise.allSettled(this.channels.map((c) => c.send(n)));
    const failed = results
      .map((r, i) =>
        r.status === 'rejected'
          ? `${this.channels[i]!.name}: ${String((r.reason as Error)?.message ?? r.reason)}`
          : null,
      )
      .filter((x): x is string => x != null);
    if (failed.length) {
      this.deps.log.warn({ failed, kind: n.kind }, 'notification failed');
      await this.deps
        .record?.('notify_error', `Notification "${n.title}" failed: ${failed.join('; ')}`)
        .catch(() => {});
    }
    await this.deps
      .record?.('notification', `${n.title}: ${n.message}`, {
        kind: n.kind,
        channels: this.channelNames,
      })
      .catch(() => {});
    return failed.length < this.channels.length;
  }
}

/** HTTP headers must be Latin-1; ntfy accepts RFC 2047 encoded words for UTF-8 titles. */
function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}
