import { z } from 'zod';
import { zColor, zEmail } from '../../common/zod';

const s = (max = 200) => z.string().trim().max(max);
const url = z.string().trim().max(500).refine(v => v === '' || /^(https?:\/\/|\/)/.test(v), 'URL invalide');
const optEmail = z.union([z.literal(''), zEmail]);

/** Valeur par défaut neutre : aucun nom de société en dur dans le produit. */
export const DEFAULT_COMPANY_NAME = 'Ma Compagnie';

export const identitySchema = z.strictObject({
  name: s(80).min(1).default(DEFAULT_COMPANY_NAME),
  legalName: s(120).default(''),
  slogan: s(160).default(''),
  description: s(1000).default(''),
  logoUrl: url.default(''), logoDarkUrl: url.default(''), faviconUrl: url.default(''),
  primaryColor: zColor.default('#1d4ed8'),
  accentColor: zColor.default('#f59e0b'),
  referencePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{0,5}$/, '0 à 5 lettres ou chiffres').default(''),
});
export const contactSchema = z.strictObject({
  email: optEmail.default(''), ticketsEmail: optEmail.default(''),
  phones: z.array(s(30)).max(5).default([]),
  whatsapp: s(30).default(''),
  address: s(300).default(''), city: s(80).default(''), country: s(80).default(''),
  openingHours: s(300).default(''), website: url.default(''),
  social: z.strictObject({
    facebook: url.default(''), instagram: url.default(''), tiktok: url.default(''),
    x: url.default(''), linkedin: url.default(''), youtube: url.default(''),
  }).prefault({}),
});
export const legalSchema = z.strictObject({
  registrationNumbers: z.array(z.strictObject({ label: s(40).min(1), value: s(80).min(1) })).max(8).default([]),
  taxEnabled: z.boolean().default(false),
  taxName: s(30).default('TVA'),
  taxRatePercent: z.number().min(0).max(100).default(0),
  taxIncluded: z.boolean().default(true),
  termsText: s(20000).default(''),
  cancellationPolicyText: s(5000).default(''),
  privacyText: s(20000).default(''),
  ticketLegalNotice: s(600).default(''),
  dataRetentionMonths: z.number().int().min(1).max(240).default(36),
});
export const localeSchema = z.strictObject({
  country: s(60).default('Madagascar'),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('MGA'),
  currencySymbol: s(6).min(1).default('Ar'),
  currencyPosition: z.enum(['before', 'after']).default('after'),
  currencyDecimals: z.number().int().min(0).max(3).default(0),
  thousandsSeparator: z.enum([' ', ',', '.', '']).default(' '),
  timezone: s(60).refine(tz => { try { new Intl.DateTimeFormat('fr', { timeZone: tz }); return true; } catch { return false; } }, 'Fuseau horaire inconnu').default('Indian/Antananarivo'),
  dateFormat: z.enum(['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'd MMM yyyy']).default('dd/MM/yyyy'),
  timeFormat: z.enum(['HH:mm', 'h:mm a']).default('HH:mm'),
  defaultLang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('fr'),
  enabledLangs: z.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/)).min(1).max(20).default(['fr', 'en', 'mg', 'zh']),
  customLangs: z.array(z.strictObject({ code: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), name: s(40).min(1), baseLang: z.string().default('fr') })).max(16).default([]),
  phonePrefix: z.string().regex(/^\+?\d{0,4}$/).default('+261'),
}).refine(l => l.enabledLangs.includes(l.defaultLang), { message: 'La langue par défaut doit faire partie des langues activées', path: ['defaultLang'] });

export const bookingSchema = z.strictObject({
  seatHoldMinutes: z.number().int().min(2).max(60).default(10),
  holdMaxExtensions: z.number().int().min(0).max(3).default(1),
  paymentTimeoutMinutes: z.number().int().min(2).max(30).default(5),
  maxPassengers: z.number().int().min(1).max(20).default(6),
  serviceFee: z.number().int().min(0).default(2000),
  serviceFeeMode: z.enum(['per_booking', 'per_seat']).default('per_booking'),
  salesCloseMinutes: z.number().int().min(0).max(1440).default(30),
  salesHorizonDays: z.number().int().min(1).max(365).default(60),
  allowGuestCheckout: z.boolean().default(true),
  cancellation: z.strictObject({
    enabled: z.boolean().default(true),
    deadlineHours: z.number().min(0).max(720).default(2),
    refundPercent: z.number().min(0).max(100).default(100),
    refundServiceFee: z.boolean().default(false),
  }).prefault({}),
  change: z.strictObject({ enabled: z.boolean().default(true), deadlineHours: z.number().min(0).max(720).default(2) }).prefault({}),
  child: z.strictObject({ enabled: z.boolean().default(false), maxAge: z.number().int().min(1).max(17).default(11), discountPercent: z.number().min(0).max(100).default(50) }).prefault({}),
  baggage: z.strictObject({ includedKg: z.number().min(0).max(200).default(20), note: s(300).default('') }).prefault({}),
  noShow: z.strictObject({ auto: z.boolean().default(false), refundPercent: z.number().min(0).max(100).default(0) }).prefault({}),
  reminderHoursBefore: z.number().min(0).max(72).default(3),
});
export const ticketSchema = z.strictObject({
  headerColor: z.union([z.literal(''), zColor]).default(''),
  showLogo: z.boolean().default(true),
  footerText: s(300).default(''),
  instructions: z.array(s(200)).max(8).default([
    'Présentez ce billet (papier ou téléphone) avant l\'embarquement.',
    'Arrivez au moins 15 minutes avant l\'heure de départ.',
  ]),
  qrFormat: z.enum(['signed', 'reference']).default('signed'),
  boardingMinutesBefore: z.number().int().min(0).max(180).default(15),
});
export const notificationsSchema = z.strictObject({
  email: z.strictObject({
    enabled: z.boolean().default(false),
    host: s(200).default(''), port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false), user: s(200).default(''),
    fromName: s(80).default(''), fromEmail: optEmail.default(''), replyTo: optEmail.default(''),
  }).prefault({}),
  sms: z.strictObject({
    enabled: z.boolean().default(false),
    provider: z.enum(['none', 'http']).default('none'),
    httpUrl: url.default(''), httpMethod: z.enum(['GET', 'POST']).default('POST'),
    httpBodyTemplate: s(2000).default('{"to":"{{to}}","message":"{{message}}","sender":"{{sender}}"}'),
    authHeader: s(40).default('Authorization'), senderId: s(20).default(''),
  }).prefault({}),
  sendTicketByEmail: z.boolean().default(true),
  sendTicketBySms: z.boolean().default(false),
  adminAlertEmail: optEmail.default(''),
});
export const securitySchema = z.strictObject({
  require2faRoles: z.array(z.string().max(60)).max(30).default([]),
  customerSessionDays: z.number().int().min(1).max(365).default(30),
  staffSessionHours: z.number().int().min(1).max(720).default(12),
  maxLoginAttempts: z.number().int().min(3).max(50).default(8),
  lockoutMinutes: z.number().int().min(1).max(1440).default(15),
});

export const SETTING_SCHEMAS = {
  identity: identitySchema, contact: contactSchema, legal: legalSchema, locale: localeSchema,
  booking: bookingSchema, ticket: ticketSchema, notifications: notificationsSchema, security: securitySchema,
} as const;
export type SettingGroup = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingGroup]: z.output<(typeof SETTING_SCHEMAS)[K]> };
export const SETTING_GROUPS = Object.keys(SETTING_SCHEMAS) as SettingGroup[];

/** Champs secrets par moyen de paiement (stockés chiffrés, jamais renvoyés au navigateur). */
export const PAYMENT_SECRET_FIELDS: Record<string, string[]> = {
  mvola: ['consumerKey', 'consumerSecret'],
  orange_money: ['clientId', 'clientSecret', 'merchantKey'],
  airtel_money: ['clientId', 'clientSecret'],
};
export const DEFAULT_PAYMENT_METHODS = [
  { code: 'mvola', name: 'MVola', kind: 'mobile_money', online: true, enabled: false, sortOrder: 1, publicConfig: { merchantNumber: '', partnerName: '', prefixes: '034, 038' } },
  { code: 'orange_money', name: 'Orange Money', kind: 'mobile_money', online: true, enabled: false, sortOrder: 2, publicConfig: { currency: 'OUV', prefixes: '032, 037' } },
  { code: 'airtel_money', name: 'Airtel Money', kind: 'mobile_money', online: true, enabled: false, sortOrder: 3, publicConfig: { country: 'MG', currency: 'MGA', prefixes: '033' } },
  { code: 'cash', name: 'Espèces au guichet', kind: 'cash', online: false, enabled: true, sortOrder: 9, publicConfig: {} },
];
export const BUILTIN_LAYOUTS = [
  { code: 'bus', name: 'Bus 48 places', capacity: 48,
    rows: [{ rowId: 'driver', seats: [], isDriverRow: true }, ...'ABCDEFGHIJKL'.split('').map(l => ({ rowId: l, seats: [1, 2, 3, 4].map(n => l + n), aisleAfter: 2 }))] },
  { code: 'minibus16', name: 'Minibus 16 places', capacity: 16,
    rows: [{ rowId: 'front', seats: ['F1', 'F2'], isDriverRow: true }, { rowId: 'A', seats: ['A1', 'A2', 'A3', 'A4'], aisleAfter: 2 },
      { rowId: 'B', seats: ['B1', 'B2', 'B3'], aisleAfter: 2 }, { rowId: 'C', seats: ['C1', 'C2', 'C3'], aisleAfter: 2 }, { rowId: 'D', seats: ['D1', 'D2', 'D3', 'D4'], aisleAfter: 2 }] },
  { code: 'minibus10', name: 'Minibus VIP 10 places', capacity: 10,
    rows: [{ rowId: 'front', seats: ['F1'], isDriverRow: true }, { rowId: 'A', seats: ['A1', 'A2', 'A3'], aisleAfter: 2 },
      { rowId: 'B', seats: ['B1', 'B2', 'B3'], aisleAfter: 2 }, { rowId: 'C', seats: ['C1', 'C2', 'C3'], aisleAfter: 2 }] },
];
export const layoutSeats = (rows: any[]): string[] => (rows || []).flatMap(r => r.seats || []);
