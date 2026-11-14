#!/usr/bin/env bash
# Restauration complète (base + fichiers) à partir d'une sauvegarde. REMPLACE toutes les données actuelles.
# Usage : ./scripts/restore.sh backups/daily/backup-AAAAMMJJ-HHMMSS.tar[.enc]
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Usage : scripts/restore.sh <fichier de sauvegarde>}"
[ -f "$FILE" ] || { echo "Fichier introuvable : $FILE"; exit 1; }
set -a; . ./.env; set +a
DC="docker compose --env-file .env"
BDIR="$(cd "${BACKUP_DIR:-./backups}" && pwd)"
ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
case "$ABS" in "$BDIR"/*) INSIDE="/backups/${ABS#"$BDIR"/}" ;; *) echo "Le fichier doit se trouver dans $BDIR"; exit 1 ;; esac

echo "ATTENTION : toutes les données actuelles seront remplacées par celles de $(basename "$FILE")."
if [ "${2:-}" != "--oui" ]; then read -rp "Tapez RESTAURER pour confirmer : " A; [ "$A" = "RESTAURER" ] || { echo "Annulé."; exit 1; }; fi

echo "Arrêt de l'API et du worker…"
$DC stop web api worker
echo "Restauration…"
$DC run --rm --no-deps --entrypoint /usr/local/bin/restore.sh backup "$INSIDE"
echo "Redémarrage…"
$DC up -d
echo "Restauration terminée. Vérifiez la connexion au back-office."
