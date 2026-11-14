# Réservation de billets de bus — produit en marque blanche

Application complète de vente de billets de bus pour une compagnie de transport : site de réservation pour les voyageurs, back-office pour le personnel, API sécurisée avec temps réel. Chaque société l'installe sur son propre serveur et la personnalise (nom, logo, couleurs, devise, langues, moyens de paiement) depuis un assistant de première configuration.

| Dossier | Contenu |
|---|---|
| `src/` | Frontend Angular 20 (site client + back-office `/admin` + assistant `/setup`) |
| `backend/` | API NestJS (Fastify), migrations PostgreSQL, tests |
| `deploy/` | Docker Compose, Caddy (HTTPS), scripts d'installation, de sauvegarde et de restauration |
| `docs/` | Analyse, architecture, résultats de tests, documentations (technique, employés, voyageurs) |
| `.github/workflows/ci.yml` | Pipeline CI (tests + build) |
| `PROGRESSION.md` | Suivi du projet |

## Installation sur un serveur (production)

Prérequis : un serveur Linux (2 vCPU, 4 Go de RAM, 40 Go de disque), Docker avec le plugin Compose, un nom de domaine qui pointe vers le serveur, ports 80 et 443 ouverts.

```bash
cd deploy
./scripts/install.sh reservation.masociete.mg
```

Le script crée `deploy/.env` avec des secrets générés, construit les images, démarre les services et affiche le **code d'installation**. Ouvrez ensuite `https://reservation.masociete.mg` : l'assistant de première configuration démarre tout seul.

| Opération | Commande (depuis `deploy/`) |
|---|---|
| Mettre à jour | `./scripts/update.sh` |
| Sauvegarder maintenant | `./scripts/backup.sh` |
| Restaurer | `./scripts/restore.sh backups/daily/backup-AAAAMMJJ-HHMMSS.tar` |
| Voir les journaux | `docker compose --env-file .env logs -f api` |
| Arrêter / démarrer | `docker compose --env-file .env down` / `up -d` |

Essai sur son poste : `./scripts/install.sh localhost` puis `https://localhost` (certificat auto-signé à accepter).

## Développement local

Prérequis : Node.js 22, PostgreSQL 16, Redis 7.

```bash
# 1. API (http://localhost:3000, documentation sur /api/docs)
createdb bb_dev
cd backend && npm ci && npm run build && npm start

# 2. Frontend (http://localhost:4200, relaie /api vers le port 3000)
npm ci && npm start
```

Sans variable d'environnement, l'API utilise `postgres://postgres@127.0.0.1:5432/bb_dev` et `redis://127.0.0.1:6379`. Les migrations s'appliquent au démarrage.

## Tests

```bash
cd backend
npm test                 # 252 tests : unitaires, intégration, concurrence (PostgreSQL et Redis requis)
npm run test:load        # test de charge HTTP : 500 clients sur un siège, 1 000 clients pour 48 places
```

Derniers résultats : `docs/tests/resultats-tests.txt` et `docs/tests/charge-resultats.json`.

## Paiements

MVola, Orange Money et Airtel Money fonctionnent en **mode test simulé** tant que les clés marchandes ne sont pas saisies (Société et réglages → Paiements). En mode test, un numéro payeur terminé par `0000` simule un refus. La liste de ce que chaque société doit fournir est dans `docs/03-A-FOURNIR-PAR-LE-CLIENT.md`.

## Documentation

- `docs/02-ARCHITECTURE.md` — choix techniques, schéma de la base, API, temps réel, sécurité
- `docs/documentation/` — trois guides (technique, employés, voyageurs), chacun en HTML et en Word
