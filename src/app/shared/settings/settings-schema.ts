/**
 * Description des champs de configuration de la société.
 * La même description sert à l'assistant de première configuration et à l'écran « Société et réglages » :
 * tout ce qui est saisi dans l'assistant reste modifiable ensuite, avec les mêmes libellés et les mêmes aides.
 * Les règles de validation qui font foi sont celles du serveur.
 */
export type SettingGroup = 'identity' | 'contact' | 'legal' | 'locale' | 'booking' | 'ticket' | 'notifications' | 'security';
export type FieldType = 'text' | 'textarea' | 'number' | 'money' | 'color' | 'select' | 'toggle' | 'email' | 'tel' | 'url' | 'list' | 'pairs' | 'upload' | 'langs' | 'roles' | 'heading' | 'timezone';
export interface Field {
  key: string;                 // chemin dans le groupe, ex. « cancellation.deadlineHours »
  label: string;
  type: FieldType;
  placeholder?: string;        // exemple affiché dans le champ vide
  help?: string;               // aide sous le champ
  options?: { value: string | number; label: string }[];
  min?: number; max?: number; step?: number; unit?: string; rows?: number; maxLength?: number;
  required?: boolean;
  half?: boolean;              // occupe une demi-largeur sur grand écran
  uploadKind?: string;
  showIf?: (m: any) => boolean;
  optionalColor?: boolean;     // couleur facultative (vide = couleur principale)
}
const h = (label: string, help?: string): Field => ({ key: '', label, type: 'heading', help });

export const GROUP_META: Record<SettingGroup, { title: string; intro: string }> = {
  identity:      { title: 'Identité', intro: 'Le nom, le logo et les couleurs apparaissent sur le site, les billets et les e-mails.' },
  contact:       { title: 'Contact', intro: 'Coordonnées affichées aux voyageurs sur le site, les billets et les e-mails.' },
  legal:         { title: 'Légal et fiscal', intro: 'Numéros d\'immatriculation, taxes et textes légaux.' },
  locale:        { title: 'Régionalisation', intro: 'Pays, devise, fuseau horaire, formats et langues.' },
  booking:       { title: 'Réservation', intro: 'Règles de vente : durée du verrou de siège, annulation, frais, enfants et bagages.' },
  ticket:        { title: 'Billet', intro: 'Présentation du billet PDF et consignes imprimées.' },
  notifications: { title: 'Notifications', intro: 'Envoi des billets et des alertes par e-mail et, en option, par SMS.' },
  security:      { title: 'Sécurité', intro: 'Durée des sessions, blocage après échecs de connexion et double authentification.' },
};

export const FIELDS: Record<SettingGroup, Field[]> = {
  identity: [
    { key: 'name', label: 'Nom commercial', type: 'text', required: true, placeholder: 'Ex. Trans Océan', maxLength: 80, help: 'Le nom que voient vos voyageurs. C\'est la seule information obligatoire de cette étape.' },
    { key: 'legalName', label: 'Raison sociale', type: 'text', placeholder: 'Ex. Trans Océan SARL', maxLength: 120, half: true, help: 'Nom légal, imprimé dans les mentions du billet.' },
    { key: 'slogan', label: 'Slogan', type: 'text', placeholder: 'Ex. Voyagez sereinement', maxLength: 160, half: true },
    { key: 'description', label: 'Description', type: 'textarea', rows: 3, maxLength: 1000, placeholder: 'Quelques lignes sur votre société : lignes desservies, année de création, engagements…', help: 'Utilisée par les moteurs de recherche et en bas de page.' },
    { key: 'logoUrl', label: 'Logo (fond clair)', type: 'upload', uploadKind: 'logo', half: true, help: 'PNG, JPEG ou WebP, 2 Mo maximum. Sans logo, les initiales de la société sont affichées.' },
    { key: 'logoDarkUrl', label: 'Logo (fond sombre)', type: 'upload', uploadKind: 'logo_dark', half: true, help: 'Facultatif : version claire du logo pour le back-office en mode sombre.' },
    { key: 'faviconUrl', label: 'Favicon', type: 'upload', uploadKind: 'favicon', half: true, help: 'Petite icône de l\'onglet du navigateur (carrée, 64 × 64 px conseillé).' },
    { key: 'referencePrefix', label: 'Préfixe des références', type: 'text', placeholder: 'Ex. TRO', maxLength: 5, half: true, help: '0 à 5 lettres ou chiffres placés devant chaque référence de billet (ex. TRO-7F3K2A). Vide : aucun préfixe.' },
    { key: 'primaryColor', label: 'Couleur principale', type: 'color', half: true, help: 'Boutons, liens et en-tête du billet. L\'aperçu se met à jour immédiatement.' },
    { key: 'accentColor', label: 'Couleur d\'accent', type: 'color', half: true, help: 'Mises en avant et promotions.' },
  ],
  contact: [
    { key: 'email', label: 'E-mail professionnel', type: 'email', placeholder: 'contact@votre-societe.com', half: true },
    { key: 'ticketsEmail', label: 'E-mail d\'envoi des billets', type: 'email', placeholder: 'billets@votre-societe.com', half: true, help: 'Adresse qui apparaît comme expéditeur des billets. Vide : l\'e-mail professionnel.' },
    { key: 'phones', label: 'Téléphone(s)', type: 'list', placeholder: '+261 34 12 345 67', max: 5, help: 'Jusqu\'à 5 numéros.' },
    { key: 'whatsapp', label: 'WhatsApp', type: 'tel', placeholder: '+261 34 12 345 67', half: true },
    { key: 'website', label: 'Site web', type: 'url', placeholder: 'https://www.votre-societe.com', half: true },
    { key: 'address', label: 'Adresse', type: 'text', placeholder: 'Lot II B 12, Gare routière', maxLength: 300 },
    { key: 'city', label: 'Ville', type: 'text', placeholder: 'Antananarivo', half: true },
    { key: 'country', label: 'Pays', type: 'text', placeholder: 'Madagascar', half: true },
    { key: 'openingHours', label: 'Horaires d\'ouverture', type: 'text', placeholder: 'Lundi au samedi, 5 h à 19 h · Dimanche, 6 h à 12 h', maxLength: 300 },
    h('Réseaux sociaux', 'Adresses complètes (https://…). Laissez vide ceux que vous n\'utilisez pas.'),
    { key: 'social.facebook', label: 'Facebook', type: 'url', placeholder: 'https://facebook.com/votre-page', half: true },
    { key: 'social.instagram', label: 'Instagram', type: 'url', placeholder: 'https://instagram.com/votre-compte', half: true },
    { key: 'social.tiktok', label: 'TikTok', type: 'url', placeholder: 'https://tiktok.com/@votre-compte', half: true },
    { key: 'social.x', label: 'X (Twitter)', type: 'url', placeholder: 'https://x.com/votre-compte', half: true },
    { key: 'social.linkedin', label: 'LinkedIn', type: 'url', placeholder: 'https://linkedin.com/company/votre-societe', half: true },
    { key: 'social.youtube', label: 'YouTube', type: 'url', placeholder: 'https://youtube.com/@votre-chaine', half: true },
  ],
  legal: [
    { key: 'registrationNumbers', label: 'Numéros d\'immatriculation', type: 'pairs', max: 8, help: 'Ex. NIF, STAT, RCS, ICE, SIRET… Le libellé et le numéro sont imprimés sur le billet.' },
    h('Taxes'),
    { key: 'taxEnabled', label: 'Appliquer une taxe (TVA ou équivalent)', type: 'toggle' },
    { key: 'taxName', label: 'Nom de la taxe', type: 'text', placeholder: 'TVA', maxLength: 30, half: true, showIf: m => m.taxEnabled },
    { key: 'taxRatePercent', label: 'Taux', type: 'number', min: 0, max: 100, step: 0.1, unit: '%', half: true, showIf: m => m.taxEnabled },
    { key: 'taxIncluded', label: 'Les prix affichés incluent déjà la taxe', type: 'toggle', showIf: m => m.taxEnabled, help: 'Décoché : la taxe est ajoutée au total au moment du paiement.' },
    h('Textes légaux', 'Affichés sur le site (pied de page) et résumés sur le billet.'),
    { key: 'termsText', label: 'Conditions générales de vente', type: 'textarea', rows: 6, maxLength: 20000, placeholder: 'Collez ici vos conditions générales. Vous pourrez les compléter plus tard.' },
    { key: 'cancellationPolicyText', label: 'Politique d\'annulation et de remboursement', type: 'textarea', rows: 4, maxLength: 5000, placeholder: 'Ex. Annulation gratuite jusqu\'à 2 heures avant le départ. Passé ce délai, le billet n\'est pas remboursable.' },
    { key: 'privacyText', label: 'Politique de confidentialité', type: 'textarea', rows: 5, maxLength: 20000, placeholder: 'Quelles données vous collectez, pourquoi, combien de temps, et comment exercer ses droits.' },
    { key: 'ticketLegalNotice', label: 'Mention légale sur le billet', type: 'textarea', rows: 2, maxLength: 600, placeholder: 'Ex. Billet nominatif, non cessible. Pièce d\'identité obligatoire à l\'embarquement.' },
    { key: 'dataRetentionMonths', label: 'Conservation des données personnelles', type: 'number', min: 1, max: 240, unit: 'mois', half: true, help: 'Après ce délai sans activité, les données des voyageurs sont anonymisées automatiquement.' },
  ],
  locale: [
    { key: 'country', label: 'Pays', type: 'text', placeholder: 'Madagascar', half: true },
    { key: 'timezone', label: 'Fuseau horaire', type: 'timezone', placeholder: 'Indian/Antananarivo', half: true, help: 'Toutes les heures de départ sont exprimées dans ce fuseau.' },
    h('Devise'),
    { key: 'currencyCode', label: 'Code de la devise', type: 'text', placeholder: 'MGA', maxLength: 3, half: true, help: 'Code international à 3 lettres (MGA, MAD, XOF, EUR, USD…).' },
    { key: 'currencySymbol', label: 'Symbole', type: 'text', placeholder: 'Ar', maxLength: 6, half: true },
    { key: 'currencyPosition', label: 'Position du symbole', type: 'select', half: true, options: [{ value: 'after', label: 'Après le montant (15 000 Ar)' }, { value: 'before', label: 'Avant le montant (€ 15,00)' }] },
    { key: 'currencyDecimals', label: 'Décimales', type: 'select', half: true, options: [{ value: 0, label: 'Aucune (15 000)' }, { value: 2, label: 'Deux (15,00)' }, { value: 3, label: 'Trois (15,000)' }] },
    { key: 'thousandsSeparator', label: 'Séparateur de milliers', type: 'select', half: true, options: [{ value: ' ', label: 'Espace (15 000)' }, { value: ',', label: 'Virgule (15,000)' }, { value: '.', label: 'Point (15.000)' }, { value: '', label: 'Aucun (15000)' }] },
    { key: 'phonePrefix', label: 'Indicatif téléphonique', type: 'text', placeholder: '+261', maxLength: 5, half: true, help: 'Ajouté aux numéros saisis sans indicatif.' },
    h('Dates et heures'),
    { key: 'dateFormat', label: 'Format de date', type: 'select', half: true, options: [{ value: 'dd/MM/yyyy', label: '31/12/2026' }, { value: 'MM/dd/yyyy', label: '12/31/2026' }, { value: 'yyyy-MM-dd', label: '2026-12-31' }, { value: 'd MMM yyyy', label: '31 déc. 2026' }] },
    { key: 'timeFormat', label: 'Format d\'heure', type: 'select', half: true, options: [{ value: 'HH:mm', label: '24 heures (14:30)' }, { value: 'h:mm a', label: '12 heures (2:30 PM)' }] },
    h('Langues', 'Les voyageurs choisissent leur langue en haut du site.'),
    { key: 'enabledLangs', label: 'Langues proposées', type: 'langs', help: 'Une langue ajoutée reprend les textes d\'une langue de base ; vous les traduisez ensuite dans « Textes et langues ».' },
  ],
  booking: [
    h('Sélection et paiement'),
    { key: 'seatHoldMinutes', label: 'Durée du verrou de siège', type: 'number', min: 2, max: 60, unit: 'min', half: true, help: 'Temps pendant lequel un siège choisi reste réservé au voyageur avant le paiement.' },
    { key: 'holdMaxExtensions', label: 'Prolongations autorisées', type: 'number', min: 0, max: 3, half: true, help: 'Nombre de fois où le voyageur peut prolonger son verrou.' },
    { key: 'paymentTimeoutMinutes', label: 'Délai pour valider le paiement', type: 'number', min: 2, max: 30, unit: 'min', half: true, help: 'Temps laissé pour confirmer le paiement mobile sur le téléphone.' },
    { key: 'maxPassengers', label: 'Passagers maximum par réservation', type: 'number', min: 1, max: 20, half: true },
    { key: 'allowGuestCheckout', label: 'Autoriser la réservation sans compte', type: 'toggle', help: 'Le voyageur indique seulement son nom, son téléphone et, s\'il le souhaite, son e-mail.' },
    h('Frais et ouverture des ventes'),
    { key: 'serviceFee', label: 'Frais de service', type: 'money', min: 0, half: true, placeholder: '0', help: '0 : aucun frais.' },
    { key: 'serviceFeeMode', label: 'Les frais s\'appliquent', type: 'select', half: true, options: [{ value: 'per_booking', label: 'Une fois par réservation' }, { value: 'per_seat', label: 'Pour chaque siège' }] },
    { key: 'salesCloseMinutes', label: 'Fermeture de la vente en ligne', type: 'number', min: 0, max: 1440, unit: 'min avant le départ', half: true, help: 'Le guichet peut vendre jusqu\'au départ.' },
    { key: 'salesHorizonDays', label: 'Ouverture des ventes', type: 'number', min: 1, max: 365, unit: 'jours à l\'avance', half: true },
    h('Annulation et modification'),
    { key: 'cancellation.enabled', label: 'Le voyageur peut annuler en ligne', type: 'toggle' },
    { key: 'cancellation.deadlineHours', label: 'Délai limite d\'annulation', type: 'number', min: 0, max: 720, unit: 'h avant le départ', half: true, showIf: m => m.cancellation?.enabled },
    { key: 'cancellation.refundPercent', label: 'Part du billet remboursée', type: 'number', min: 0, max: 100, unit: '%', half: true, showIf: m => m.cancellation?.enabled },
    { key: 'cancellation.refundServiceFee', label: 'Rembourser aussi les frais de service', type: 'toggle', showIf: m => m.cancellation?.enabled },
    { key: 'change.enabled', label: 'Le voyageur peut changer de siège ou de départ', type: 'toggle' },
    { key: 'change.deadlineHours', label: 'Délai limite de modification', type: 'number', min: 0, max: 720, unit: 'h avant le départ', half: true, showIf: m => m.change?.enabled },
    h('Absence à l\'embarquement'),
    { key: 'noShow.auto', label: 'Marquer automatiquement « absent » les passagers non embarqués', type: 'toggle', help: 'Appliqué après le départ pour les billets non scannés.' },
    { key: 'noShow.refundPercent', label: 'Remboursement en cas d\'absence', type: 'number', min: 0, max: 100, unit: '%', half: true },
    h('Enfants et bagages'),
    { key: 'child.enabled', label: 'Proposer un tarif enfant', type: 'toggle' },
    { key: 'child.maxAge', label: 'Âge maximum', type: 'number', min: 1, max: 17, unit: 'ans', half: true, showIf: m => m.child?.enabled },
    { key: 'child.discountPercent', label: 'Réduction enfant', type: 'number', min: 0, max: 100, unit: '%', half: true, showIf: m => m.child?.enabled },
    { key: 'baggage.includedKg', label: 'Bagage inclus', type: 'number', min: 0, max: 200, unit: 'kg par passager', half: true },
    { key: 'baggage.note', label: 'Précision sur les bagages', type: 'text', maxLength: 300, placeholder: 'Ex. Bagage supplémentaire payant au guichet.' },
    h('Rappel'),
    { key: 'reminderHoursBefore', label: 'Rappel avant le départ', type: 'number', min: 0, max: 72, unit: 'h avant', half: true, help: '0 : aucun rappel.' },
  ],
  ticket: [
    { key: 'showLogo', label: 'Afficher le logo sur le billet', type: 'toggle' },
    { key: 'headerColor', label: 'Couleur de l\'en-tête', type: 'color', optionalColor: true, half: true, help: 'Vide : la couleur principale de la société.' },
    { key: 'boardingMinutesBefore', label: 'Présentation à l\'embarquement', type: 'number', min: 0, max: 180, unit: 'min avant le départ', half: true },
    { key: 'instructions', label: 'Consignes imprimées sur le billet', type: 'list', max: 8, placeholder: 'Ex. Arrivez au moins 15 minutes avant le départ.' },
    { key: 'footerText', label: 'Pied de page du billet', type: 'text', maxLength: 300, placeholder: 'Ex. Merci de votre confiance. Bon voyage !' },
    { key: 'qrFormat', label: 'Contenu du QR code', type: 'select', options: [{ value: 'signed', label: 'Code signé, infalsifiable (recommandé)' }, { value: 'reference', label: 'Numéro du billet seul' }], help: 'Le code signé ne peut être fabriqué que par votre serveur. Le contrôle vérifie de toute façon chaque billet en ligne.' },
  ],
  notifications: [
    h('E-mail', 'Renseignez le serveur d\'envoi de votre fournisseur (hébergeur, Brevo, Mailgun, Amazon SES, Gmail professionnel…).'),
    { key: 'email.enabled', label: 'Activer l\'envoi d\'e-mails', type: 'toggle', help: 'Désactivé : les e-mails sont enregistrés dans le journal (« simulé ») mais pas envoyés.' },
    { key: 'email.host', label: 'Serveur SMTP', type: 'text', placeholder: 'smtp.votre-fournisseur.com', half: true, showIf: m => m.email?.enabled },
    { key: 'email.port', label: 'Port', type: 'number', min: 1, max: 65535, placeholder: '587', half: true, showIf: m => m.email?.enabled, help: '587 (STARTTLS) ou 465 (SSL).' },
    { key: 'email.secure', label: 'Connexion SSL directe (port 465)', type: 'toggle', showIf: m => m.email?.enabled },
    { key: 'email.user', label: 'Identifiant', type: 'text', placeholder: 'billets@votre-societe.com', half: true, showIf: m => m.email?.enabled },
    { key: 'email.fromName', label: 'Nom de l\'expéditeur', type: 'text', placeholder: 'Nom de votre société', half: true, showIf: m => m.email?.enabled },
    { key: 'email.fromEmail', label: 'Adresse de l\'expéditeur', type: 'email', placeholder: 'billets@votre-societe.com', half: true, showIf: m => m.email?.enabled },
    { key: 'email.replyTo', label: 'Adresse de réponse', type: 'email', placeholder: 'contact@votre-societe.com', half: true, showIf: m => m.email?.enabled },
    h('SMS (facultatif)', 'Branchez la passerelle SMS de votre choix par une simple requête HTTP.'),
    { key: 'sms.enabled', label: 'Activer l\'envoi de SMS', type: 'toggle' },
    { key: 'sms.provider', label: 'Fournisseur', type: 'select', half: true, showIf: m => m.sms?.enabled, options: [{ value: 'none', label: 'Aucun (SMS simulés dans le journal)' }, { value: 'http', label: 'Passerelle HTTP' }] },
    { key: 'sms.senderId', label: 'Nom de l\'expéditeur', type: 'text', maxLength: 20, placeholder: 'Ex. TRANSOCEAN', half: true, showIf: m => m.sms?.enabled },
    { key: 'sms.httpUrl', label: 'Adresse de la passerelle', type: 'url', placeholder: 'https://api.votre-passerelle.com/sms/send', showIf: m => m.sms?.enabled && m.sms?.provider === 'http' },
    { key: 'sms.httpMethod', label: 'Méthode', type: 'select', half: true, options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }], showIf: m => m.sms?.enabled && m.sms?.provider === 'http' },
    { key: 'sms.authHeader', label: 'En-tête d\'authentification', type: 'text', placeholder: 'Authorization', half: true, showIf: m => m.sms?.enabled && m.sms?.provider === 'http', help: 'La clé API est envoyée dans cet en-tête.' },
    { key: 'sms.httpBodyTemplate', label: 'Corps de la requête', type: 'textarea', rows: 3, showIf: m => m.sms?.enabled && m.sms?.provider === 'http', help: 'Variables : {{to}}, {{message}}, {{sender}}.' },
    h('Ce qui est envoyé'),
    { key: 'sendTicketByEmail', label: 'Envoyer le billet par e-mail après le paiement', type: 'toggle' },
    { key: 'sendTicketBySms', label: 'Envoyer la référence du billet par SMS', type: 'toggle' },
    { key: 'adminAlertEmail', label: 'E-mail des alertes internes', type: 'email', placeholder: 'exploitation@votre-societe.com', help: 'Reçoit les alertes : remboursement à faire à la main, voyage annulé, passager à replacer.' },
  ],
  security: [
    { key: 'require2faRoles', label: 'Double authentification obligatoire pour', type: 'roles', help: 'Les comptes de ces rôles doivent activer la double authentification à leur prochaine connexion.' },
    { key: 'staffSessionHours', label: 'Durée de session du personnel', type: 'number', min: 1, max: 720, unit: 'heures', half: true },
    { key: 'customerSessionDays', label: 'Durée de session des voyageurs', type: 'number', min: 1, max: 365, unit: 'jours', half: true },
    { key: 'maxLoginAttempts', label: 'Échecs de connexion avant blocage', type: 'number', min: 3, max: 50, half: true },
    { key: 'lockoutMinutes', label: 'Durée du blocage', type: 'number', min: 1, max: 1440, unit: 'min', half: true },
  ],
};

/** Préréglages par pays : remplissent la devise, le fuseau et l'indicatif en un clic (tout reste modifiable). */
export const COUNTRY_PRESETS: { country: string; currencyCode: string; currencySymbol: string; currencyPosition: 'before' | 'after'; currencyDecimals: number; thousandsSeparator: string; timezone: string; phonePrefix: string }[] = [
  { country: 'Madagascar', currencyCode: 'MGA', currencySymbol: 'Ar', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ', timezone: 'Indian/Antananarivo', phonePrefix: '+261' },
  { country: 'Maroc', currencyCode: 'MAD', currencySymbol: 'DH', currencyPosition: 'after', currencyDecimals: 2, thousandsSeparator: ' ', timezone: 'Africa/Casablanca', phonePrefix: '+212' },
  { country: 'Sénégal', currencyCode: 'XOF', currencySymbol: 'FCFA', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ', timezone: 'Africa/Dakar', phonePrefix: '+221' },
  { country: 'Côte d\'Ivoire', currencyCode: 'XOF', currencySymbol: 'FCFA', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ', timezone: 'Africa/Abidjan', phonePrefix: '+225' },
  { country: 'Cameroun', currencyCode: 'XAF', currencySymbol: 'FCFA', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ', timezone: 'Africa/Douala', phonePrefix: '+237' },
  { country: 'Kenya', currencyCode: 'KES', currencySymbol: 'KSh', currencyPosition: 'before', currencyDecimals: 0, thousandsSeparator: ',', timezone: 'Africa/Nairobi', phonePrefix: '+254' },
  { country: 'Maurice', currencyCode: 'MUR', currencySymbol: 'Rs', currencyPosition: 'before', currencyDecimals: 0, thousandsSeparator: ',', timezone: 'Indian/Mauritius', phonePrefix: '+230' },
  { country: 'Comores', currencyCode: 'KMF', currencySymbol: 'FC', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ', timezone: 'Indian/Comoro', phonePrefix: '+269' },
  { country: 'Tunisie', currencyCode: 'TND', currencySymbol: 'DT', currencyPosition: 'after', currencyDecimals: 3, thousandsSeparator: ' ', timezone: 'Africa/Tunis', phonePrefix: '+216' },
  { country: 'France', currencyCode: 'EUR', currencySymbol: '€', currencyPosition: 'after', currencyDecimals: 2, thousandsSeparator: ' ', timezone: 'Europe/Paris', phonePrefix: '+33' },
  { country: 'États-Unis', currencyCode: 'USD', currencySymbol: '$', currencyPosition: 'before', currencyDecimals: 2, thousandsSeparator: ',', timezone: 'America/New_York', phonePrefix: '+1' },
];

export function getPath(obj: any, path: string): any { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
export function setPath(obj: any, path: string, value: any): void {
  const keys = path.split('.'); let o = obj;
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}
