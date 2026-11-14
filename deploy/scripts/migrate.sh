#!/usr/bin/env bash
# Applique les migrations de base manquantes (fait automatiquement au démarrage de l'API ; ce script sert au diagnostic).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --env-file .env run --rm --no-deps api node dist/migrate.js
