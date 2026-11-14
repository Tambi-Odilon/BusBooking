/**
 * Modèles par défaut. Chaque société peut les remplacer depuis Paramètres → Notifications (table email_templates).
 * Variables : {{company_name}} {{company_phone}} {{company_email}} {{company_website}} {{customer_name}} {{first_name}}
 * {{ticket_number}} {{reference}} {{from}} {{to}} {{date}} {{departure_time}} {{seats}} {{total}} {{vehicle}} {{booking_url}}
 * {{refund_amount}} {{refund_reason}} {{cancel_reason}} {{cancelled_seats}} {{changes}} {{old_seats}} {{reset_url}} …
 */
export interface Template { subject: string; body: string; sms?: string }
export const TEMPLATE_CODES = ['booking_confirmed', 'booking_cancelled', 'booking_changed', 'trip_cancelled', 'seat_changed', 'payment_refund', 'trip_reminder', 'password_reset', 'staff_welcome', 'test'] as const;
export const TEMPLATE_VARIABLES: Record<string, string[]> = {
  booking_confirmed: ['customer_name', 'ticket_number', 'from', 'to', 'date', 'departure_time', 'seats', 'total', 'vehicle', 'booking_url'],
  booking_cancelled: ['customer_name', 'ticket_number', 'from', 'to', 'date', 'cancelled_seats', 'refund_amount', 'booking_url'],
  booking_changed: ['customer_name', 'ticket_number', 'from', 'to', 'date', 'departure_time', 'old_seats', 'seats', 'booking_url'],
  trip_cancelled: ['customer_name', 'ticket_number', 'from', 'to', 'date', 'departure_time', 'cancel_reason', 'refund_amount'],
  seat_changed: ['customer_name', 'ticket_number', 'from', 'to', 'date', 'departure_time', 'vehicle', 'changes', 'unseated', 'booking_url'],
  payment_refund: ['customer_name', 'ticket_number', 'refund_amount', 'refund_reason'],
  trip_reminder: ['customer_name', 'ticket_number', 'from', 'to', 'date', 'departure_time', 'seats', 'booking_url'],
  password_reset: ['first_name', 'reset_url', 'expires_minutes'],
  staff_welcome: ['first_name', 'email', 'role_name', 'login_url', 'set_password_url'],
  test: [],
};
const common = ['company_name', 'company_phone', 'company_email', 'company_website'];
for (const k of Object.keys(TEMPLATE_VARIABLES)) TEMPLATE_VARIABLES[k] = [...common, ...TEMPLATE_VARIABLES[k]];

const recap = (l: { trip: string; date: string; dep: string; seats: string }) =>
  `<table class="recap"><tr><td>${l.trip}</td><td><b>{{from}} → {{to}}</b></td></tr><tr><td>${l.date}</td><td><b>{{date}}</b></td></tr><tr><td>${l.dep}</td><td><b>{{departure_time}}</b></td></tr><tr><td>${l.seats}</td><td><b>{{seats}}</b></td></tr></table>`;
const FR = { trip: 'Trajet', date: 'Date', dep: 'Départ', seats: 'Siège(s)' }, EN = { trip: 'Route', date: 'Date', dep: 'Departure', seats: 'Seat(s)' }, MG = { trip: 'Lalana', date: 'Daty', dep: 'Fiaingana', seats: 'Seza' };

export const DEFAULT_TEMPLATES: Record<string, Record<string, Template>> = {
  booking_confirmed: {
    fr: { subject: 'Votre billet {{company_name}} — {{ticket_number}}',
      body: `<p>Bonjour {{customer_name}},</p><p>Votre réservation est <b>confirmée</b>. Votre billet est en pièce jointe.</p>${recap(FR)}<p>Total payé : <b>{{total}}</b></p><p><a class="btn" href="{{booking_url}}">Voir mon billet</a></p><p>Bon voyage !</p>`,
      sms: '{{company_name}} : billet {{ticket_number}} confirmé. {{from}}-{{to}} le {{date}} à {{departure_time}}, siège(s) {{seats}}.' },
    en: { subject: 'Your {{company_name}} ticket — {{ticket_number}}',
      body: `<p>Hello {{customer_name}},</p><p>Your booking is <b>confirmed</b>. Your ticket is attached.</p>${recap(EN)}<p>Total paid: <b>{{total}}</b></p><p><a class="btn" href="{{booking_url}}">View my ticket</a></p><p>Have a good trip!</p>`,
      sms: '{{company_name}}: ticket {{ticket_number}} confirmed. {{from}}-{{to}} on {{date}} at {{departure_time}}, seat(s) {{seats}}.' },
    mg: { subject: 'Ny tapakilanao {{company_name}} — {{ticket_number}}',
      body: `<p>Miarahaba {{customer_name}},</p><p><b>Voamarina</b> ny famandrihanao. Miaraka amin'ity hafatra ity ny tapakilanao.</p>${recap(MG)}<p>Totaly voaloa : <b>{{total}}</b></p><p><a class="btn" href="{{booking_url}}">Hijery ny tapakilako</a></p><p>Soava dia !</p>`,
      sms: '{{company_name}} : tapakila {{ticket_number}} voamarina. {{from}}-{{to}} ny {{date}} amin\'ny {{departure_time}}, seza {{seats}}.' },
  },
  booking_cancelled: {
    fr: { subject: 'Annulation de votre réservation {{ticket_number}}', body: `<p>Bonjour {{customer_name}},</p><p>Votre réservation <b>{{ticket_number}}</b> ({{from}} → {{to}}, {{date}}) a été annulée pour le(s) siège(s) <b>{{cancelled_seats}}</b>.</p><p>Montant remboursé : <b>{{refund_amount}}</b>. Le remboursement est traité sous quelques jours ouvrés.</p>`,
      sms: '{{company_name}} : réservation {{ticket_number}} annulée (sièges {{cancelled_seats}}). Remboursement : {{refund_amount}}.' },
    en: { subject: 'Your booking {{ticket_number}} has been cancelled', body: `<p>Hello {{customer_name}},</p><p>Your booking <b>{{ticket_number}}</b> ({{from}} → {{to}}, {{date}}) was cancelled for seat(s) <b>{{cancelled_seats}}</b>.</p><p>Refund amount: <b>{{refund_amount}}</b>. Refunds are processed within a few business days.</p>`,
      sms: '{{company_name}}: booking {{ticket_number}} cancelled (seats {{cancelled_seats}}). Refund: {{refund_amount}}.' },
  },
  booking_changed: {
    fr: { subject: 'Votre réservation {{ticket_number}} a été modifiée', body: `<p>Bonjour {{customer_name}},</p><p>Votre réservation a été modifiée. Ancien(s) siège(s) : {{old_seats}}.</p>${recap(FR)}<p>Votre nouveau billet est en pièce jointe.</p><p><a class="btn" href="{{booking_url}}">Voir mon billet</a></p>`,
      sms: '{{company_name}} : réservation {{ticket_number}} modifiée. {{from}}-{{to}} le {{date}} à {{departure_time}}, siège(s) {{seats}}.' },
    en: { subject: 'Your booking {{ticket_number}} was changed', body: `<p>Hello {{customer_name}},</p><p>Your booking was changed. Previous seat(s): {{old_seats}}.</p>${recap(EN)}<p>Your new ticket is attached.</p><p><a class="btn" href="{{booking_url}}">View my ticket</a></p>`,
      sms: '{{company_name}}: booking {{ticket_number}} changed. {{from}}-{{to}} on {{date}} at {{departure_time}}, seat(s) {{seats}}.' },
  },
  trip_cancelled: {
    fr: { subject: 'Voyage annulé — {{from}} → {{to}} du {{date}}', body: `<p>Bonjour {{customer_name}},</p><p>Nous sommes désolés : le voyage <b>{{from}} → {{to}}</b> du <b>{{date}}</b> à <b>{{departure_time}}</b> est annulé.</p><p>Motif : {{cancel_reason}}</p><p>Votre réservation {{ticket_number}} est intégralement remboursée (<b>{{refund_amount}}</b>). Contactez-nous au {{company_phone}} pour choisir un autre départ.</p>`,
      sms: '{{company_name}} : le voyage {{from}}-{{to}} du {{date}} {{departure_time}} est ANNULE. Billet {{ticket_number}} remboursé ({{refund_amount}}). Info : {{company_phone}}' },
    en: { subject: 'Trip cancelled — {{from}} → {{to}} on {{date}}', body: `<p>Hello {{customer_name}},</p><p>We are sorry: the trip <b>{{from}} → {{to}}</b> on <b>{{date}}</b> at <b>{{departure_time}}</b> has been cancelled.</p><p>Reason: {{cancel_reason}}</p><p>Your booking {{ticket_number}} is fully refunded (<b>{{refund_amount}}</b>). Call us on {{company_phone}} to choose another departure.</p>`,
      sms: '{{company_name}}: trip {{from}}-{{to}} on {{date}} {{departure_time}} is CANCELLED. Ticket {{ticket_number}} refunded ({{refund_amount}}). Info: {{company_phone}}' },
  },
  seat_changed: {
    fr: { subject: 'Changement de véhicule — votre siège a changé ({{ticket_number}})', body: `<p>Bonjour {{customer_name}},</p><p>Le véhicule de votre voyage <b>{{from}} → {{to}}</b> du <b>{{date}}</b> à {{departure_time}} a été remplacé par <b>{{vehicle}}</b>.</p><p>Nouveau(x) siège(s) : <b>{{changes}}</b></p><p>{{unseated}}</p><p><a class="btn" href="{{booking_url}}">Voir mon billet</a></p>`,
      sms: '{{company_name}} : changement de véhicule pour {{from}}-{{to}} du {{date}}. Nouveau siège : {{changes}}. Billet {{ticket_number}}.' },
    en: { subject: 'Vehicle change — your seat has changed ({{ticket_number}})', body: `<p>Hello {{customer_name}},</p><p>The vehicle for your trip <b>{{from}} → {{to}}</b> on <b>{{date}}</b> at {{departure_time}} was replaced by <b>{{vehicle}}</b>.</p><p>New seat(s): <b>{{changes}}</b></p><p>{{unseated}}</p><p><a class="btn" href="{{booking_url}}">View my ticket</a></p>`,
      sms: '{{company_name}}: vehicle change for {{from}}-{{to}} on {{date}}. New seat: {{changes}}. Ticket {{ticket_number}}.' },
  },
  payment_refund: {
    fr: { subject: 'Remboursement de votre paiement — {{ticket_number}}', body: `<p>Bonjour {{customer_name}},</p><p>Votre paiement pour la réservation <b>{{ticket_number}}</b> n'a pas pu être utilisé ({{refund_reason}}).</p><p>Vous êtes remboursé de <b>{{refund_amount}}</b>. Aucune place n'a été vendue en double. Vous pouvez refaire une réservation à tout moment.</p>`,
      sms: '{{company_name}} : paiement du billet {{ticket_number}} non utilisé ({{refund_reason}}). Remboursement de {{refund_amount}} en cours.' },
    en: { subject: 'Refund of your payment — {{ticket_number}}', body: `<p>Hello {{customer_name}},</p><p>Your payment for booking <b>{{ticket_number}}</b> could not be used ({{refund_reason}}).</p><p>You are being refunded <b>{{refund_amount}}</b>. You can book again at any time.</p>`,
      sms: '{{company_name}}: payment for {{ticket_number}} not used ({{refund_reason}}). Refund of {{refund_amount}} in progress.' },
  },
  trip_reminder: {
    fr: { subject: 'Rappel : votre départ {{from}} → {{to}} à {{departure_time}}', body: `<p>Bonjour {{customer_name}},</p><p>Votre voyage approche.</p>${recap(FR)}<p>Merci d'arriver en avance avec votre billet {{ticket_number}}.</p><p><a class="btn" href="{{booking_url}}">Voir mon billet</a></p>`,
      sms: '{{company_name}} : rappel, départ {{from}}-{{to}} le {{date}} à {{departure_time}}, siège(s) {{seats}}. Billet {{ticket_number}}.' },
    en: { subject: 'Reminder: your {{from}} → {{to}} departure at {{departure_time}}', body: `<p>Hello {{customer_name}},</p><p>Your trip is coming up.</p>${recap(EN)}<p>Please arrive early with your ticket {{ticket_number}}.</p><p><a class="btn" href="{{booking_url}}">View my ticket</a></p>`,
      sms: '{{company_name}}: reminder, {{from}}-{{to}} on {{date}} at {{departure_time}}, seat(s) {{seats}}. Ticket {{ticket_number}}.' },
  },
  password_reset: {
    fr: { subject: 'Réinitialisation de votre mot de passe — {{company_name}}', body: `<p>Bonjour {{first_name}},</p><p>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe. Ce lien est valable {{expires_minutes}} minutes.</p><p><a class="btn" href="{{reset_url}}">Choisir un nouveau mot de passe</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>` },
    en: { subject: 'Reset your password — {{company_name}}', body: `<p>Hello {{first_name}},</p><p>Click the button below to choose a new password. This link is valid for {{expires_minutes}} minutes.</p><p><a class="btn" href="{{reset_url}}">Choose a new password</a></p><p>If you did not request this, please ignore this message.</p>` },
  },
  staff_welcome: {
    fr: { subject: 'Votre accès au back-office {{company_name}}', body: `<p>Bonjour {{first_name}},</p><p>Un compte <b>{{role_name}}</b> vient d'être créé pour vous ({{email}}).</p><p><a class="btn" href="{{set_password_url}}">Choisir mon mot de passe</a></p><p>Page de connexion : <a href="{{login_url}}">{{login_url}}</a></p>` },
    en: { subject: 'Your {{company_name}} back-office access', body: `<p>Hello {{first_name}},</p><p>A <b>{{role_name}}</b> account has been created for you ({{email}}).</p><p><a class="btn" href="{{set_password_url}}">Choose my password</a></p><p>Sign-in page: <a href="{{login_url}}">{{login_url}}</a></p>` },
  },
  test: {
    fr: { subject: 'E-mail de test — {{company_name}}', body: `<p>Ceci est un e-mail de test.</p><p>Si vous le recevez, l'envoi des e-mails de <b>{{company_name}}</b> est correctement configuré.</p>`, sms: '{{company_name}} : SMS de test.' },
    en: { subject: 'Test e-mail — {{company_name}}', body: `<p>This is a test e-mail.</p><p>If you received it, e-mail delivery for <b>{{company_name}}</b> is configured correctly.</p>`, sms: '{{company_name}}: test SMS.' },
  },
};
