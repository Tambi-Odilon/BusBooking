#!/usr/bin/env bash
# Lance le test de charge de bout en bout : base neuve, serveur compilé, charge HTTP, contrôle SQL de l'invariant.
# Prérequis : PostgreSQL et Redis accessibles (variables ci-dessous), `npm ci` fait dans backend/.
set -euo pipefail
cd "$(dirname "$0")/../.."
PG_ADMIN_URL="${PG_ADMIN_URL:-postgres://postgres@127.0.0.1:5432/postgres}"
DB_NAME="${LOAD_DB_NAME:-bb_load}"
export DATABASE_URL="${LOAD_DATABASE_URL:-postgres://postgres@127.0.0.1:5432/$DB_NAME}"
export REDIS_URL="${LOAD_REDIS_URL:-redis://127.0.0.1:6379/2}"
export PORT="${LOAD_PORT:-3999}" HOST=127.0.0.1 NODE_ENV=development LOG_LEVEL=warn
export RATE_LIMIT_FACTOR=100000 SIM_DELAY_MS=300 DB_POOL_MAX="${DB_POOL_MAX:-40}" UPLOAD_DIR=/tmp/bb-load-uploads PUBLIC_URL="http://127.0.0.1:$PORT"
psql "$PG_ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB_NAME" -c "CREATE DATABASE $DB_NAME"
redis-cli -u "$REDIS_URL" flushdb >/dev/null 2>&1 || true
npm run build >/dev/null
node dist/migrate.js
node dist/main.js > /tmp/bb-load-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/health/ready" >/dev/null && break; sleep 0.5; done
BASE_URL="http://127.0.0.1:$PORT" RESULT_FILE="${RESULT_FILE:-/tmp/bb-load-result.json}" node test/load/load-test.mjs
STATUS=$?
echo; echo "Contrôle SQL — sièges vendus plus d'une fois (doit être vide) :"
psql "$DATABASE_URL" -c "SELECT b.trip_id, p.seat_no, count(*) FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id WHERE b.status IN ('confirmed','completed') AND p.status IN ('active','boarded') GROUP BY 1,2 HAVING count(*) > 1"
echo "Erreurs dans le journal du serveur : $(grep -c '"level":50' /tmp/bb-load-server.log || true)"
exit $STATUS
