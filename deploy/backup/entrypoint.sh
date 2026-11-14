#!/bin/sh
# Lance une sauvegarde chaque jour à BACKUP_HOUR (heure du fuseau TZ).
set -u
HOUR="${BACKUP_HOUR:-2}"
echo "[backup] sauvegarde quotidienne programmée à ${HOUR}h (fuseau ${TZ:-UTC})"
LAST=""
while true; do
  TODAY="$(date +%Y-%m-%d)"
  NOW="$(date +%H)"; NOW="${NOW#0}"
  if [ "${NOW:-0}" -ge "$HOUR" ] && [ "$LAST" != "$TODAY" ]; then
    # Au tout premier démarrage après l'heure prévue, une sauvegarde est faite immédiatement.
    if /usr/local/bin/backup.sh; then LAST="$TODAY"; else echo "[backup] ÉCHEC — nouvel essai dans 10 minutes"; sleep 600; continue; fi
  fi
  sleep 300
done
