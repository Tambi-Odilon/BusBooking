import { Controller, Get, Headers, HttpCode, Injectable, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, RateLimit, RequirePermission } from '../../common/auth';
import { Api, ZBody, zEmail, zId, zPassword, zText } from '../../common/zod';
import { Db } from '../../common/db';
import { AppError } from '../../common/errors';
import { Audit } from '../../common/audit';
import { EventBus } from '../../common/events';
import { env } from '../../common/env';
import { safeEqual } from '../../common/crypto';
import { todayIn } from '../../common/time';
import { SettingsService } from './settings.service';
import { PAYMENT_SECRET_FIELDS, SETTING_GROUPS, SETTING_SCHEMAS, SettingGroup } from './schemas';
import { NotificationsService, sanitizeHtml } from '../notifications/notifications.service';
import { DEFAULT_TEMPLATES, TEMPLATE_CODES, TEMPLATE_VARIABLES } from '../notifications/templates';
import { hashPassword, newPublicId } from '../auth/auth.service';
import { TripsService } from '../transport/trips.service';

const SECRET_KEY = /pass(word)?|secret|apikey|api_key|consumerkey|merchantkey|clientid|token/i;
/** Le brouillon de l'assistant est enregistré côté serveur SANS aucun secret (mots de passe, clés API). */
function stripSecrets(v: any, depth = 0): any {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => stripSecrets(x, depth + 1));
  const o: any = {};
  for (const [k, val] of Object.entries(v)) if (!SECRET_KEY.test(k)) o[k] = stripSecrets(val, depth + 1);
  return o;
}
const paymentSetup = z.strictObject({
  code: z.string().min(2).max(40), enabled: z.boolean(), mode: z.enum(['test', 'live']).default('test'),
  publicConfig: z.record(z.string().max(40), z.string().max(200)).default({}), secrets: z.record(z.string().max(40), z.string().max(4000)).default({}),
});
const completeSchema = z.strictObject({
  identity: SETTING_SCHEMAS.identity, contact: SETTING_SCHEMAS.contact.optional(), legal: SETTING_SCHEMAS.legal.optional(), locale: SETTING_SCHEMAS.locale.optional(),
  booking: SETTING_SCHEMAS.booking.optional(), ticket: SETTING_SCHEMAS.ticket.optional(), notifications: SETTING_SCHEMAS.notifications.optional(), security: SETTING_SCHEMAS.security.optional(),
  payments: z.array(paymentSetup).max(20).default([]),
  secrets: z.strictObject({ smtpPassword: z.string().max(500).optional(), smsApiKey: z.string().max(500).optional() }).default({}),
  admin: z.strictObject({ firstName: zText(60), lastName: zText(60), email: zEmail, password: zPassword }),
  seed: z.enum(['empty', 'demo']).default('empty'),
});
const smtpTest = z.strictObject({ to: zEmail, smtp: z.strictObject({ host: z.string().max(200), port: z.number().int().min(1).max(65535), secure: z.boolean().default(false), user: z.string().max(200).default(''),
  password: z.string().max(500).default(''), fromName: z.string().max(80).default(''), fromEmail: z.string().max(254).default('') }).optional() });
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
const MAGIC: Array<[string, (b: Buffer) => boolean]> = [
  ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', b => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/x-icon', b => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0],
];

@Injectable()
export class FilesService {
  constructor(private db: Db) {}
  /** Le type est déduit du CONTENU (signature binaire), jamais du nom ni du type annoncé. SVG refusé (peut contenir du script). */
  async save(req: any, kind: string, userId: string | null) {
    const file = await req.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!file) throw new AppError('FILE_REQUIRED', 400, 'Aucun fichier reçu');
    const buf: Buffer = await file.toBuffer().catch(() => { throw new AppError('FILE_TOO_LARGE', 413, 'Fichier trop volumineux (2 Mo maximum)'); });
    const mime = MAGIC.find(([, test]) => buf.length > 12 && test(buf))?.[0];
    if (!mime) throw new AppError('FILE_TYPE_NOT_ALLOWED', 400, 'Format accepté : PNG, JPEG, WebP, GIF ou ICO');
    const sha = createHash('sha256').update(buf).digest('hex');
    const name = `${sha.slice(0, 32)}.${IMAGE_TYPES[mime]}`;
    const dir = path.resolve(env().uploadDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf, { mode: 0o640 });
    const f = await this.db.insert<any>('files', { kind, mime, size: buf.length, sha256: sha, path: name, createdBy: userId });
    return { id: f.id, url: `/api/v1/files/${f.id}`, mime, size: buf.length };
  }
}

@ApiTags('Configuration publique')
@Controller()
export class PublicController {
  constructor(private settings: SettingsService, private db: Db) {}

  @Public() @Get('public/config') @Api('Configuration nécessaire au frontend (marque, couleurs, langues, devise, moyens de paiement)')
  async config(@Res({ passthrough: true }) res: any) { res.header('Cache-Control', 'no-cache'); return { ...(await this.settings.publicConfig()), version: env().version, serverTime: new Date() }; }

  @Public() @Get('public/i18n/:lang') @Api('Textes personnalisés ou langue ajoutée')
  async i18n(@Param('lang') lang: string) {
    const rows = await this.db.q<{ key: string; value: string }>('SELECT key, value FROM translations_override WHERE lang = $1', [String(lang).slice(0, 5)]);
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }
  @Public() @Get('files/:id') @Api('Image envoyée (logo, favicon, publicité)')
  async file(@Param('id') id: string, @Res() res: any) {
    const f = await this.db.maybe<any>('SELECT * FROM files WHERE id = $1', [zId.parse(id)]);
    const full = f && path.resolve(env().uploadDir, path.basename(f.path));
    if (!f || !fs.existsSync(full)) throw new AppError('FILE_NOT_FOUND', 404);
    res.header('Content-Type', f.mime).header('Cache-Control', 'public, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").send(fs.readFileSync(full));
  }
}

@ApiTags('Assistant de première configuration')
@Controller('setup')
export class SetupController {
  constructor(private db: Db, private settings: SettingsService, private audit: Audit, private notifications: NotificationsService, private files: FilesService, private trips: TripsService) {}

  /** L'assistant n'existe que tant que l'installation n'est pas terminée. Ensuite : 403, définitivement. */
  private async guard(headers: any) {
    if (await this.settings.setupCompleted()) throw new AppError('SETUP_ALREADY_COMPLETED', 403, 'L\'application est déjà configurée');
    const token = env().setupToken;
    if (token && !safeEqual(String(headers['x-setup-token'] || ''), token)) throw new AppError('SETUP_TOKEN_REQUIRED', 401, 'Code d\'installation requis (voir le fichier .env, variable SETUP_TOKEN)');
  }
  @Public() @Get('status') @Api('État de l\'assistant de configuration')
  async status(@Headers() h: any) {
    const st = await this.db.one<any>('SELECT status, draft FROM setup_state WHERE id = 1');
    const tokenRequired = !!env().setupToken;
    const authorized = !tokenRequired || safeEqual(String(h['x-setup-token'] || ''), env().setupToken);
    return { status: st.status, completed: st.status === 'completed', tokenRequired, draft: st.status !== 'completed' && authorized ? st.draft : {},
      defaults: Object.fromEntries(SETTING_GROUPS.map(g => [g, SETTING_SCHEMAS[g].parse({})])),
      paymentMethods: (await this.settings.paymentMethods()).map(m => ({ code: m.code, name: m.name, kind: m.kind, enabled: m.enabled, mode: m.mode, publicConfig: m.publicConfig, secretFields: PAYMENT_SECRET_FIELDS[m.code] ?? [] })) };
  }
  @Public() @RateLimit('setup', 120, 60) @Put('draft') @Api('Sauvegarde automatique du brouillon (sans secrets)')
  async draft(@ZBody(z.object({ draft: z.record(z.string(), z.any()) })) b: any, @Headers() h: any) {
    await this.guard(h);
    const clean = stripSecrets(b.draft);
    if (JSON.stringify(clean).length > 200_000) throw new AppError('DRAFT_TOO_LARGE', 413);
    await this.db.q(`UPDATE setup_state SET draft = $1, status = 'draft' WHERE id = 1 AND status <> 'completed'`, [JSON.stringify(clean)]);
    return { ok: true, savedAt: new Date() };
  }
  @Public() @RateLimit('setup-mail', 6, 600) @HttpCode(200) @Post('test-email') @Api('Envoyer un e-mail de test avec la configuration saisie', smtpTest)
  async testEmail(@ZBody(smtpTest) b: any, @Headers() h: any) { await this.guard(h); return this.notifications.sendTest(b.to, b.smtp); }
  @Public() @RateLimit('setup-upload', 20, 600) @Post('upload') @Api('Envoyer le logo ou le favicon')
  async upload(@Req() req: any, @Headers() h: any, @Query('kind') kind: string) { await this.guard(h); return this.files.save(req, ['logo', 'logo_dark', 'favicon'].includes(kind) ? kind : 'logo', null); }

  @Public() @RateLimit('setup-complete', 10, 600) @HttpCode(200) @Post('complete') @Api('Terminer la configuration et créer le compte administrateur', completeSchema)
  async complete(@ZBody(completeSchema) b: any, @Headers() h: any) {
    await this.guard(h);
    const passwordHash = await hashPassword(b.admin.password);
    await this.db.tx(async t => {
      // verrou : deux validations simultanées de l'assistant → une seule passe
      const st = await t.one<any>('SELECT status FROM setup_state WHERE id = 1 FOR UPDATE');
      if (st.status === 'completed') throw new AppError('SETUP_ALREADY_COMPLETED', 403, 'L\'application est déjà configurée');
      for (const g of SETTING_GROUPS) await this.settings.set(g as SettingGroup, (b as any)[g] ?? {}, null, t);
      for (const m of b.payments) {
        const exists = await t.maybe('SELECT 1 FROM payment_methods WHERE code = $1', [m.code]);
        if (!exists) continue;
        await t.q(`UPDATE payment_methods SET enabled = $2, mode = $3, public_config = public_config || $4::jsonb WHERE code = $1`, [m.code, m.enabled, m.mode, JSON.stringify(m.publicConfig)]);
        for (const [field, value] of Object.entries(m.secrets)) if ((PAYMENT_SECRET_FIELDS[m.code] ?? []).includes(field) && value) await this.settings.setSecret(`${m.code}.${field}`, String(value), t);
      }
      if (b.secrets.smtpPassword) await this.settings.setSecret('smtp.password', b.secrets.smtpPassword, t);
      if (b.secrets.smsApiKey) await this.settings.setSecret('sms.apiKey', b.secrets.smsApiKey, t);
      const role = await t.one<any>(`SELECT id FROM roles WHERE slug = 'admin'`);
      const admin = await t.insert<any>('users', { kind: 'staff', email: b.admin.email, firstName: b.admin.firstName, lastName: b.admin.lastName, passwordHash, roleId: role.id, publicId: newPublicId() });
      if (b.seed === 'demo') await seedDemo(t, (b.locale ?? SETTING_SCHEMAS.locale.parse({})).timezone);
      await t.q(`UPDATE setup_state SET status = 'completed', draft = '{}', completed_at = now() WHERE id = 1`);
      await this.audit.log({ category: 'settings', action: 'Configuration initiale terminée', severity: 'success', targetType: 'user', targetId: admin.id, targetName: b.admin.email,
        details: `Société : ${b.identity.name} · données de départ : ${b.seed}` }, t);
    });
    this.settings.invalidate();
    if (b.seed === 'demo') await this.trips.generate();
    return { ok: true, loginUrl: '/admin/login' };
  }
}

/** Jeu d'essai minimal : 3 villes, 2 itinéraires, 2 véhicules, 1 chauffeur, 3 départs quotidiens. Supprimable depuis le back-office. */
async function seedDemo(t: any, zone: string) {
  const city = async (name: string) => (await t.one(`INSERT INTO cities (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name])).id;
  const [a, b, c] = [await city('Antananarivo'), await city('Antsirabe'), await city('Toamasina')];
  const layout = async (code: string) => (await t.one('SELECT id FROM seat_layouts WHERE code = $1', [code])).id;
  const v1 = (await t.insert('vehicles', { ref: 'VEH-DEMO-1', name: 'Bus Démo 48', type: 'Bus climatisé', layoutId: await layout('bus'), plateNumber: 'DEMO-0001', amenities: ['ac', 'wifi', 'charging'] })).id;
  const v2 = (await t.insert('vehicles', { ref: 'VEH-DEMO-2', name: 'Minibus Démo 16', type: 'Minibus', layoutId: await layout('minibus16'), plateNumber: 'DEMO-0002', amenities: ['ac'] })).id;
  const d = (await t.insert('drivers', { firstName: 'Chauffeur', lastName: 'Démo', phone: '0340000000', licenseNumber: 'DEMO-PERMIS-1', licenseClass: 'D', defaultVehicleId: v1 })).id;
  const r1 = (await t.insert('routes', { fromCityId: a, toCityId: b, distanceKm: 170, durationMin: 180, basePrice: 15000, priceByLayout: { minibus16: 18000 } })).id;
  const r2 = (await t.insert('routes', { fromCityId: a, toCityId: c, distanceKm: 370, durationMin: 420, basePrice: 35000 })).id;
  for (const [route, veh] of [[r1, v1], [r1, v2], [r2, v1]]) await t.q('INSERT INTO route_vehicles (route_id, vehicle_id) VALUES ($1,$2)', [route, veh]);
  const start = todayIn(zone);
  await t.insert('trip_templates', { routeId: r1, vehicleId: v2, driverId: null, departureTime: '07:00', recurrence: 'daily', days: [0, 1, 2, 3, 4, 5, 6], startDate: start, rank: 1, notes: 'Exemple' });
  await t.insert('trip_templates', { routeId: r1, vehicleId: v2, driverId: null, departureTime: '13:00', recurrence: 'daily', days: [0, 1, 2, 3, 4, 5, 6], startDate: start, rank: 2, notes: 'Exemple' });
  await t.insert('trip_templates', { routeId: r2, vehicleId: v1, driverId: d, departureTime: '06:00', recurrence: 'weekdays', days: [1, 2, 3, 4, 5], startDate: start, rank: 1, notes: 'Exemple' });
}

const templateSchema = z.strictObject({ subject: zText(200), bodyHtml: z.string().min(1).max(20000), bodyText: z.string().max(400).default('') });

@ApiTags('Administration · paramètres')
@Controller('admin')
export class SettingsController {
  constructor(private db: Db, private settings: SettingsService, private audit: Audit, private notifications: NotificationsService, private files: FilesService, private bus: EventBus) {}

  @RequirePermission('canViewSettings') @Get('settings') @Api('Tous les paramètres (les secrets sont masqués)')
  async all() {
    return { settings: await this.settings.all(), secrets: await this.settings.secretHints(),
      paymentMethods: (await this.settings.paymentMethods()).map(m => ({ ...m, secretFields: PAYMENT_SECRET_FIELDS[m.code] ?? [] })),
      setup: await this.db.one('SELECT status, completed_at FROM setup_state WHERE id = 1') };
  }
  @RequirePermission('canManageSettings') @Put('settings/:group') @Api('Modifier un groupe de paramètres (identity, contact, legal, locale, booking, ticket, notifications, security)')
  async set(@Param('group') group: string, @ZBody(z.record(z.string(), z.any())) body: any, @CurrentUser() u: AuthUser) {
    if (!SETTING_GROUPS.includes(group as SettingGroup)) throw new AppError('SETTING_GROUP_UNKNOWN', 404);
    const before = await this.settings.get(group as SettingGroup);
    const value = await this.settings.set(group as SettingGroup, body, u.id);
    await this.audit.log({ actor: u, category: 'settings', action: `Paramètres modifiés : ${group}`, severity: 'warning', targetType: 'settings', targetId: group, diff: this.audit.diff(before as any, value as any) });
    this.bus.emit('public', 'config.changed', { group });
    return value;
  }
  /** Un secret ne peut être que remplacé ou effacé : il n'est jamais relu par le navigateur. */
  @RequirePermission('canManageSettings') @Put('secrets') @Api('Enregistrer un secret (clé API, mot de passe SMTP)')
  async secret(@ZBody(z.strictObject({ key: z.string().regex(/^[a-z_]+\.[a-zA-Z]+$/).max(80), value: z.string().max(4000) })) b: any, @CurrentUser() u: AuthUser) {
    const [scope, field] = b.key.split('.');
    const allowed = b.key === 'smtp.password' || b.key === 'sms.apiKey' || (PAYMENT_SECRET_FIELDS[scope] ?? []).includes(field);
    if (!allowed) throw new AppError('INVALID_SECRET_KEY', 400, 'Secret inconnu');
    await this.settings.setSecret(b.key, b.value);
    await this.audit.log({ actor: u, category: 'settings', action: b.value ? 'Secret enregistré' : 'Secret effacé', severity: 'warning', targetType: 'secret', targetId: b.key });
    return { ok: true, hints: await this.settings.secretHints() };
  }
  @RequirePermission('canManageSettings') @Put('payment-methods/:code') @Api('Activer, désactiver ou configurer un moyen de paiement')
  async paymentMethod(@Param('code') code: string, @CurrentUser() u: AuthUser,
    @ZBody(z.strictObject({ enabled: z.boolean().optional(), mode: z.enum(['test', 'live']).optional(), name: zText(60).optional(), sortOrder: z.number().int().min(0).max(99).optional(), publicConfig: z.record(z.string().max(40), z.string().max(200)).optional() })) b: any) {
    const before = await this.settings.paymentMethod(code);
    if (!before) throw new AppError('PAYMENT_METHOD_UNKNOWN', 404);
    if (b.mode === 'live' && before.kind !== 'cash') {
      const secrets = await this.settings.paymentSecrets(code);
      const missing = (PAYMENT_SECRET_FIELDS[code] ?? []).filter(f => !secrets[f]);
      if (missing.length) throw new AppError('PAYMENT_NOT_CONFIGURED', 409, `Impossible de passer en production : clés manquantes (${missing.join(', ')})`);
    }
    const patch: any = { ...b }; if (b.publicConfig) patch.publicConfig = { ...before.publicConfig, ...b.publicConfig };
    await this.db.update('payment_methods', code, patch, 'code');
    await this.audit.log({ actor: u, category: 'settings', action: `Moyen de paiement modifié : ${before.name}`, severity: 'warning', targetType: 'payment_method', targetId: code, diff: this.audit.diff(before, patch) });
    this.bus.emit('public', 'config.changed', { group: 'payments' });
    return this.settings.paymentMethod(code);
  }
  @RequirePermission('canManageSettings') @RateLimit('test-mail', 6, 600) @HttpCode(200) @Post('settings/test-email') @Api('Envoyer un e-mail de test', smtpTest)
  testEmail(@ZBody(smtpTest) b: any) { return this.notifications.sendTest(b.to, b.smtp); }

  @RequirePermission('canViewSettings') @Get('email-templates') @Api('Modèles d\'e-mails : valeurs par défaut, personnalisations et variables disponibles')
  async templates() {
    const custom = await this.db.q<any>('SELECT code, lang, subject, body_html, body_text, updated_at FROM email_templates');
    return TEMPLATE_CODES.map(code => ({ code, variables: TEMPLATE_VARIABLES[code], defaults: DEFAULT_TEMPLATES[code], custom: custom.filter(c => c.code === code) }));
  }
  @RequirePermission('canManageSettings') @Put('email-templates/:code/:lang') @Api('Personnaliser un modèle d\'e-mail', templateSchema)
  async setTemplate(@Param('code') code: string, @Param('lang') lang: string, @ZBody(templateSchema) b: any, @CurrentUser() u: AuthUser) {
    if (!(TEMPLATE_CODES as readonly string[]).includes(code)) throw new AppError('TEMPLATE_NOT_FOUND', 404);
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) throw new AppError('VALIDATION_ERROR', 400, 'Langue invalide');
    await this.db.q(`INSERT INTO email_templates (code, lang, subject, body_html, body_text) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (code, lang) DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text, updated_at = now()`, [code, lang, b.subject, sanitizeHtml(b.bodyHtml), b.bodyText]);
    await this.audit.log({ actor: u, category: 'settings', action: `Modèle d'e-mail modifié : ${code} (${lang})`, targetType: 'email_template', targetId: `${code}:${lang}` });
    return { ok: true, preview: await this.notifications.render(code, lang, Object.fromEntries(TEMPLATE_VARIABLES[code].filter(v => !v.startsWith('company_')).map(v => [v, `[${v}]`]))) };
  }
  @RequirePermission('canManageSettings') @HttpCode(200) @Post('email-templates/:code/:lang/reset') @Api('Revenir au modèle par défaut')
  async resetTemplate(@Param('code') code: string, @Param('lang') lang: string) { await this.db.q('DELETE FROM email_templates WHERE code = $1 AND lang = $2', [code, lang]); return { ok: true }; }

  @RequirePermission('canManageSettings') @Put('i18n/:lang') @Api('Personnaliser des textes ou traduire une langue ajoutée')
  async i18n(@Param('lang') lang: string, @ZBody(z.strictObject({ entries: z.record(z.string().max(120), z.string().max(2000)) })) b: any, @CurrentUser() u: AuthUser) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) throw new AppError('VALIDATION_ERROR', 400, 'Langue invalide');
    const entries = Object.entries(b.entries as Record<string, string>);
    if (entries.length > 2000) throw new AppError('VALIDATION_ERROR', 400, 'Trop d\'entrées');
    await this.db.tx(async t => {
      for (const [key, value] of entries) {
        if (value === '') await t.q('DELETE FROM translations_override WHERE lang = $1 AND key = $2', [lang, key]);
        else await t.q('INSERT INTO translations_override (lang, key, value) VALUES ($1,$2,$3) ON CONFLICT (lang, key) DO UPDATE SET value = EXCLUDED.value', [lang, key, value]);
      }
    });
    await this.audit.log({ actor: u, category: 'settings', action: `Textes modifiés (${lang})`, details: `${entries.length} entrée(s)` });
    return { ok: true };
  }
  @RequirePermission('canManageSettings', 'canManageAds') @RateLimit('upload', 30, 600) @Post('files') @Api('Envoyer une image (logo, favicon, publicité)')
  upload(@Req() req: any, @Query('kind') kind: string, @CurrentUser() u: AuthUser) { return this.files.save(req, ['logo', 'logo_dark', 'favicon', 'ad'].includes(kind) ? kind : 'ad', u.id); }
}
