#!/usr/bin/env bash
# backup.sh — a compressed, checksummed copy of the TRIPLE-E database, and removal of copies older than N days.
#   Usage:  DATABASE_URL=postgresql://user:pass@host:5432/db  ./scripts/backup.sh [folder] [keep_days]
#   Or set the standard PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE variables instead of DATABASE_URL.
#   Hosted databases (Supabase) need  PGSSLMODE=require  or  ?sslmode=require  on the URL.
#   Schedule it daily (cron, Windows Task Scheduler, Cloud Scheduler job or a GitHub Actions cron).
set -euo pipefail
umask 077
OUT="${1:-./backups}"; KEEP="${2:-14}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "Retention must be a non-negative number of days" >&2; exit 1; }
[ ! -L "$OUT" ] || { echo "Use a private backup directory, not a symbolic link" >&2; exit 1; }
mkdir -p "$OUT"
# Refuse a shared destination instead of changing permissions on an arbitrary existing folder.
[ -O "$OUT" ] && [ "$(( 8#$(stat -c '%a' "$OUT") & 077 ))" -eq 0 ] || {
  echo "Backup directory must be owned by this user and inaccessible to group/others (mode 700)" >&2; exit 1;
}
STAGING="$(mktemp -d "$OUT/.triplee-backup.XXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="triplee-$STAMP-${STAGING##*.}.dump"
FILE="$STAGING/$NAME"
START="$(date +%s)"
if [ -n "${DATABASE_URL:-}" ]; then pg_dump --format=custom --no-owner --file "$FILE" "$DATABASE_URL"
else pg_dump --format=custom --no-owner --file "$FILE"; fi
( cd "$STAGING" && sha256sum "$NAME" > "$NAME.sha256" )
# Publish only a complete dump; unique names also prevent same-second jobs overwriting each other.
mv -- "$FILE.sha256" "$OUT/$NAME.sha256"
mv -- "$FILE" "$OUT/$NAME"
FILE="$OUT/$NAME"
find "$OUT" -maxdepth 1 -type f -name 'triplee-*.dump*' -mtime +"$KEEP" -delete
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1)) in $(( $(date +%s) - START )) s. Kept the last $KEEP days."
echo "Store a copy OFF this machine (another cloud bucket or drive). A backup on the same server is not a backup."
