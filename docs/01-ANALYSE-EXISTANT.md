# Phase 1 — Analyse du code existant

_Analyse faite le 11/11/2026 sur le dossier `Bus-booking-Mada` (branche locale, dernier commit `9288722`)._

## 1. Vue d'ensemble

| Élément | Constat |
|---|---|
| Framework | Angular 20, composants standalone, signals, routes lazy-loaded |
| Styles | Tailwind 3.4 + SCSS global (`src/styles/styles.scss`) |
| Volume | ~120 fichiers source, ~22 700 lignes (dont ~9 000 lignes de templates admin) |
| Dépendances | Angular, rxjs, lucide-angular. **Aucun client HTTP**, aucune lib de test configurée |
| Tests | Aucun test (pas de `*.spec.ts`, pas de configuration Karma/Jest) |
| Git | 18 commits. **19 fichiers modifiés non commités** (+1 654 / −1 186 lignes) et `package-lock.json` non suivi |
| Backend | Inexistant. `proxy.conf.json` redirige le navigateur directement vers les API MVola / Orange / Airtel |

> ⚠️ Les 19 fichiers modifiés non commités n'ont pas été touchés. Je recommande de les commiter avant la phase 5 (branchement du frontend), pour garder un point de retour.

## 2. Ce qui est fait

### Site client
| Écran | Route | État |
|---|---|---|
| Recherche + itinéraires populaires | `/` | ✅ Fonctionnel (données locales) |
| Liste des bus, tri prix/durée | `/buses` | ✅ |
| Choix du siège, 3 plans (bus 48, minibus 16, VIP 10) | `/seats` | ✅ Verrou 10 min simulé (localStorage) |
| Passagers | `/passengers` | ✅ |
| Paiement MVola / Orange Money / Airtel Money | `/payment` | ⚠️ Simulation ; contient aussi « carte », « UPI », « net banking » hérités d'un modèle indien |
| Confirmation, billet, QR code | `/confirmation` | ⚠️ QR via `api.qrserver.com`, PDF via `window.print()`, e-mail via `mailto:` |
| Profil + historique | `/profile` | ✅ (localStorage) |
| Connexion / inscription (modale) | — | ⚠️ Mot de passe « haché » en `btoa` côté navigateur |
| Bandeaux et notifications publicitaires | — | ✅ |
| 4 langues fr / en / mg / zh | — | ✅ (~260 clés par langue) |

### Back-office `/admin`
Tableau de bord, réservations, revenus, utilisateurs (clients + comptes internes, fiches détail), flotte, chauffeurs, itinéraires, voyages (récurrence, rangs, détection de conflits horaires), planning, planning chauffeur, sièges, vente au guichet, publicités, rôles et permissions (16 permissions, 5 rôles intégrés + rôles personnalisés), profil, paramètres.

Points solides à conserver : la logique de récurrence et de conflits horaires des voyages (gère le passage de minuit), le modèle de permissions, les 3 plans de sièges, le diff « avant / après » du journal d'audit.

## 3. Ce qui manque ou doit être corrigé

### Bloquant pour une mise en vente
1. **Aucune persistance serveur** : 31 clés `soatrans_*` en localStorage, 73 accès directs à `localStorage`/`sessionStorage`. Chaque navigateur a ses propres données.
2. **Aucune garantie contre la double vente** : deux navigateurs peuvent réserver le même siège. Le verrou n'existe qu'entre onglets d'un même navigateur.
3. **Sécurité** :
   - mots de passe clients et admin encodés en `btoa` (réversible) avec un sel en dur ;
   - 5 comptes de démonstration avec mots de passe en clair dans le code (`Admin@2025`, etc.) ;
   - clés des API de paiement prévues dans le code frontend (`environment.ts`, `mvola.service.ts`…) ;
   - permissions vérifiées uniquement dans le navigateur (contournables) ;
   - la route `/admin/walkin` (vente au guichet) n'exige **aucune permission** : tout compte interne connecté y accède, chauffeur compris.
4. **Paiement** : appels aux opérateurs depuis le navigateur, aucun webhook, aucun rapprochement, aucun remboursement réel. Le montant est calculé côté client.
5. **Données de démonstration mélangées au code** : 150 réservations et 60 clients générés aléatoirement (`admin-data.service.ts`), flotte, chauffeurs, itinéraires et voyages « seed » en dur.
6. **Deux systèmes de réservations parallèles** non synchronisés (`soatrans_bookings` côté profil client et `soatrans_live_bookings` côté admin).
7. **Marque en dur** : 138 occurrences de « Soatrans » dans 44 fichiers (titres, billet, e-mails, URL `soatrans.mg`, préfixe `STR-` des références, nom du projet Angular).

### Fonctionnel incomplet
- Le siège est identifié par `bus + date`, pas par voyage : deux départs du même bus le même jour partagent les mêmes sièges.
- Si aucun voyage n'est programmé, des horaires « de secours » fictifs sont proposés au client.
- Frais de service (2 000 Ar), devise (`Ar`), villes de Madagascar, format de téléphone (+261) en dur.
- Pas d'écran d'administration pour le journal d'audit global ni pour les e-mails (les services existent, pas les pages ni les routes).
- Paramètres : seulement comptes, rôles, « vider le cache ». Rien sur la société, les paiements, les e-mails, la réservation.
- Pas de mot de passe oublié côté client, pas de double authentification, pas de vérification d'e-mail.
- Annulation : simple changement de statut, sans règle de délai ni remboursement.
- Aucune pagination (tout est chargé en mémoire), aucun état de chargement ou d'erreur réseau.
- `index.html` en `lang="en"`, polices chargées depuis Google Fonts (dépendance externe).

### Non vérifié à ce stade
- **Compilation du frontend** : je n'ai pas pu lancer `ng build` sur votre machine (les `node_modules` sont ceux de macOS et l'espace de travail n'a pas d'accès réseau pour les réinstaller). Je le ferai dans mon environnement de build en phase 5 et je noterai le résultat.

## 4. Inventaire des services à remplacer par l'API

| Service frontend actuel | Remplacé par (module backend) |
|---|---|
| `AuthService`, `UserService` | `auth`, `customers`, `bookings` |
| `SeatLockService` | `seats` (verrous en base + temps réel) |
| `SharedDataService` | `search`, `bookings`, `seats` |
| `MVolaService`, `OrangeMoneyService`, `AirtelMoneyService` | `payments` (adaptateurs côté serveur) |
| `TicketService` | `tickets` (PDF + QR côté serveur) |
| `AdminAuthService`, `AdminRolesService` | `auth`, `staff`, `roles` |
| `AdminDataService` | `bookings`, `customers`, `reports` |
| `AdminFleetService`, `AdminDriversService` | `fleet`, `drivers` |
| `AdminRoutesService`, `AdminTripsService` | `routes`, `trips` |
| `AdminAdsService` | `ads` |
| `AdminAuditService` | `audit` |
| `AdminEmailService` | `notifications` |
| `I18nService`, `AdminThemeService` | conservés (préférences locales) + `config` |
