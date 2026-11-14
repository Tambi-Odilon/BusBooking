#!/usr/bin/env bash
# Mise à jour : sauvegarde, reconstruction des images, redémarrage. Les migrations de base s'appliquent au démarrage de l'API.
# Usage : placer la nouvelle version du code dans le dossier (git pull ou copie), puis ./scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Fichier .env absent : lancez d'abord scripts/install.sh"; exit 1; }
DC="docker compose --env-file .env"

echo "1/4 Sauvegarde avant mise à jour…"
$DC exec -T backup /usr/local/bin/backup.sh
echo "2/4 Construction des nouvelles images…"
$DC build
echo "3/4 Redémarrage…"
$DC up -d
echo -n "4/4 Vérification"
for _ in $(seq 1 90); do
  if $DC exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then OK=1; break; fi
  echo -n "."; sleep 2
done
echo
[ "${OK:-}" = "1" ] || { echo "L'API ne répond pas après la mise à jour. Journal : $DC logs api — retour arrière : scripts/restore.sh avec la sauvegarde qui vient d'être faite."; exit 1; }
$DC exec -T api node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>r.json()).then(j=>console.log('Version en service :', j.version))"
docker image prune -f >/dev/null
echo "Mise à jour terminée."
