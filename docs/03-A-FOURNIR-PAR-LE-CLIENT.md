# Ce que chaque société cliente doit fournir ou configurer

Cette liste sert de check-list de mise en service. Rien n'est bloquant pour un essai : tout a une valeur par défaut, et les paiements fonctionnent en mode test simulé.

## 1. Avant l'installation

| Élément | Détail | Obligatoire |
|---|---|---|
| Serveur | Linux (Ubuntu 22.04 ou plus récent conseillé), 2 vCPU, 4 Go de RAM, 40 Go de disque, Docker + plugin Compose | Oui |
| Nom de domaine | Ex. `reservation.masociete.mg`, enregistrement DNS **A** vers l'adresse IP du serveur | Oui |
| Ports | 80 et 443 ouverts vers Internet (le certificat HTTPS est obtenu automatiquement) | Oui |
| Lieu de copie des sauvegardes | Un second emplacement hors du serveur (autre serveur, stockage en ligne) où copier le dossier `deploy/backups` | Fortement conseillé |

## 2. Pendant l'assistant de première configuration

| Groupe | À fournir | Obligatoire |
|---|---|---|
| Identité | Nom commercial ; raison sociale, slogan, logo (PNG, JPEG ou WebP, 2 Mo max), favicon, couleurs | Nom seulement |
| Contact | E-mail, téléphones, WhatsApp, adresse, horaires, réseaux sociaux | Non |
| Légal et fiscal | NIF, STAT, RCS ; taux de taxe ; conditions générales, politique d'annulation, confidentialité | Non (à compléter avant l'ouverture au public) |
| Régionalisation | Pays, devise, fuseau horaire, langues | Non (préréglage Madagascar) |
| Administrateur | Prénom, nom, e-mail, mot de passe d'au moins 10 caractères | Oui |

## 3. Paiement mobile (pour encaisser en ligne)

Tant que ces éléments ne sont pas saisis, chaque moyen reste en **mode test** : aucun débit réel.

| Opérateur | Où s'inscrire | À saisir dans Société et réglages → Paiements |
|---|---|---|
| **MVola** (Telma) | Portail développeur MVola : https://developer.mvola.mg | Consumer Key, Consumer Secret, numéro marchand, nom du partenaire |
| **Orange Money** | Orange Developer : https://developer.orange.com (API Orange Money Web Payment, pays Madagascar) | Client ID, Client Secret, Merchant Key |
| **Airtel Money** | Airtel Africa Developers : https://developers.airtel.africa | Client ID, Client Secret |

Pour chacun : obtenir d'abord les clés de **bac à sable**, faire un paiement d'essai en mode « Test », puis demander les clés de **production** et passer le mode sur « Production ».

Adresse de callback à déclarer chez l'opérateur s'il la demande : elle est générée automatiquement pour chaque paiement, sous `https://<votre-domaine>/api/v1/payments/webhooks/...`. Il suffit donc d'autoriser le domaine.

> ⚠️ Les connecteurs MVola, Orange Money et Airtel Money ont été écrits d'après la documentation publique des opérateurs. Ils n'ont pas pu être exécutés contre les opérateurs faute d'identifiants marchands. **Prévoir une demi-journée de validation en bac à sable** avec les identifiants de la société avant la mise en production.

Remboursements : automatiques avec Airtel Money ; pour MVola et Orange Money, le remboursement apparaît dans **Remboursements → À faire à la main** et le comptable le marque comme effectué après le transfert.

## 4. E-mails (pour envoyer les billets)

| Élément | Détail |
|---|---|
| Compte SMTP | Hôte, port (587 ou 465), identifiant, mot de passe. Tout fournisseur convient (Brevo, Mailgun, Google Workspace, serveur de l'hébergeur…) |
| Adresse d'expédition | Ex. `billets@masociete.mg` |
| DNS | Enregistrements SPF et DKIM fournis par le fournisseur d'e-mail, pour éviter le classement en indésirable |

Sans SMTP, l'application fonctionne : les messages sont enregistrés avec l'état « simulé » dans **E-mails et SMS** et le voyageur récupère son billet à l'écran ou par « Retrouver mon billet ».

## 5. SMS (optionnel)

Un fournisseur disposant d'une API HTTP : adresse d'envoi, jeton d'accès, nom d'expéditeur. À saisir dans Société et réglages → Notifications.

## 6. Données d'exploitation à saisir dans le back-office

1. **Itinéraires** : villes de départ et d'arrivée, distance, durée, prix par type de véhicule.
2. **Flotte** : véhicules (nom, immatriculation, plan de sièges : bus 48, minibus 16 ou minibus VIP 10).
3. **Chauffeurs** : identité, permis, date d'expiration.
4. **Voyages** : horaires et récurrence (quotidien, jours de semaine, dates précises).
5. **Comptes du personnel** : un compte par personne, avec le rôle adapté.

## 7. À conserver en lieu sûr

| Élément | Pourquoi |
|---|---|
| Fichier `deploy/.env` | Contient tous les secrets de l'installation |
| `APP_ENCRYPTION_KEY` | Sans elle, les clés de paiement et le mot de passe SMTP enregistrés sont illisibles après une restauration |
| Codes de secours de la double authentification de l'administrateur | Seul moyen de se connecter en cas de perte du téléphone |
| `BACKUP_PASSPHRASE` (si utilisée) | Nécessaire pour restaurer une sauvegarde chiffrée |
