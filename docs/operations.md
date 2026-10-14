# Operations

## Authentication

Set `AUTH_MODE` in `.env`:

| Mode       | When to use                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `none`     | Only on a trusted network. Anyone who can reach the web port can change settings.                                                      |
| `password` | Single-user login. Sessions are HttpOnly cookies signed with `AUTH_SECRET`.                                                            |
| `proxy`    | An authenticating reverse proxy (Authelia, Authentik, oauth2-proxy, Traefik forward-auth, …) sets the user header `AUTH_PROXY_HEADER`. |

To set up password mode:

```sh
docker compose run --rm api node dist/hash-password.js 'a long passphrase'
# → scrypt$16384$8$1$…  (in .env, write every $ as $$)
AUTH_MODE=password
AUTH_USERNAME=tobias
AUTH_PASSWORD_HASH=scrypt$$16384$$8$$1$$…
AUTH_SECRET=<openssl rand -hex 32>
```

- **Sessions:** valid for `AUTH_SESSION_HOURS` (default 30 days). Changing `AUTH_SECRET` signs every session out.
- **Login limits:** failed login attempts are limited to 5 per minute per client IP; a successful login resets the counter.
- **Proxy mode:** the header is trusted blindly. Peak Guard must be reachable **only** through the proxy, so don't publish `WEB_PORT` to the network (`WEB_PORT=127.0.0.1:8080`, or attach the `web` service to the proxy's network only).
- **Audit log:** every settings change and import is recorded with the user (Settings → System).

## Behind a reverse proxy (HTTPS)

The `web` container (Caddy) listens on port 8080 and serves both UI and API. Point your proxy at it. TLS termination happens in the proxy.

- **Live view:** it uses Server-Sent Events (`/api/live/stream`). The proxy must not buffer `text/event-stream` responses. Traefik, Caddy and nginx with `proxy_buffering off` work.
- **Secure cookies:** `COOKIE_SECURE=auto` makes session cookies `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- **Installing as an app:** the PWA needs a certificate the browser trusts.
- **Traefik:** the web image exposes several ports (Caddy's base image declares 80/443/2019), so tell Traefik the port explicitly. Also attach `web` to Traefik's network. Keep this in a local `docker-compose.override.yml`:

  ```yaml
  services:
    web:
      networks: [default, proxy]
      labels:
        - traefik.enable=true
        - traefik.docker.network=proxy
        - traefik.http.routers.peakguard.rule=Host(`peakguard.example.org`)
        - traefik.http.routers.peakguard.entrypoints=websecure
        - traefik.http.routers.peakguard.tls=true
        - traefik.http.services.peakguard.loadbalancer.server.port=8080
  networks:
    proxy:
      external: true
  ```

## Backups and restore

Start the backup job, which runs `pg_dump` every `BACKUP_INTERVAL_HOURS` and keeps `BACKUP_KEEP_DAYS`:

```sh
docker compose --profile backup up -d
docker compose logs backup            # "backup written: /backups/peakguard-….dump"
```

By default, dumps go to the named volume `backups`. Set `BACKUP_DIR=/srv/backups/peak-guard` to write them to a host directory you include in your regular backups. You can also run a one-off dump at any time:

```sh
docker compose --profile backup run --rm backup once
```

**Restore** (stops collector and API, recreates the database, restores, restarts):

```sh
docker compose cp backup:/backups/peakguard-20270115T020000Z.dump .   # when using the named volume
sh docker/restore.sh peakguard-20270115T020000Z.dump
```

The script wraps the restore in `timescaledb_pre_restore()` / `timescaledb_post_restore()`, as TimescaleDB requires. `pg_restore` prints "already exists" errors for objects the extension creates by itself; these are expected. To test a dump without touching live data, restore it into another database: `sh docker/restore.sh file.dump peakguard_restore`.

## Monitoring

- **API metrics:** `GET /api/metrics` (Prometheus text format). It needs a session, or `Authorization: Bearer $METRICS_TOKEN`.

  | Metric                                        | Meaning                                       |
  | --------------------------------------------- | --------------------------------------------- |
  | `peakguard_grid_power_watts`                  | Current grid power                            |
  | `peakguard_interval_projected_kw`             | Projected average of the running quarter-hour |
  | `peakguard_interval_state`                    | 0 safe, 1 warning, 2 over                     |
  | `peakguard_month_peak_kw`                     | Month peak so far                             |
  | `peakguard_month_cost_eur`                    | Capacity charge so far this month             |
  | `peakguard_inverter_connection`               | 1 ok, 0.5 stale, 0 down                       |
  | `peakguard_collector_heartbeat_age_seconds`   | Time since the collector last wrote samples   |
  | `peakguard_api_http_request_duration_seconds` | API request latency                           |
  | `peakguard_api_*`                             | Process metrics                               |

- **Collector metrics:** `http://collector:8081/metrics`, container-internal.

  | Metric                                                | Meaning                         |
  | ----------------------------------------------------- | ------------------------------- |
  | `peakguard_collector_polls_total{result}`             | Inverter polls by result        |
  | `peakguard_collector_poll_duration_seconds`           | Poll duration                   |
  | `peakguard_collector_samples_written_total`           | Raw samples written             |
  | `peakguard_collector_intervals_closed_total{quality}` | Closed quarter-hours by quality |

- **Logs:** structured JSON (pino) on stdout. Set `LOG_LEVEL=debug` for more detail.
- **Health:** `GET /api/health` is unauthenticated, for uptime checks. Settings → System shows database and collector health, events and the audit log.

## Battery control in operation

- **Control page:** mode (Off / Dry-run / Active), Modbus and battery readout, current decision, whether limits are applied, faults, pause (30 min / 2 h), the revert self-test, parameters, the decision chart and the Dry-run estimate for the month.
- **Decision log:** every decision is stored in `control_decisions` (on change and at least every 15 s, kept as long as raw samples). You can fetch it with `GET /api/control/decisions?from=…&to=…`.
- **Events:** writes that fail, restored defaults (with the reason), mode changes, pauses, faults and revert-test results appear under Settings → System.
- **Emergency stop:** any of these hands control back to the inverter:
  - Control → _Off_
  - `CONTROL_WRITES_ENABLED=false` + `docker compose up -d collector`
  - stopping the collector, which restores defaults on shutdown and is backed by the inverter's revert timer

## Upgrades

```sh
docker compose pull
docker compose up -d --no-build
```

Both the collector and the API apply database migrations on start. A Postgres advisory lock prevents them from running concurrently. Take a backup before upgrading across major versions.

## Demo data

For a fresh install, or to try the history views without waiting weeks:

```sh
docker compose up -d db
docker compose run --rm --no-deps collector node dist/seed-demo.js --days 60
```

The seeder refuses to run if the database already contains samples, so it can never mix simulated data into real measurements.

## Reconciliation with the billing meter

The grid operator bills based on its own smart meter, not on your Fronius meter. To check how closely the two agree:

1. In the Netz NÖ portal (smartmeter.netz-noe.at), export the quarter-hour values as CSV. This requires opt-in to 15-minute data and the consumption display.
2. Open History → Reconciliation and upload the file. Columns, decimal format and DST are detected automatically. If the timestamps are ambiguous, Peak Guard decides whether they mark the start or the end of each quarter-hour by matching them against your own data.
3. Compare the matched quarter-hours, the monthly peaks of both meters and the suggested calibration factor. A least-squares fit over quarter-hours ≥ 2 kW is used, because that's the range that matters for peaks. **Apply** stores the factor; live and history values then use it.

Netz NÖ does not publish its CSV format. If your export isn't recognized, please open an issue with the header line and a few anonymized rows.
