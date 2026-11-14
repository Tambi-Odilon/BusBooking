# Phase 2 — Architecture et modèle de données

_Version 1.1 — 12/11/2026 — validée par Tamby le 12/11/2026. La section 14 liste les écarts entre ce document et ce qui a été réalisé._

## 1. Résumé des choix

| Sujet | Choix | Raison principale |
|---|---|---|
| Langage / framework backend | **Node.js 22 + NestJS 11 (adaptateur Fastify), TypeScript** | Même langage que le frontend Angular, très bon en E/S et WebSocket, facile à maintenir pour un revendeur |
| Base de données | **PostgreSQL 16** | Transactions, contraintes d'unicité et verrous de ligne : c'est elle qui garantit l'absence de double vente |
| Accès aux données | `pg` + **Kysely** (requêtes typées) + migrations SQL versionnées | Contrôle total du SQL (`FOR UPDATE`, `ON CONFLICT`), aucun binaire externe à télécharger |
| Cache / files / messages | **Redis 7** (+ BullMQ) | Limitation de débit, cache, files de tâches (e-mails, PDF, rapprochement), diffusion temps réel entre instances |
| Temps réel | **Socket.IO** (WebSocket, repli automatique en long-polling) | Tient mieux sur les réseaux mobiles instables qu'un WebSocket brut ; salons par voyage |
| Authentification | Argon2id, JWT d'accès court (15 min) + refresh token tournant en cookie `httpOnly`, 2FA TOTP | Standard, révocable, compatible mobile |
| Déploiement | **Docker Compose**, une installation par société | Hypothèse de départ confirmée (voir §2.3) |
| Reverse proxy | **Caddy 2** | HTTPS Let's Encrypt automatique, configuration en 15 lignes |

## 2. Justification

### 2.1 Comparaison des backends

| Critère | Node.js / NestJS | Go | Java / Spring Boot | .NET |
|---|---|---|---|---|
| Connexions simultanées (WebSocket) | Très bon (boucle d'événements) | Excellent | Bon (threads virtuels) | Très bon |
| Mémoire par installation | ~150 Mo | ~30 Mo | ~500 Mo | ~250 Mo |
| Partage de code avec Angular | **Oui** (types, validation) | Non | Non | Non |
| Écosystème paiement mobile / PDF / e-mail | Très riche | Correct | Très riche | Riche |
| Facilité à trouver un développeur (Madagascar, Maroc) | **Élevée** | Faible | Moyenne | Moyenne |
| Vitesse de développement | **Élevée** | Moyenne | Moyenne | Moyenne |

Go est le plus performant en brut, mais ici le goulot d'étranglement est la base de données, pas le langage : une compagnie de bus fait au plus quelques dizaines de réservations par seconde en pointe. Node.js traite sans difficulté plusieurs milliers de connexions WebSocket sur un petit serveur (2 vCPU, 4 Go). Le gain décisif de NestJS est d'avoir **un seul langage sur tout le produit**, ce qui réduit le coût de maintenance pour vous et pour vos clients. Spring et .NET consomment trop de mémoire pour un modèle « un petit serveur par client ».

### 2.2 Pourquoi les verrous de sièges sont dans PostgreSQL et pas dans Redis
Un verrou de siège dans Redis et une réservation dans PostgreSQL forment deux systèmes à synchroniser : c'est la source classique de double vente. Ici, **le verrou et la vente sont la même ligne** dans la table `trip_seats`, dont la clé primaire est `(trip_id, seat_no)`. Passer de « verrouillé » à « vendu » est une seule transaction. Redis ne sert qu'à diffuser l'événement aux écrans.

### 2.3 Une installation par client (confirmé)
- Isolation totale des données et des clés de paiement entre sociétés.
- Chaque client choisit son hébergement et son nom de domaine.
- Sauvegarde, restauration et mise à jour indépendantes.
- Code plus simple (pas de filtre « tenant » sur chaque requête), donc moins de risques de fuite.

Inconvénient : les mises à jour se déploient client par client. Un script `update.sh` est prévu pour cela.

## 3. Schéma global

```
                         Internet
                            │ HTTPS (443)
                    ┌───────▼────────┐
                    │  Caddy (proxy) │  TLS automatique, compression, cache statique
                    └───┬────────┬───┘
            /           │        │  /api/*  /socket.io/*
        ┌───────────────▼─┐   ┌──▼──────────────────────────────┐
        │ Frontend Angular│   │ API NestJS (1..n instances)      │
        │ (fichiers       │   │  REST /api/v1  + Socket.IO       │
        │  statiques)     │   │  modules : auth, config, seats…  │
        └─────────────────┘   └──┬───────────┬───────────────┬───┘
                                 │           │               │
                        ┌────────▼───┐  ┌────▼─────┐   ┌─────▼──────────────┐
                        │ PostgreSQL │  │  Redis   │   │ Worker (même image)│
                        │ données +  │  │ cache,   │   │ BullMQ : e-mails,  │
                        │ verrous    │  │ files,   │   │ PDF, expiration,   │
                        │ sièges     │  │ pub/sub  │   │ rapprochement,     │
                        └────────────┘  └──────────┘   │ voyages récurrents │
                                                       └─────┬──────────────┘
                                                             │ HTTPS sortant
                                       ┌─────────────────────▼───────────────┐
                                       │ MVola · Orange Money · Airtel Money │
                                       │ SMTP · passerelle SMS (optionnel)   │
                                       └─────────────────────────────────────┘
        Volumes : pgdata, redisdata, uploads (logos, images pub), backups
```

Organisation du dépôt :

```
Bus-booking-Mada/
├── src/ …              frontend Angular existant (reste à la racine)
├── backend/            API NestJS, migrations SQL, tests
├── deploy/             docker-compose.yml, Caddyfile, scripts (install, backup, restore, update)
├── docs/               analyse, architecture, 3 documentations (HTML + Word)
├── .github/workflows/  pipeline CI
└── PROGRESSION.md
```

## 4. Modèle de données

Conventions : identifiants `uuid` (v7, triables), dates en `timestamptz` (UTC), **montants en entiers** dans la plus petite unité de la devise (`bigint`, pas de flottants), suppression logique (`deleted_at`) pour les données de référence.

### 4.1 Tables

**Configuration et marque blanche**
| Table | Rôle | Colonnes clés |
|---|---|---|
| `app_settings` | Toute la configuration, par groupe | `key` PK (`identity`, `contact`, `legal`, `locale`, `booking`, `ticket`, `notifications`…), `value jsonb`, `updated_by`, `updated_at` |
| `app_secrets` | Clés API et mot de passe SMTP **chiffrés** | `key` PK, `ciphertext`, `iv`, `tag`, `key_version` |
| `setup_state` | État de l'assistant | `id=1`, `status` (`pending`/`draft`/`completed`), `draft jsonb`, `completed_at` |
| `payment_methods` | Moyens de paiement activés | `code` PK (`mvola`, `orange_money`, `airtel_money`, `cash`…), `enabled`, `mode` (`test`/`live`), `public_config jsonb`, `sort_order` |
| `email_templates` | Modèles personnalisables | `code`, `lang`, `subject`, `body_html`, `body_text`, unique `(code, lang)` |
| `translations_override` | Textes modifiés ou langues ajoutées | `lang`, `key`, `value`, unique `(lang, key)` |
| `files` | Logos, favicon, images de publicité | `id`, `kind`, `mime`, `size`, `sha256`, `path` |

**Comptes et sécurité**
| Table | Rôle | Colonnes clés |
|---|---|---|
| `users` | Clients **et** comptes internes | `id`, `kind` (`customer`/`staff`), `email` (unique, insensible à la casse), `phone_e164`, `password_hash` (Argon2id, nul pour un client créé au guichet), `first_name`, `last_name`, `status` (`active`/`suspended`/`banned`), `role_id` (staff), `public_id` (`USR-XXXXXX`), `totp_secret_enc`, `totp_enabled`, `perm_version`, `last_login_at` |
| `roles` | Rôles intégrés et personnalisés | `id`, `slug` unique, `name`, `color`, `is_builtin`, `permissions jsonb` (les 16 permissions actuelles + `canSellWalkin`, `canViewAudit`, `canManageAds`, `canRefund`) |
| `sessions` | Refresh tokens | `id`, `user_id`, `token_hash` unique, `family_id`, `user_agent`, `ip`, `expires_at`, `revoked_at`, `replaced_by` |
| `auth_tokens` | Réinitialisation de mot de passe, vérification e-mail | `user_id`, `purpose`, `token_hash`, `expires_at`, `used_at` |
| `login_attempts` | Anti force brute | `identifier`, `ip`, `success`, `created_at` |
| `audit_log` | Journal **inaltérable** | `id bigserial`, `actor_id`, `actor_public_id`, `category`, `action`, `severity`, `target_type`, `target_id`, `diff jsonb`, `ip`, `prev_hash`, `hash`, `created_at` |

**Transport**
| Table | Rôle | Colonnes clés |
|---|---|---|
| `cities` | Villes desservies | `id`, `name`, `region`, `is_active` |
| `seat_layouts` | Plans de sièges | `id`, `code` (`bus48`, `minibus16`, `minibus10` + personnalisés), `name`, `capacity`, `rows jsonb` |
| `vehicles` | Flotte | `id`, `ref`, `name`, `type`, `layout_id`, `plate_number` unique, `status`, `year_built`, `amenities text[]` |
| `drivers` | Chauffeurs | `id`, `user_id` (compte, optionnel), `license_number` unique, `license_class`, `license_expiry`, `status`, `leave_until`, `default_vehicle_id` |
| `routes` | Itinéraires | `id`, `from_city_id`, `to_city_id`, `distance_km`, `duration_min`, `base_price`, `price_by_layout jsonb`, `duration_by_layout jsonb`, `status`, `suspend_reason`, `suspended_until` ; unique `(from_city_id, to_city_id)` hors supprimés |
| `route_vehicles` | Véhicules affectés | PK `(route_id, vehicle_id)` |
| `trip_templates` | Voyages **programmés** (récurrence) | `id`, `route_id`, `vehicle_id`, `driver_id`, `departure_time` (heure locale), `recurrence`, `days int[]`, `start_date`, `end_date`, `specific_date`, `price`, `rank`, `status` |
| `trips` | Voyages **réels** (une ligne par départ) | `id`, `template_id`, `route_id`, `vehicle_id`, `driver_id`, `layout_id`, `service_date` (date locale), `departure_at`, `arrival_at` (`timestamptz`), `price`, `status` (`scheduled`/`boarding`/`in_progress`/`completed`/`cancelled`), `sales_open_at`, `cancel_reason` ; unique `(template_id, service_date)` |

**Réservation et paiement**
| Table | Rôle | Colonnes clés |
|---|---|---|
| `trip_seats` | **État de chaque siège occupé** (cœur de la concurrence) | PK `(trip_id, seat_no)`, `status` (`held`/`booked`), `hold_token`, `hold_owner` (session ou guichet), `hold_expires_at`, `booking_id`, `updated_at` |
| `bookings` | Réservations | `id`, `reference` unique, `trip_id`, `customer_id`, `channel` (`web`/`counter`), `sold_by` (staff), `status` (`pending_payment`/`confirmed`/`cancelled`/`expired`/`completed`/`no_show`), `subtotal`, `service_fee`, `tax_amount`, `total`, `currency`, `contact_name`, `contact_phone`, `contact_email`, `idempotency_key` unique, `expires_at` |
| `booking_passengers` | Passagers | `id`, `booking_id`, `seat_no`, `first_name`, `last_name`, `phone`, `gender`, `category` (`adult`/`child`), `price`, `status` (`active`/`cancelled`/`boarded`/`no_show`), `ticket_number` unique, `boarded_at` |
| `payments` | Tentatives de paiement | `id`, `booking_id`, `method`, `provider_ref` unique par méthode, `amount`, `currency`, `status` (`initiated`/`pending`/`succeeded`/`failed`/`expired`/`refund_pending`/`refunded`/`partially_refunded`), `payer_phone`, `idempotency_key` unique, `raw_last_status jsonb`, `next_check_at`, `attempts` |
| `payment_events` | Callbacks reçus (dédoublonnés) | `id`, `provider`, `event_key` unique, `payment_id`, `payload jsonb`, `received_at`, `processed_at` |
| `refunds` | Remboursements | `id`, `payment_id`, `booking_id`, `amount`, `reason`, `status`, `provider_ref`, `requested_by` |
| `idempotency_keys` | Réponses mémorisées | PK `(scope, key)`, `request_hash`, `response jsonb`, `status_code`, `expires_at` |

**Communication et divers**
| Table | Rôle |
|---|---|
| `notifications_outbox` | E-mails / SMS à envoyer et envoyés (`channel`, `to`, `template`, `vars`, `status`, `attempts`, `last_error`, `sent_at`) |
| `ads` | Publicités (reprise du modèle actuel) + `ad_stats_daily` (vues, clics par jour) |
| `role_changes` | Historique des changements de rôle |
| `jobs_log` | Trace des tâches planifiées |

### 4.2 Relations principales

```
cities ─< routes ─< trip_templates ─< trips ─< trip_seats
             │            │             │  └─< bookings ─< booking_passengers
route_vehicles        vehicles ─────────┘         └─< payments ─< payment_events
             └── vehicles >── seat_layouts                 └─< refunds
users ─< sessions      users(kind=staff) >── roles      users ─< bookings
drivers >── users      audit_log >── users
```

### 4.3 Contraintes et index importants

| Objet | Définition | But |
|---|---|---|
| PK `trip_seats (trip_id, seat_no)` | clé primaire | **Un siège ne peut exister qu'une fois par voyage** |
| `bookings.reference` | unique | Référence de billet |
| `bookings.idempotency_key`, `payments.idempotency_key` | unique | Pas de doublon sur clic répété |
| `payment_events.event_key` | unique | Callback reçu deux fois = traité une fois |
| `payments (method, provider_ref)` | unique | Une transaction opérateur = un paiement |
| `trips (template_id, service_date)` | unique | Génération récurrente sans doublon |
| `trips (vehicle_id, tstzrange(departure_at, arrival_at))` | **contrainte d'exclusion** (`EXCLUDE USING gist`), hors annulés | Un véhicule ne peut pas faire deux voyages qui se chevauchent |
| `users (lower(email))` | unique | E-mail unique |
| `trips (route_id, service_date, status)` | index | Recherche client |
| `trip_seats (hold_expires_at) WHERE status='held'` | index partiel | Expiration rapide des verrous |
| `bookings (customer_id, created_at desc)`, `(trip_id)`, `(status, expires_at)` | index | Historique, manifeste, expiration |
| `payments (status, next_check_at)` | index | Rapprochement périodique |
| `audit_log` | déclencheur qui refuse `UPDATE` et `DELETE` + chaînage par hachage | Journal inaltérable |
| `CHECK` | montants ≥ 0, `arrival_at > departure_at`, statuts dans une liste | Données cohérentes |

## 5. Concurrence : les règles

### 5.1 Verrouiller un siège (un seul gagnant)
```sql
INSERT INTO trip_seats (trip_id, seat_no, status, hold_token, hold_owner, hold_expires_at)
VALUES ($1, $2, 'held', $3, $4, now() + $5::interval)
ON CONFLICT (trip_id, seat_no) DO UPDATE
   SET hold_token = EXCLUDED.hold_token, hold_owner = EXCLUDED.hold_owner,
       hold_expires_at = EXCLUDED.hold_expires_at, status = 'held'
 WHERE trip_seats.status = 'held'
   AND (trip_seats.hold_expires_at < now() OR trip_seats.hold_owner = EXCLUDED.hold_owner)
RETURNING seat_no;
```
Si aucune ligne n'est renvoyée, le siège appartient à quelqu'un d'autre : réponse `409 SEAT_TAKEN`. PostgreSQL sérialise les conflits sur la clé primaire : sur 500 demandes simultanées, exactement une réussit.

### 5.2 Cas limites et décisions

| Cas | Décision |
|---|---|
| Deux clients, même siège, même instant | Un seul obtient le verrou (§5.1). L'autre voit le siège passer en jaune en temps réel. |
| Durée du verrou | Paramétrable (10 min par défaut). Prolongation possible une fois à l'entrée dans l'écran de paiement, plafonnée. |
| Abandon / fermeture de page | Libération explicite (`DELETE /holds`, envoyée aussi par `sendBeacon`), sinon expiration automatique. Une tâche toutes les 15 s supprime les verrous expirés et diffuse l'événement. La requête §5.1 traite de toute façon un verrou expiré comme libre. |
| Paiement en attente | À l'initiation du paiement, le verrou est prolongé jusqu'au délai maximum du paiement (5 min par défaut) : le siège ne peut pas être repris pendant que le client valide sur son téléphone. |
| Paiement confirmé **après** expiration | Dans une transaction : si les sièges sont encore libres ou à lui → confirmation. Sinon → la réservation passe en `cancelled`, un remboursement automatique est créé (`refund_pending`), le client et un administrateur sont notifiés. **Jamais de double vente.** |
| Clics multiples, rafraîchissement | En-tête `Idempotency-Key` obligatoire sur `POST /bookings` et `POST /payments`. Même clé + même contenu → même réponse ; même clé + contenu différent → `422`. |
| Callback en double | `payment_events.event_key` unique : le second est ignoré (réponse 200). |
| Callbacks dans le désordre | Machine à états stricte : un paiement `succeeded` ou `refunded` ne revient jamais à `pending`/`failed`. Le statut est toujours revérifié auprès de l'opérateur avant de confirmer. |
| Callback jamais reçu | Tâche de rapprochement : interroge l'opérateur à 15 s, 30 s, 1 min, 2 min, 5 min, puis toutes les 15 min pendant 24 h. |
| Guichet et web sur le même voyage | Même table, même requête, même règle. Le guichet pose un verrou comme un client ; la vente en espèces confirme dans la même transaction. |
| Voyage annulé | Toutes les réservations confirmées passent en `cancelled`, remboursement intégral créé, e-mail/SMS aux passagers, événement temps réel. |
| Bus remplacé (plan différent) | Les sièges existant dans le nouveau plan sont conservés. Les autres passagers sont réaffectés automatiquement au siège libre le plus proche ; s'il n'y a plus de place, la réservation est marquée « à traiter » pour le guichet. Chaque passager déplacé est notifié. L'opération est refusée s'il y a des verrous actifs, puis rejouée. |
| Itinéraire suspendu | Les ventes sont fermées. Les voyages déjà vendus restent programmés tant qu'un administrateur ne les annule pas (choix explicite proposé à l'écran). |
| Chauffeur absent | Alerte sur les voyages concernés ; le voyage reste vendable mais affiché « sans chauffeur » au planning. Aucune conséquence pour le passager. |
| Annulation par le client | Autorisée jusqu'à N heures avant le départ (paramètre). Remboursement total ou partiel selon la politique configurée. Annulation possible d'un seul passager. |
| Modification | Changement de siège ou de voyage = nouvelle réservation de sièges dans une transaction, puis libération des anciens. Différence de prix gérée (complément ou remboursement partiel). |
| No-show | Marqué par le guichet ou automatiquement après le départ ; pas de remboursement par défaut (paramètre). |
| Changement de rôle en cours de session | `users.perm_version` est incrémenté ; le JWT contient la version. Version différente → `401`, le frontend rafraîchit le jeton et recharge les permissions. Les permissions sont relues en base à chaque requête (cache 30 s). |
| Sessions multiples / révocation | Une ligne `sessions` par appareil. Liste et révocation depuis le profil. Réutilisation d'un refresh token déjà tourné → toute la famille est révoquée. |
| Pic de charge | Limitation de débit par IP et par compte (Redis), file d'attente applicative sur l'ouverture d'un voyage (`sales_open_at`), pool de connexions borné, réponses `429` avec `Retry-After`. |
| Fuseaux, minuit | `departure_at`/`arrival_at` en UTC, `service_date` = date locale de départ dans le fuseau de la société. Un voyage 21:00 → 05:30 appartient à la date de départ. Pas de calcul d'heure sur des chaînes `HH:mm`. |
| Panne de l'opérateur de paiement | Délai d'attente court, disjoncteur par opérateur, message clair au client, le verrou est conservé pour un nouvel essai. |
| Perte de connexion du client | Le frontend se reconnecte au Socket.IO, redemande l'état complet des sièges, et reprend la réservation en cours grâce au `hold_token` conservé en session. |

Chaque ligne de ce tableau aura son test automatisé (phase 3 et 6).

## 6. API REST (`/api/v1`)

Format : JSON, erreurs `{ code, message, details }`, pagination `?page=&limit=` (max 100) avec `{ items, total, page, limit }`. Documentation OpenAPI servie sur `/api/docs`.

| Groupe | Endpoints |
|---|---|
| **Public** | `GET /public/config` (marque, couleurs, langues, devise, moyens de paiement actifs) · `GET /public/i18n/:lang` · `GET /health/live` · `GET /health/ready` · `GET /metrics` (protégé) |
| **Setup** | `GET /setup/status` · `PUT /setup/draft` · `POST /setup/test-email` · `POST /setup/upload` · `POST /setup/complete` (refusés avec `403` dès que l'installation est terminée) |
| **Auth** | `POST /auth/register` · `POST /auth/login` · `POST /auth/2fa/verify` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `GET /auth/me` · `PATCH /auth/me` · `POST /auth/change-password` · `GET/DELETE /auth/sessions[/:id]` · `POST /auth/2fa/setup` · `POST /auth/2fa/enable` · `POST /auth/2fa/disable` |
| **Recherche** | `GET /cities` · `GET /routes/popular` · `GET /search?from=&to=&date=&passengers=` · `GET /trips/:id` · `GET /trips/:id/seats` |
| **Sièges** | `POST /trips/:id/holds` · `PATCH /trips/:id/holds` (prolonger) · `DELETE /trips/:id/holds` |
| **Réservations (client)** | `POST /bookings` · `GET /bookings/mine` · `GET /bookings/:ref` · `POST /bookings/:ref/cancel` · `POST /bookings/:ref/change` · `GET /bookings/:ref/ticket.pdf` · `POST /bookings/:ref/resend` |
| **Paiements** | `POST /payments` · `GET /payments/:id` · `POST /payments/webhooks/:provider` |
| **Billets** | `POST /tickets/verify` (scan du QR à l'embarquement) · `POST /tickets/:number/board` |
| **Admin · réservations** | `GET /admin/bookings` · `GET /admin/bookings/:id` · `POST /admin/bookings/:id/cancel` · `POST /admin/bookings/:id/refund` · `POST /admin/bookings/:id/no-show` · `POST /admin/walkin` · `GET /admin/trips/:id/manifest` |
| **Admin · transport** | CRUD `/admin/cities` · `/admin/vehicles` · `/admin/seat-layouts` · `/admin/drivers` · `/admin/routes` (+ `suspend`, `reactivate`, `restore`) · `/admin/trip-templates` (+ `reorder`) · `/admin/trips` (+ `cancel`, `replace-vehicle`, `assign-driver`) · `GET /admin/schedule` · `GET /admin/driver-schedule` |
| **Admin · personnes** | `/admin/customers` (+ `status`) · `/admin/staff` (+ `role`, `reset-password`) · `/admin/roles` |
| **Admin · pilotage** | `GET /admin/dashboard` · `GET /admin/reports/revenue` · `GET /admin/reports/export.csv` · `GET /admin/audit` · `GET /admin/audit/verify` · `GET /admin/notifications` |
| **Admin · contenu et réglages** | CRUD `/admin/ads` · `POST /ads/:id/view|click` · `GET/PUT /admin/settings/:group` · `PUT /admin/settings/secrets/:key` · `POST /admin/settings/test-email` · `GET/PUT /admin/email-templates` · `GET/PUT /admin/payment-methods` · `POST /admin/files` |

## 7. Événements temps réel (Socket.IO)

| Salon | Événement | Contenu | Destinataires |
|---|---|---|---|
| `trip:{id}` | `seat.held` / `seat.released` / `seat.booked` | `{ tripId, seats[], expiresAt? }` | Clients, guichet, admin qui regardent ce voyage |
| `trip:{id}` | `trip.updated` / `trip.cancelled` / `trip.vehicle_changed` | état du voyage | idem |
| `user:{id}` | `booking.confirmed` / `booking.cancelled` / `payment.updated` | référence, statut | Le client concerné |
| `user:{id}` | `session.revoked` / `permissions.changed` | — | Le compte concerné |
| `staff` | `booking.created` / `booking.updated` / `dashboard.tick` | résumé | Back-office (selon permissions) |
| `staff` | `alert` | chauffeur absent, paiement à rembourser, réaffectation à traiter | Back-office |

À la connexion et à chaque reconnexion, le client demande l'état complet (`GET /trips/:id/seats`) : les événements ne servent qu'à mettre à jour, jamais comme source de vérité.

## 8. Tâches planifiées (worker BullMQ)

| Tâche | Fréquence |
|---|---|
| Expiration des verrous de sièges | 15 s |
| Expiration des réservations non payées | 1 min |
| Rapprochement des paiements en attente | selon `next_check_at` |
| Traitement des remboursements | 1 min |
| Génération des voyages à partir des modèles récurrents (60 jours glissants) | chaque nuit + à chaque modification |
| Clôture des voyages terminés, no-show automatique | 10 min |
| Rappels avant départ (e-mail/SMS) | 10 min |
| Envoi des e-mails et génération des PDF | file, à la demande |
| Purge (sessions expirées, clés d'idempotence, tentatives de connexion) | chaque nuit |
| Sauvegarde PostgreSQL (`pg_dump`) | chaque nuit (conteneur dédié) |

## 9. Sécurité

| Risque | Mesure |
|---|---|
| Mots de passe | Argon2id côté serveur, politique de robustesse, jamais renvoyés ni journalisés |
| Sessions | JWT d'accès 15 min en mémoire, refresh token tournant en cookie `httpOnly; Secure; SameSite=Strict`, révocation par appareil |
| Double authentification | TOTP (Google Authenticator, etc.) + codes de secours ; recommandée pour les comptes internes, exigible par rôle |
| Autorisations | Décorateur `@RequirePermission()` sur **chaque** route admin, vérifié en base ; un client ne voit que ses réservations |
| Injection SQL | Requêtes paramétrées uniquement (Kysely) |
| XSS | Angular échappe par défaut ; en-têtes CSP ; HTML des modèles d'e-mail assaini |
| CSRF | Jeton d'accès en en-tête `Authorization` (non envoyé automatiquement) ; cookie de refresh `SameSite=Strict` limité au chemin `/api/v1/auth` |
| Force brute | Limitation par IP et par identifiant, blocage progressif, journalisation |
| Abus | Limitation de débit globale et par route (Redis), taille de requête bornée |
| Secrets | Clés de paiement et SMTP chiffrées en AES-256-GCM avec une clé maîtresse fournie par variable d'environnement ; jamais envoyées au frontend (affichage masqué `••••1234`) |
| Webhooks | Signature ou jeton secret par opérateur + revérification du statut auprès de l'opérateur |
| Journal d'audit | Table en ajout seul (déclencheur), chaînage SHA-256, endpoint de vérification d'intégrité |
| Validation | DTO stricts (`class-validator`, liste blanche, rejet des champs inconnus) |
| Transport | HTTPS forcé, HSTS, en-têtes de sécurité |
| Fichiers | Type et taille vérifiés, noms régénérés, stockés hors de la racine web |
| Données personnelles | Minimisation, export et suppression/anonymisation d'un client sur demande, durées de conservation paramétrables, mentions dans les CGV |
| Sauvegardes | Dump quotidien chiffrable, rotation 7 jours / 4 semaines / 6 mois, script de restauration testé |

## 10. Marque blanche et assistant de configuration

- Au démarrage, le frontend appelle `GET /public/config`. Si `setup.status != completed`, il redirige vers `/setup`.
- Les couleurs sont appliquées par variables CSS (`--brand-50…900`) générées à partir de la couleur principale ; Tailwind est configuré pour utiliser ces variables.
- Nom, logo, slogan, devise, formats, langues, textes du billet et des e-mails viennent de la configuration. Valeur par défaut neutre : **« Ma Compagnie »**.
- Le préfixe des clés de stockage local devient neutre (`bb_`), et il n'y reste que la langue, le thème et le jeton de verrou.
- Le préfixe des références de billet devient configurable (3 lettres dérivées du nom par défaut).
- Les 10 groupes de l'assistant correspondent chacun à une clé de `app_settings`, donc tout reste modifiable ensuite dans Paramètres avec les mêmes formulaires.
- Groupes que j'ajoute à votre liste : **gares et points de vente** (adresse des lieux de départ, affichée sur le billet) et **catégories tarifaires** (adulte, enfant, réduction).

## 11. Déploiement et exploitation

- `docker-compose.yml` : `proxy` (Caddy), `web` (fichiers Angular), `api`, `worker`, `db` (PostgreSQL), `redis`, `backup`.
- `.env.example` : domaine, mots de passe, clé de chiffrement, secrets JWT. Un script `install.sh` génère les secrets.
- Migrations appliquées automatiquement au démarrage de l'API (verrou consultatif pour éviter deux exécutions).
- Scripts : `install.sh`, `update.sh`, `backup.sh`, `restore.sh`.
- Journaux structurés JSON (pino), métriques Prometheus sur `/metrics`, contrôles `/health/live` et `/health/ready`.
- CI GitHub Actions : lint, tests unitaires, tests d'intégration avec PostgreSQL et Redis en services, build des images.
- Configuration minimale conseillée par client : 2 vCPU, 4 Go de RAM, 40 Go de disque.

## 12. Décisions à valider

| # | Question | Ma proposition |
|---|---|---|
| 1 | Backend Node.js / NestJS + PostgreSQL + Redis | Oui |
| 2 | Une installation Docker Compose par société | Oui (votre hypothèse) |
| 3 | Le frontend reste à la racine du dépôt, `backend/` et `deploy/` ajoutés à côté | Oui |
| 4 | Retirer « carte bancaire », « UPI » et « net banking » de l'écran de paiement (hérités d'un modèle indien, aucun prestataire derrière) | Oui, garder mobile money + espèces au guichet, architecture ouverte pour ajouter un moyen plus tard |
| 5 | Un client peut-il réserver **sans compte** (invité, avec téléphone et e-mail) ? | Oui, c'est l'usage dominant sur mobile ; le compte reste proposé |
| 6 | Paiement confirmé après expiration du verrou et siège repris | Remboursement automatique + notification |
| 7 | Vente en ligne fermée combien de temps avant le départ ? | 30 min par défaut, paramétrable |
| 8 | Horaires « de secours » fictifs quand aucun voyage n'est programmé | Supprimés : seuls les voyages réellement programmés sont vendus |
| 9 | Remboursements mobile money | Automatiques si l'API de l'opérateur le permet, sinon file « à rembourser manuellement » dans le back-office |
| 10 | SMS | Interface prête + mode simulé ; fournisseur à choisir par le client |

## 13. Ce que je ne pourrai pas tester moi-même

- **Docker Compose** : mon environnement n'a pas de démon Docker. Les fichiers seront écrits et validés syntaxiquement, à exécuter sur un serveur.
- **API réelles MVola, Orange Money, Airtel Money** : nécessitent des identifiants marchands. Je livre les adaptateurs écrits d'après la documentation publique des opérateurs et un simulateur complet (succès, échec, retard, doublon, désordre). Les adaptateurs réels devront être validés en bac à sable avec vos identifiants.
- **Envoi SMTP réel** : testé contre un serveur SMTP local de test, pas contre un fournisseur réel.

## 14. Écarts entre ce document et la réalisation

Le produit livré suit cette architecture, avec les ajustements suivants, décidés pendant le développement.

| Sujet | Prévu | Réalisé | Raison |
|---|---|---|---|
| Accès aux données | `pg` + Kysely | SQL paramétré avec `pg` seul | Contrôle direct des verrous (`FOR UPDATE`, `ON CONFLICT`), une dépendance de moins |
| Tâches planifiées | Worker BullMQ | Ordonnanceur interne, protégé par verrous consultatifs PostgreSQL ; e-mails par table d'envoi (`notifications_outbox`) | Un message est créé dans la même transaction que la réservation : il ne peut pas se perdre. Plusieurs instances peuvent tourner sans doublon |
| Rôle de Redis | Cache, files, diffusion | Limitation de débit et diffusion des événements temps réel entre processus | Conséquence du point précédent. Sans Redis, l'API reste utilisable en mode dégradé |
| Validation des entrées | `class-validator` | Schémas `zod` stricts (champs inconnus refusés) | Un seul schéma sert à la validation et à la documentation OpenAPI |
| Identifiants | UUID v7 | UUID v4 (`gen_random_uuid()`) | Générés par la base, sans dépendance |
| Verrous de sièges | Une table `trip_seats` | `trip_seats` comme prévu (clé unique `(trip_id, seat_no)`, état `held` ou `booked`) + une table `seat_holds` qui porte la session de verrou (jeton, expiration, prolongations) | Un voyageur verrouille plusieurs sièges avec une seule échéance |
| Conteneurs | `proxy` (Caddy) + `web` (fichiers) | Un seul conteneur `web` : Caddy sert les fichiers du site et fait le reverse proxy HTTPS | Un service de moins à exploiter ; configuration testée localement |
| Adresse des callbacks de paiement | `/payments/webhooks/:provider` | `/payments/webhooks/:method/:paymentId/:signature` | L'adresse est signée par paiement : un tiers ne peut pas forger un callback |
| Permissions | 16 + 4 nouvelles | 16 + 5 : `canSellWalkin`, `canRefund`, `canManageAds`, `canViewAudit`, `canCheckTickets` | Le contrôle des billets a sa propre permission (chauffeurs) |
| Groupes « gares » et « catégories tarifaires » | Groupes séparés | Tarif enfant et bagages dans le groupe Réservation ; pas de liste de gares | L'adresse de départ est celle de la société (groupe Contact). Une liste de gares par ville reste une évolution possible |

Les API réelles des opérateurs (MVola, Orange Money, Airtel Money) sont écrites d'après leur documentation publique et **n'ont pas été exécutées contre les opérateurs** : seul le mode simulé est testé. Docker Compose a été validé (`docker compose config`) mais pas exécuté dans l'environnement de développement ; la configuration Caddy, les scripts de sauvegarde et de restauration ont été exécutés hors conteneur.
