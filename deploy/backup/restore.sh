#!/bin/sh
# Restaure une sauvegarde produite par backup.sh. À lancer API et worker ARRÊTÉS (voir scripts/restore.sh).
# Usage : restore.sh /backups/daily/backup-AAAAMMJJ-HHMMSS.tar[.enc]
set -eu
FILE="${1:?Usage : restore.sh <fichier de sauvegarde>}"
UPLOADS="${UPLOADS_DIR:-/uploads}"
[ -f "$FILE" ] || { echo "Fichier introuvable : $FILE"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$FILE" in
  *.enc)
    [ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "Sauvegarde chiffrée : définir BACKUP_PASSPHRASE"; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" -out "$TMP/backup.tar" ;;
  *) cp "$FILE" "$TMP/backup.tar" ;;
esac
tar -xf "$TMP/backup.tar" -C "$TMP"
pg_restore --list "$TMP/db.dump" > /dev/null

echo "[restore] remise à zéro de la base…"
psql -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS public CASCADE" -c "CREATE SCHEMA public"
echo "[restore] restauration de la base…"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="${PGDATABASE}" "$TMP/db.dump"
if [ -d "$UPLOADS" ]; then
  echo "[restore] restauration des fichiers…"
  find "$UPLOADS" -mindepth 1 -delete
  tar -xzf "$TMP/uploads.tar.gz" -C "$UPLOADS"
fi
echo "[restore] terminé"
