#!/usr/bin/env bash
# restore-test.sh — the restore drill: load a backup into a SCRATCH database, check it, and time it (this is your RTO evidence).
#   Usage:  TARGET_URL=postgresql://user:pass@host:5432/triplee_restore_test  ./scripts/restore-test.sh backups/triplee-YYYYMMDD-HHMMSS.dump
#   NEVER point TARGET_URL at the live database: --clean drops objects before restoring them.
set -euo pipefail
FILE="${1:?Give the backup file}"; : "${TARGET_URL:?Set TARGET_URL to an empty scratch database}"
[ -f "$FILE" ] && [ -f "$FILE.sha256" ] || { echo "Backup and checksum are both required" >&2; exit 1; }
EXPECTED="$(cut -d ' ' -f 1 "$FILE.sha256")"
ACTUAL="$(sha256sum -- "$FILE")"; ACTUAL="${ACTUAL%% *}"
[[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] && [ "${EXPECTED,,}" = "$ACTUAL" ] || {
  echo "Backup checksum verification failed" >&2; exit 1;
}
[ -z "${DATABASE_URL:-}" ] || [ "$TARGET_URL" != "$DATABASE_URL" ] || {
  echo "TARGET_URL must refer to a separate scratch database" >&2; exit 1;
}
START="$(date +%s)"
pg_restore --exit-on-error --single-transaction --no-owner --clean --if-exists --dbname "$TARGET_URL" "$FILE"
echo "Restored. Verifying required tables:"
for t in users products stock_movements audit_log; do
  COUNT="$(psql -X --dbname "$TARGET_URL" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM $t")"
  [[ "$COUNT" =~ ^[0-9]+$ ]] || { echo "Invalid row count for $t" >&2; exit 1; }
  printf '%-18s%s\n' "$t" "$COUNT"
done
ELAPSED=$(( $(date +%s) - START ))
echo "Write down: backup file, date and time, ${ELAPSED}s, who ran it. That record is your evidence for the recovery test (T-15)."
