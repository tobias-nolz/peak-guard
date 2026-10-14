#!/bin/sh
# Periodic pg_dump of the Peak Guard database (compose profile "backup").
# Runs inside the TimescaleDB image so pg_dump matches the server version.
set -eu

DIR=/backups
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

# The volume may be root-owned on first use: fix ownership, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR" && chown postgres:postgres "$DIR"
  exec gosu postgres "$0" "$@"
fi

backup() {
  f="$DIR/peakguard-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # -Fc: compressed custom format for pg_restore; Timescale's internal
  # circular foreign-key notices are harmless.
  if pg_dump -h "${PGHOST:-db}" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$f.part" 2>"$DIR/.last-error"; then
    mv "$f.part" "$f"
    echo "$(date -u +%FT%TZ) backup written: $f ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.part"
    echo "$(date -u +%FT%TZ) backup FAILED:" >&2
    cat "$DIR/.last-error" >&2
    return 1
  fi
  find "$DIR" -name 'peakguard-*.dump' -mtime +"$KEEP_DAYS" -print -delete
}

if [ "${1:-}" = "once" ]; then
  backup
  exit $?
fi

while true; do
  backup || true
  sleep $((INTERVAL_HOURS * 3600))
done
