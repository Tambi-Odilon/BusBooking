// Documentation technique — pour l'administrateur système et le technicien.
// Syntaxe : **gras**, `code`, variables {{SOCIETE}} {{SITE}} {{EMAIL}} {{TELEPHONE}}.
export default {
  file: 'documentation-technique',
  kicker: 'Documentation technique',
  title: 'Installation, exploitation et maintenance',
  subtitle: 'Pour l\'administrateur système et le technicien',
  blocks: [
    ['h1', '1. Présentation'],
    ['p', 'Ce document décrit l\'installation, la configuration, l\'exploitation et le dépannage de l\'application de réservation de billets de bus de **{{SOCIETE}}**. Il s\'adresse à la personne qui gère le serveur.'],
    ['p', 'L\'application comprend un site de réservation pour les voyageurs, un back-office pour le personnel (adresse `/admin`) et une API qui garantit qu\'un siège n\'est jamais vendu deux fois. Chaque société dispose de sa propre installation et de sa propre base de données.'],
    ['table', ['Élément', 'Technologie', 'Rôle'], [
      ['Site et back-office', 'Angular 20, Tailwind', 'Interface des voyageurs et du personnel'],
      ['API', 'Node.js 22, NestJS, Fastify', 'Règles métier, sécurité, paiements, billets'],
      ['Base de données', 'PostgreSQL 16', 'Données et verrous de sièges'],
      ['Cache et messages', 'Redis 7', 'Limitation de débit, diffusion du temps réel'],
      ['Temps réel', 'Socket.IO', 'Mise à jour instantanée des sièges et du back-office'],
      ['Proxy et HTTPS', 'Caddy 2', 'Certificat Let\'s Encrypt automatique, fichiers du site'],
    ]],

    ['h1', '2. Architecture'],
    ['code', `Internet ──HTTPS──▶ web (Caddy : fichiers du site + proxy)
                       │  /api/*  /socket.io/*  /health/*
                       ▼
                     api (NestJS) ◀──────▶ redis
                       │                     ▲
                       ▼                     │
                     db (PostgreSQL) ◀──── worker (tâches planifiées)
                                              │
                     backup (sauvegarde quotidienne)
                                              ▼
              MVola · Orange Money · Airtel Money · SMTP · SMS`],
    ['table', ['Service', 'Image', 'Rôle', 'Données persistantes'], [
      ['`web`', '`busbooking-web`', 'Sert le site, termine le HTTPS, relaie vers l\'API', 'Volumes `caddy_data`, `caddy_config` (certificats)'],
      ['`api`', '`busbooking-api`', 'API REST et temps réel', 'Volume `uploads` (logos, images)'],
      ['`worker`', '`busbooking-api`', 'Tâches planifiées (même code que l\'API)', 'Volume `uploads`'],
      ['`db`', '`postgres:16-alpine`', 'Base de données', 'Volume `pgdata`'],
      ['`redis`', '`redis:7-alpine`', 'Limitation de débit, messages temps réel', 'Aucune (données reconstituables)'],
      ['`backup`', '`busbooking-backup`', 'Sauvegarde quotidienne', 'Dossier `deploy/backups` du serveur'],
    ]],
    ['note', 'Seul le service `web` est exposé sur Internet (ports 80 et 443). La base et Redis ne sont accessibles que depuis le réseau interne de Docker.'],
    ['h2', 'Comment la double vente est empêchée'],
    ['p', 'Chaque siège occupé d\'un voyage est une ligne de la table `trip_seats`, dont la clé primaire est `(trip_id, seat_no)`. PostgreSQL refuse donc physiquement qu\'un siège existe deux fois. Le verrou temporaire et la vente sont la même ligne : passer de « verrouillé » à « vendu » se fait dans une seule transaction. Les écrans ne sont jamais la source de vérité.'],

    ['h1', '3. Installation'],
    ['h2', 'Prérequis'],
    ['ul', [
      'Serveur Linux (Ubuntu 22.04 ou plus récent conseillé) : 2 vCPU, 4 Go de RAM, 40 Go de disque.',
      'Docker Engine et le plugin Docker Compose.',
      'Un nom de domaine dont l\'enregistrement DNS **A** pointe vers le serveur.',
      'Ports 80 et 443 ouverts vers Internet.',
    ]],
    ['h2', 'Procédure'],
    ['ol', [
      'Copier le dossier du produit sur le serveur (par exemple dans `/opt/busbooking`).',
      'Lancer le script d\'installation avec le nom de domaine.',
      'Noter le **code d\'installation** affiché à la fin.',
      'Ouvrir le site : l\'assistant de première configuration démarre.',
    ]],
    ['code', `cd /opt/busbooking/deploy
./scripts/install.sh reservation.masociete.mg`],
    ['p', 'Le script crée le fichier `deploy/.env` avec des secrets générés aléatoirement, construit les images, démarre les services et attend que l\'API réponde. Le certificat HTTPS est obtenu automatiquement au premier accès.'],
    ['warn', 'Faites immédiatement une copie du fichier `deploy/.env` dans un endroit sûr, hors du serveur. La variable `APP_ENCRYPTION_KEY` est indispensable pour relire les clés de paiement et le mot de passe SMTP après une restauration.'],
    ['h2', 'Essai sur un poste de travail'],
    ['code', `./scripts/install.sh localhost      # puis ouvrir https://localhost (certificat auto-signé à accepter)`],

    ['h1', '4. Assistant de première configuration'],
    ['p', 'Tant que l\'application n\'est pas configurée, toute visite est redirigée vers `/setup`. Si la variable `SETUP_TOKEN` est définie, l\'assistant demande d\'abord ce code : il empêche un inconnu de configurer l\'application avant vous.'],
    ['img', 'setup-01-identite', 'Assistant de configuration : étape Identité, avec l\'aperçu en direct du site et du billet'],
    ['table', ['Étape', 'Contenu', 'Obligatoire'], [
      ['1. Identité', 'Nom commercial, raison sociale, slogan, logo clair et sombre, favicon, couleurs, préfixe des références', 'Nom commercial'],
      ['2. Contact', 'E-mails, téléphones, WhatsApp, adresse, horaires, réseaux sociaux', 'Non'],
      ['3. Légal et fiscal', 'Numéros d\'immatriculation (NIF, STAT, RCS…), taxe, conditions générales, politique d\'annulation, confidentialité, mention sur le billet, durée de conservation des données', 'Non'],
      ['4. Régionalisation', 'Pays (préréglages), devise, fuseau horaire, formats de date et d\'heure, langues', 'Non'],
      ['5. Paiements', 'Activation de MVola, Orange Money, Airtel Money, espèces ; mode test ou production ; clés', 'Non'],
      ['6. Notifications', 'SMTP avec bouton d\'e-mail de test, SMS, envoi automatique du billet', 'Non'],
      ['7. Réservation', 'Durée du verrou, délai de paiement, passagers maximum, frais de service, annulation, modification, tarif enfant, bagages, rappel', 'Non'],
      ['8. Billet', 'Logo, couleur d\'en-tête, consignes, pied de page, contenu du QR code', 'Non'],
      ['9. Administrateur', 'Prénom, nom, e-mail, mot de passe fort, double authentification', 'Oui'],
      ['10. Données de départ', 'Démarrer vide, ou importer un exemple (3 villes, 2 itinéraires, 2 véhicules)', 'Non'],
      ['11. Vérification', 'Résumé, liste de ce qui manque, bouton Terminer', '—'],
    ]],
    ['ul', [
      'Le brouillon est enregistré automatiquement : on peut fermer la page et reprendre plus tard.',
      'Les mots de passe et les clés ne sont jamais enregistrés dans le brouillon.',
      'Une fois terminé, l\'assistant est fermé définitivement : l\'API répond `403` et la page redirige vers la connexion.',
      'Tout reste modifiable ensuite dans le back-office, menu **Société et réglages**.',
    ]],
    ['img', 'setup-05-paiements', 'Étape Paiements : chaque moyen s\'active séparément, en mode test ou production'],

    ['h1', '5. Configuration'],
    ['h2', 'Variables d\'environnement (`deploy/.env`)'],
    ['table', ['Variable', 'Rôle', 'Défaut'], [
      ['`DOMAIN`', 'Nom de domaine servi par Caddy. `localhost` pour un essai', '—'],
      ['`PUBLIC_URL`', 'Adresse publique complète (`https://…`). Sert aux liens des e-mails, aux callbacks de paiement et au contrôle d\'origine', '—'],
      ['`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`', 'Base de données. Mot de passe en lettres et chiffres uniquement', '`busbooking`'],
      ['`REDIS_PASSWORD`', 'Mot de passe Redis', 'généré'],
      ['`JWT_SECRET`', 'Signature des jetons de connexion (32 caractères minimum)', 'généré'],
      ['`APP_ENCRYPTION_KEY`', 'Clé maîtresse qui chiffre les secrets en base (32 caractères minimum)', 'généré'],
      ['`WEBHOOK_SECRET`', 'Signature des adresses de callback de paiement', 'généré'],
      ['`SETUP_TOKEN`', 'Code demandé par l\'assistant de configuration', 'généré'],
      ['`METRICS_TOKEN`', 'Jeton de lecture de `/metrics`. Vide : métriques désactivées', 'généré'],
      ['`DB_POOL_MAX`', 'Connexions PostgreSQL par processus', '`20`'],
      ['`LOG_LEVEL`', '`debug`, `info`, `warn` ou `error`', '`info`'],
      ['`COOKIE_SECURE`', '`false` uniquement en HTTP simple (essai local)', '`true`'],
      ['`SMTP_ALLOW_SELF_SIGNED`', '`true` si le serveur SMTP a un certificat auto-signé', '`false`'],
      ['`BACKUP_DIR`, `BACKUP_HOUR`, `TZ`', 'Dossier, heure et fuseau de la sauvegarde quotidienne', '`./backups`, `2`'],
      ['`BACKUP_PASSPHRASE`', 'Chiffre les sauvegardes en AES-256. Vide : non chiffrées', 'vide'],
      ['`BACKUP_KEEP_DAILY`, `_WEEKLY`, `_MONTHLY`', 'Durées de conservation en jours', '`7`, `35`, `190`'],
    ]],
    ['p', 'Après toute modification de `.env`, relancer : `docker compose --env-file .env up -d`.'],
    ['h2', 'Réglages dans le back-office'],
    ['p', 'Le menu **Société et réglages** reprend tous les groupes de l\'assistant et ajoute : **Modèles d\'e-mails** (objet et texte de chaque message, avec variables comme `{{company_name}}` ou `{{reference}}`), **Textes et langues** (modifier un texte du site ou ajouter une langue) et **Sécurité** (rôles pour lesquels la double authentification est obligatoire, durée des sessions, nombre d\'essais de connexion).'],
    ['img', 'admin-28-company', 'Société et réglages : tout ce que l\'assistant a demandé reste modifiable'],
    ['h2', 'Secrets'],
    ['p', 'Les clés des opérateurs de paiement et le mot de passe SMTP sont chiffrés en AES-256-GCM avec `APP_ENCRYPTION_KEY` avant d\'être enregistrés. Ils ne sont jamais renvoyés au navigateur : l\'écran indique seulement qu\'une valeur est enregistrée.'],

    ['h1', '6. Paiements'],
    ['table', ['Moyen', 'Mode test sans clés', 'Remboursement'], [
      ['MVola', 'Simulateur intégré', 'À faire à la main (pas d\'API de remboursement)'],
      ['Orange Money', 'Simulateur intégré', 'À faire à la main'],
      ['Airtel Money', 'Simulateur intégré', 'Automatique par l\'API'],
      ['Espèces au guichet', '—', 'Au guichet'],
    ]],
    ['h2', 'Simulateur'],
    ['p', 'En mode test, sans clés saisies, le paiement est simulé : aucun débit réel. Les quatre derniers chiffres du numéro payeur pilotent le résultat.'],
    ['table', ['Numéro terminé par', 'Résultat simulé'], [
      ['`0000`', 'Paiement refusé'],
      ['`0001`', 'Aucune réponse de l\'opérateur (la réservation expire)'],
      ['`0002`', 'Paiement confirmé en retard, après l\'expiration du verrou'],
      ['autre', 'Paiement accepté après quelques secondes'],
    ]],
    ['h2', 'Cycle d\'un paiement'],
    ['ol', [
      'Le voyageur valide : l\'API crée le paiement et prolonge le verrou des sièges pendant le délai de paiement.',
      'L\'opérateur envoie une demande de validation sur le téléphone du voyageur.',
      'La confirmation arrive par callback, à une adresse signée propre à ce paiement. Sans callback, une tâche interroge l\'opérateur à intervalles croissants.',
      'À la confirmation, l\'API vérifie que les sièges sont toujours réservés pour ce voyageur, émet les billets et envoie l\'e-mail.',
      'Si la confirmation arrive après que le siège a été revendu, la réservation est annulée et un remboursement est créé. Il n\'y a jamais deux billets pour un siège.',
    ]],
    ['warn', 'Les connecteurs MVola, Orange Money et Airtel Money sont écrits d\'après la documentation publique des opérateurs. Ils n\'ont pas été exécutés contre les opérateurs. Avant de passer un moyen en « Production », faites un paiement d\'essai complet en bac à sable avec les identifiants de {{SOCIETE}}.'],

    ['h1', '7. Base de données'],
    ['p', 'Le schéma est créé par `backend/migrations/001_init.sql` (35 tables). Les migrations manquantes sont appliquées au démarrage de l\'API, sous verrou, chacune dans sa transaction.'],
    ['table', ['Domaine', 'Tables'], [
      ['Configuration', '`app_settings`, `app_secrets`, `setup_state`, `payment_methods`, `email_templates`, `translations_override`, `files`'],
      ['Comptes et sécurité', '`users`, `roles`, `sessions`, `auth_tokens`, `login_attempts`, `role_changes`, `audit_log`'],
      ['Transport', '`cities`, `seat_layouts`, `vehicles`, `drivers`, `routes`, `route_vehicles`, `trip_templates`, `trips`'],
      ['Réservation', '`seat_holds`, `trip_seats`, `bookings`, `booking_passengers`'],
      ['Paiement', '`payments`, `payment_events`, `payment_simulations`, `refunds`, `idempotency_keys`'],
      ['Communication', '`notifications_outbox`, `ads`, `ad_stats_daily`, `jobs_log`'],
    ]],
    ['h2', 'Contraintes qui protègent les données'],
    ['table', ['Contrainte', 'Effet'], [
      ['Clé primaire `trip_seats (trip_id, seat_no)`', 'Un siège n\'existe qu\'une fois par voyage'],
      ['Clés d\'idempotence uniques sur réservations et paiements', 'Un double clic ne crée pas de doublon'],
      ['`payment_events.event_key` unique', 'Un callback reçu deux fois est traité une fois'],
      ['Exclusion sur `trips (vehicle_id, créneau horaire)`', 'Un véhicule ne peut pas faire deux voyages qui se chevauchent'],
      ['Déclencheur sur `audit_log`', 'Modification et suppression refusées ; chaque ligne est chaînée par hachage à la précédente'],
    ]],
    ['p', 'Les montants sont des entiers dans la plus petite unité de la devise. Les dates sont enregistrées en UTC ; la date de service d\'un voyage est la date locale de départ dans le fuseau de la société, y compris pour un voyage de nuit qui passe minuit.'],
    ['h2', 'Accès direct à la base'],
    ['code', `docker compose --env-file .env exec db psql -U busbooking busbooking`],

    ['h1', '8. API'],
    ['p', 'L\'API est servie sous `{{SITE}}/api/v1`. La documentation interactive OpenAPI (Swagger) est sur `{{SITE}}/api/docs` : elle décrit les 112 chemins et leurs paramètres. La liste figure aussi dans `docs/tests/api-routes.json`.'],
    ['table', ['Groupe', 'Exemples'], [
      ['Public', '`GET /public/config`, `GET /public/i18n/{lang}`, `GET /cities`, `GET /search`'],
      ['Assistant', '`GET /setup/status`, `PUT /setup/draft`, `POST /setup/complete`'],
      ['Authentification', '`POST /auth/login`, `/auth/refresh`, `/auth/2fa/verify`, `GET /auth/sessions`, `GET /auth/me/export`'],
      ['Sièges', '`GET /trips/{id}/seats`, `POST|PATCH|DELETE /trips/{id}/holds`'],
      ['Réservations', '`POST /bookings`, `POST /bookings/lookup`, `POST /bookings/{ref}/cancel`, `/change`, `GET /bookings/{ref}/ticket.pdf`'],
      ['Paiements', '`POST /payments`, `GET /payments/{id}`, callbacks sous `/payments/webhooks/…`'],
      ['Contrôle', '`POST /tickets/verify`, `POST /tickets/board`'],
      ['Administration', '`/admin/bookings`, `/admin/walkin`, `/admin/trips`, `/admin/trip-templates`, `/admin/vehicles`, `/admin/drivers`, `/admin/routes`, `/admin/staff`, `/admin/roles`, `/admin/refunds`, `/admin/audit`, `/admin/settings`'],
    ]],
    ['ul', [
      'Format JSON. Erreurs : `{ "code": "SEAT_TAKEN", "message": "…", "details": {…} }`.',
      'Listes paginées : `?page=&limit=` (100 au maximum).',
      'Écritures sensibles : en-tête `Idempotency-Key` obligatoire sur la création de réservation, le paiement et la vente au guichet.',
      'Authentification : jeton d\'accès de 15 minutes dans l\'en-tête `Authorization: Bearer`, renouvelé par un cookie `httpOnly`.',
    ]],

    ['h1', '9. Temps réel'],
    ['p', 'Le navigateur ouvre une connexion Socket.IO sur `/socket.io` (WebSocket, avec repli automatique en requêtes longues sur réseau mobile instable). À chaque connexion ou reconnexion, il relit l\'état complet par l\'API : les événements ne servent qu\'à mettre à jour l\'écran.'],
    ['table', ['Salon', 'Événements', 'Destinataires'], [
      ['`trip:{id}`', '`seat.held`, `seat.released`, `seat.booked`, `trip.updated`, `trip.cancelled`, `trip.vehicle_changed`', 'Toute personne qui regarde ce voyage'],
      ['`booking:{id}`, `user:{id}`', '`payment.updated`, `session.revoked`, `permissions.changed`', 'Le voyageur ou le compte concerné'],
      ['`staff`', '`booking.created`, `booking.updated`, `alert`', 'Le back-office'],
      ['`public`', '`config.changed`', 'Tous (changement de nom, de couleurs…)'],
    ]],

    ['h1', '10. Tâches planifiées'],
    ['p', 'Le service `worker` exécute les tâches ci-dessous. Chacune prend un verrou en base : plusieurs instances peuvent tourner sans doublon, et rejouer une tâche ne casse rien.'],
    ['table', ['Tâche', 'Fréquence', 'Rôle'], [
      ['`expire-holds`', '15 s', 'Libère les sièges dont le verrou a expiré'],
      ['`expire-bookings`', '1 min', 'Clôt les réservations non payées'],
      ['`reconcile-payments`', '10 s', 'Interroge les opérateurs pour les paiements sans réponse'],
      ['`process-refunds`', '1 min', 'Exécute les remboursements automatiques'],
      ['`send-notifications`', '5 s', 'Envoie les e-mails et SMS en attente'],
      ['`close-trips`', '1 min', 'Clôt les voyages terminés'],
      ['`trip-reminders`', '10 min', 'Rappel avant le départ'],
      ['`generate-trips`', '6 h', 'Crée les départs à partir des voyages programmés ; fin des suspensions et des congés'],
      ['`housekeeping`', '6 h', 'Purge technique et anonymisation des anciennes réservations'],
    ]],

    ['h1', '11. Sécurité'],
    ['table', ['Sujet', 'Mesure'], [
      ['Mots de passe', 'Hachage Argon2 côté serveur ; 10 caractères minimum'],
      ['Sessions', 'Jeton d\'accès court ; jeton de renouvellement tournant en cookie `httpOnly`, `Secure`, `SameSite=Strict` ; une session par appareil, révocable'],
      ['Double authentification', 'Code à 6 chiffres (application d\'authentification) et 8 codes de secours ; obligatoire pour les rôles choisis'],
      ['Autorisations', '21 permissions vérifiées par le serveur à chaque requête ; un changement de rôle s\'applique immédiatement'],
      ['Force brute et abus', 'Limitation de débit par adresse IP et par compte ; blocage temporaire après plusieurs échecs'],
      ['Injection et XSS', 'Requêtes SQL paramétrées ; validation stricte des entrées ; politique CSP'],
      ['CSRF', 'Jeton en en-tête, cookie `SameSite=Strict`, contrôle de l\'origine'],
      ['Transport', 'HTTPS forcé, HSTS, en-têtes de sécurité'],
      ['Journal d\'audit', 'En ajout seul, chaîné par hachage ; bouton **Vérifier l\'intégrité**'],
      ['Données personnelles', 'Export et suppression du compte par le voyageur ; anonymisation des anciennes réservations après la durée choisie'],
    ]],
    ['img', 'admin-27-audit', 'Journal d\'audit : chaque action sensible est tracée et ne peut être ni modifiée ni supprimée'],

    ['h1', '12. Sauvegarde et restauration'],
    ['p', 'Le service `backup` sauvegarde chaque jour, à l\'heure `BACKUP_HOUR`, la base de données et les fichiers envoyés (logos, images). Les archives sont dans `deploy/backups` : `daily` (7 jours), `weekly` (5 semaines) et `monthly` (6 mois).'],
    ['code', `./scripts/backup.sh                                              # sauvegarde immédiate
./scripts/restore.sh backups/daily/backup-AAAAMMJJ-HHMMSS.tar    # restauration complète`],
    ['warn', 'La restauration remplace toutes les données actuelles. Le script arrête le site, demande de taper RESTAURER, restaure, puis redémarre.'],
    ['ul', [
      'Copiez régulièrement le dossier `deploy/backups` hors du serveur : une sauvegarde qui reste sur le même disque ne protège pas d\'une panne.',
      'Faites un essai de restauration sur un serveur de test au moins une fois par trimestre.',
      'Si `BACKUP_PASSPHRASE` est définie, les archives portent l\'extension `.enc` et la même phrase est nécessaire pour restaurer.',
    ]],

    ['h1', '13. Mise à jour'],
    ['ol', [
      'Placer la nouvelle version du code dans le dossier du produit (copie ou `git pull`), sans toucher à `deploy/.env` ni à `deploy/backups`.',
      'Lancer `./scripts/update.sh` depuis `deploy/`.',
      'Le script fait une sauvegarde, reconstruit les images, redémarre et vérifie que l\'API répond. Les migrations de base s\'appliquent au démarrage.',
      'En cas d\'échec, restaurer la sauvegarde qui vient d\'être faite avec l\'ancienne version du code.',
    ]],

    ['h1', '14. Supervision'],
    ['table', ['Point de contrôle', 'Usage'], [
      ['`GET /health/live`', 'Le processus répond ; renvoie la version'],
      ['`GET /health/ready`', 'Base et Redis joignables. `503` si la base est indisponible ; `degraded` si seul Redis manque'],
      ['`GET /metrics`', 'Métriques Prometheus (durée des requêtes, connexions à la base, clients temps réel). Accessible depuis le réseau interne avec `Authorization: Bearer <METRICS_TOKEN>`'],
      ['Journaux', 'JSON structuré : `docker compose --env-file .env logs -f api worker`'],
      ['Système (back-office)', 'État du serveur et version en service'],
      ['E-mails et SMS (back-office)', 'Messages envoyés, en échec, simulés ; bouton pour relancer'],
    ]],
    ['p', 'Un contrôle externe simple consiste à appeler `{{SITE}}/health/ready` toutes les minutes et à alerter si la réponse n\'est pas `200`.'],

    ['h1', '15. Dépannage'],
    ['table', ['Symptôme', 'Cause probable', 'Action'], [
      ['Le site ne s\'ouvre pas en HTTPS', 'DNS non propagé ou ports 80/443 fermés', '`docker compose logs web` ; vérifier le DNS et le pare-feu'],
      ['L\'API ne démarre pas : « Variable d\'environnement manquante »', 'Secret absent de `.env`', 'Compléter `.env`, relancer'],
      ['Connexion impossible, la page revient à l\'identification', '`PUBLIC_URL` ne correspond pas au domaine, ou site en HTTP avec `COOKIE_SECURE=true`', 'Corriger `PUBLIC_URL` ; utiliser HTTPS'],
      ['Réponse `403 CSRF_ORIGIN`', 'Le site est ouvert par une autre adresse que `PUBLIC_URL`', 'N\'utiliser qu\'une adresse'],
      ['Réponse `429`', 'Limitation de débit atteinte', 'Attendre le délai indiqué'],
      ['Réponse `503` avec « réessayez »', 'Base saturée par un pic', 'Passager. Si fréquent : augmenter `DB_POOL_MAX` et les ressources'],
      ['Les e-mails ne partent pas', 'SMTP non configuré ou refusé', 'E-mails et SMS : lire l\'erreur ; tester dans Notifications'],
      ['Paiement resté « en attente »', 'L\'opérateur n\'a pas répondu', 'Le rapprochement réessaie pendant 24 h ; vérifier chez l\'opérateur'],
      ['Sièges qui ne se mettent pas à jour en direct', 'WebSocket bloqué ou Redis arrêté', '`/health/ready` ; `docker compose logs redis`'],
      ['Secrets illisibles après restauration', '`APP_ENCRYPTION_KEY` différente', 'Remettre la clé d\'origine, ou ressaisir les clés'],
      ['Administrateur sans téléphone ni codes de secours', 'Double authentification perdue', 'Voir la procédure ci-dessous'],
    ]],
    ['h2', 'Désactiver la double authentification d\'un compte en urgence'],
    ['code', `docker compose --env-file .env exec db psql -U busbooking busbooking \\
  -c "UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '[]' WHERE lower(email) = 'admin@masociete.mg'"`],
    ['p', 'La personne se connecte ensuite avec son mot de passe et réactive la double authentification depuis son profil.'],

    ['h1', '16. Maintenance'],
    ['table', ['Fréquence', 'Tâche'], [
      ['Chaque jour', 'Vérifier le contrôle `/health/ready` ; regarder **Remboursements → À faire à la main** et **E-mails et SMS → En échec**'],
      ['Chaque semaine', 'Copier les sauvegardes hors du serveur ; vérifier l\'espace disque (`df -h`)'],
      ['Chaque mois', 'Appliquer les mises à jour de sécurité du système ; cliquer sur **Vérifier l\'intégrité** dans le journal d\'audit ; relire la liste des comptes internes'],
      ['Chaque trimestre', 'Essai de restauration ; mise à jour des images (`./scripts/update.sh`)'],
      ['Chaque année', 'Renouveler les secrets si une personne ayant eu accès au serveur a quitté la société'],
    ]],

    ['h1', '17. Tests'],
    ['p', 'Les tests se lancent depuis `backend/` avec PostgreSQL et Redis disponibles.'],
    ['code', `npm test              # 252 tests : unitaires, intégration, concurrence
npm run test:load     # charge HTTP réelle`],
    ['table', ['Scénario de charge', 'Résultat mesuré'], [
      ['500 clients sur le même siège au même instant', '1 gagnant, 499 refus `409`, aucune erreur'],
      ['1 000 clients pour un bus de 48 places, parcours complet avec paiement', '48 billets, aucun siège en double, aucune erreur `500`'],
      ['4 000 lectures, 200 en parallèle', 'Toutes réussies, environ 540 requêtes par seconde'],
    ]],
    ['p', 'Les résultats détaillés sont dans `docs/tests/`. Ces mesures viennent d\'une machine de développement : elles prouvent l\'absence de double vente, pas la capacité exacte de votre serveur.'],

    ['h1', '18. Limites connues'],
    ['ul', [
      'Les images Docker n\'ont pas été construites ni exécutées pendant le développement (pas de Docker disponible). Le fichier Compose est validé syntaxiquement ; la configuration Caddy, la sauvegarde et la restauration ont été exécutées hors conteneur.',
      'Les connecteurs de paiement réels sont à valider en bac à sable avec des identifiants marchands.',
      'L\'envoi d\'e-mails a été testé contre un serveur SMTP de test, pas contre un fournisseur réel.',
      'Le contrôle des billets par la caméra dépend du navigateur ; un lecteur de codes ou la saisie du numéro fonctionnent partout.',
    ]],

    ['h1', 'Glossaire'],
    ['table', ['Terme', 'Définition'], [
      ['API', 'Programme du serveur que le site interroge pour lire et enregistrer les données'],
      ['Callback', 'Appel envoyé par l\'opérateur de paiement à l\'API pour annoncer le résultat d\'un paiement'],
      ['Conteneur', 'Programme isolé lancé par Docker'],
      ['Idempotence', 'Propriété d\'une opération qui donne le même résultat même si elle est envoyée plusieurs fois'],
      ['Migration', 'Fichier SQL qui fait évoluer le schéma de la base'],
      ['Rapprochement', 'Vérification périodique des paiements auprès de l\'opérateur'],
      ['Verrou de siège', 'Réservation temporaire d\'un siège pendant que le voyageur termine sa commande'],
      ['Worker', 'Processus qui exécute les tâches planifiées'],
    ]],
  ],
};
