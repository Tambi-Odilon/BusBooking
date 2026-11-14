#!/usr/bin/env bash
# Sauvegarde immédiate (en plus de la sauvegarde quotidienne automatique).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --env-file .env exec -T backup /usr/local/bin/backup.sh
set -a; . ./.env; set +a
echo "Dernières sauvegardes dans ${BACKUP_DIR:-./backups}/daily :"
ls -1t "${BACKUP_DIR:-./backups}/daily" | head -5
