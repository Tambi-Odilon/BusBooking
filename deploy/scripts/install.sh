#!/usr/bin/env bash
# Première installation sur un serveur Linux disposant de Docker et du plugin Compose.
# Usage : ./scripts/install.sh reservation.masociete.mg
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Docker n'est pas installé : https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Le plugin Docker Compose est requis."; exit 1; }

rand() { openssl rand -hex "${1:-32}"; }

if [ ! -f .env ]; then
  DOMAIN="${1:-}"
  if [ -z "$DOMAIN" ]; then read -rp "Nom de domaine du site (ex. reservation.masociete.mg, ou localhost pour un essai) : " DOMAIN; fi
  [ -n "$DOMAIN" ] || { echo "Nom de domaine requis."; exit 1; }
  cp .env.example .env
  set_var() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
  set_var DOMAIN "$DOMAIN"
  set_var PUBLIC_URL "https://$DOMAIN"
  set_var POSTGRES_PASSWORD "$(rand 24)"
  set_var REDIS_PASSWORD "$(rand 24)"
  set_var JWT_SECRET "$(rand 32)"
  set_var APP_ENCRYPTION_KEY "$(rand 32)"
  set_var WEBHOOK_SECRET "$(rand 32)"
  set_var SETUP_TOKEN "$(rand 8)"
  set_var METRICS_TOKEN "$(rand 16)"
  chmod 600 .env
  echo "Fichier .env créé avec des secrets générés. Gardez-en une copie en lieu sûr (surtout APP_ENCRYPTION_KEY)."
else
  echo "Fichier .env existant conservé."
fi

set -a; . ./.env; set +a
mkdir -p "${BACKUP_DIR:-./backups}"

echo "Construction des images (quelques minutes la première fois)…"
docker compose --env-file .env build
echo "Démarrage…"
docker compose --env-file .env up -d

echo -n "Attente de l'API"
for _ in $(seq 1 90); do
  if docker compose --env-file .env exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then OK=1; break; fi
  echo -n "."; sleep 2
done
echo
[ "${OK:-}" = "1" ] || { echo "L'API ne répond pas. Consultez : docker compose logs api"; exit 1; }

cat <<MSG

Installation terminée.
  Site                : ${PUBLIC_URL}
  Première ouverture  : l'assistant de configuration démarre tout seul.
  Code d'installation : ${SETUP_TOKEN:-(aucun)}
  Sauvegardes         : ${BACKUP_DIR:-./backups} (chaque jour à ${BACKUP_HOUR:-2}h)

Le certificat HTTPS est obtenu automatiquement si le domaine pointe bien vers ce serveur
et que les ports 80 et 443 sont ouverts.
MSG
