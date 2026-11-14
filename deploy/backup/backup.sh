#!/bin/sh
# Sauvegarde de la base (pg_dump, format compressé) et des fichiers envoyés.
# Variables : PGHOST PGDATABASE PGUSER PGPASSWORD, BACKUP_ROOT (/backups), UPLOADS_DIR (/uploads),
#             BACKUP_PASSPHRASE (optionnel, chiffre en AES-256), BACKUP_KEEP_DAILY/WEEKLY/MONTHLY (jours).
set -eu
ROOT="${BACKUP_ROOT:-/backups}"
UPLOADS="${UPLOADS_DIR:-/uploads}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ROOT/daily" "$ROOT/weekly" "$ROOT/monthly"
TMP="$ROOT/.tmp-$STAMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

pg_dump --format=custom --no-owner --no-privileges --file="$TMP/db.dump"
if [ -d "$UPLOADS" ]; then tar -czf "$TMP/uploads.tar.gz" -C "$UPLOADS" .; else tar -czf "$TMP/uploads.tar.gz" -T /dev/null; fi
tar -cf "$TMP/backup.tar" -C "$TMP" db.dump uploads.tar.gz

OUT="$ROOT/daily/backup-$STAMP.tar"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  OUT="$OUT.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$TMP/backup.tar" -out "$OUT"
else
  mv "$TMP/backup.tar" "$OUT"
fi
# Contrôle : l'archive de la base doit être lisible.
pg_restore --list "$TMP/db.dump" > /dev/null

[ "$(date +%u)" = "7" ] && cp "$OUT" "$ROOT/weekly/" || true
[ "$(date +%d)" = "01" ] && cp "$OUT" "$ROOT/monthly/" || true

find "$ROOT/daily"   -name 'backup-*' -type f -mtime +"${BACKUP_KEEP_DAILY:-7}"     -exec rm -f {} \;
find "$ROOT/weekly"  -name 'backup-*' -type f -mtime +"${BACKUP_KEEP_WEEKLY:-35}"   -exec rm -f {} \;
find "$ROOT/monthly" -name 'backup-*' -type f -mtime +"${BACKUP_KEEP_MONTHLY:-190}" -exec rm -f {} \;

echo "[backup] OK $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"
