#!/usr/bin/env sh
# Restore a Peak Guard backup into the running compose stack.
#   docker/restore.sh backups/peakguard-20270115T020000Z.dump [database]
# Restoring into the live database stops collector and API first and restarts them after;
# restoring into another database name (e.g. for a test) leaves the stack running.
set -eu

DUMP="${1:?usage: restore.sh <file.dump> [database]}"
DB="${2:-${POSTGRES_DB:-peakguard}}"
USER="${POSTGRES_USER:-peakguard}"
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

dc() { docker compose "$@"; }
psql_db() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$USER" "$@"; }

LIVE=false
[ "$DB" = "${POSTGRES_DB:-peakguard}" ] && LIVE=true
if $LIVE; then
  echo "Stopping collector and API…"
  dc stop collector api >/dev/null 2>&1 || true
fi

echo "Recreating database $DB…"
psql_db -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\""
psql_db -d "$DB" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"

echo "Restoring $DUMP…"
# pg_restore reports harmless errors for objects the extension already created.
dc exec -T db pg_restore -U "$USER" -d "$DB" --no-owner < "$DUMP" || true
psql_db -d "$DB" -c "SELECT timescaledb_post_restore()"

echo "Row counts:"
psql_db -d "$DB" -c "SELECT (SELECT count(*) FROM samples) AS samples, (SELECT count(*) FROM intervals) AS intervals, (SELECT count(*) FROM settings) AS settings"

if $LIVE; then
  echo "Starting collector and API…"
  dc start collector api >/dev/null
fi
echo "Done."
