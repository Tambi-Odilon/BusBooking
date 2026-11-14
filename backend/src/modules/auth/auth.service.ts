import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as QRCode from 'qrcode';
import { Db, Queryable } from '../../common/db';
import { AppError } from '../../common/errors';
import { ACCESS_TTL_SEC, AuthUser, signAccess } from '../../common/auth';
import { decryptFromString, encryptToString, randomCode, randomToken, sha256, totpSecret, totpUri, totpVerify } from '../../common/crypto';
import { Audit } from '../../common/audit';
import { EventBus } from '../../common/events';
import { env } from '../../common/env';
import { normalizePermissions } from '../../common/permissions';
import { SettingsService } from '../settings/settings.service';
import { Outbox } from '../notifications/outbox';

export type Scope = 'customer' | 'staff';
export const cookieName = (scope: Scope) => scope === 'staff' ? 'bb_rt_s' : 'bb_rt_c';
const ARGON = { type: argon2.argon2id as 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };   // paramètres OWASP
let DUMMY_HASH: Promise<string> | null = null;

export const hashPassword = (p: string) => argon2.hash(p, ARGON);
export const newPublicId = () => 'USR-' + randomCode(6);

@Injectable()
export class AuthService {
  constructor(private db: Db, private settings: SettingsService, private audit: Audit, private outbox: Outbox, private bus: EventBus) {}

  private async verifyPassword(hash: string | null, password: string): Promise<boolean> {
    if (!hash) {   // même durée de calcul que pour un compte existant (pas d'énumération par le temps de réponse)
      DUMMY_HASH ??= hashPassword('dummy-password-for-timing');
      await argon2.verify(await DUMMY_HASH, password).catch(() => false);
      return false;
    }
    return argon2.verify(hash, password).catch(() => false);
  }

  publicUser(u: any) {
    return {
      id: u.id, kind: u.kind, email: u.email, phone: u.phone, firstName: u.firstName, lastName: u.lastName, gender: u.gender,
      publicId: u.publicId, status: u.status, totpEnabled: u.totpEnabled, profile: u.profile ?? {},
      role: u.roleSlug ?? null, roleName: u.roleName ?? null, roleColor: u.roleColor ?? null,
      permissions: u.kind === 'staff' ? normalizePermissions(u.permissions) : null,
      driverId: u.driverId ?? null, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    };
  }
  async fullUser(id: string, t: Queryable = this.db) {
    const u = await t.maybe<any>(
      `SELECT u.*, r.slug AS role_slug, r.name AS role_name, r.color AS role_color, r.permissions, d.id AS driver_id
         FROM users u LEFT JOIN roles r ON r.id = u.role_id LEFT JOIN drivers d ON d.user_id = u.id WHERE u.id = $1`, [id]);
    if (!u) throw new AppError('USER_NOT_FOUND', 404);
    return u;
  }

  // ── Inscription client ─────────────────────────────────────────────────────
  async register(d: { email: string; password: string; firstName: string; lastName: string; phone: string; gender?: string }, ctx: { ip: string; ua: string }) {
    const exists = await this.db.maybe(`SELECT 1 FROM users WHERE email = $1 AND status <> 'deleted'`, [d.email]);
    if (exists) throw new AppError('EMAIL_TAKEN', 409, 'Un compte existe déjà avec cet e-mail');
    let user: any;
    try {
      user = await this.db.insert('users', {
        kind: 'customer', email: d.email, phone: d.phone, passwordHash: await hashPassword(d.password),
        firstName: d.firstName, lastName: d.lastName, gender: d.gender ?? '', publicId: newPublicId(),
      });
    } catch (e: any) { if (e?.code === '23505') throw new AppError('EMAIL_TAKEN', 409, 'Un compte existe déjà avec cet e-mail'); throw e; }
    // rattache les réservations faites en invité avec le même e-mail
    await this.db.q(`UPDATE bookings SET customer_id = $1 WHERE customer_id IS NULL AND lower(contact_email) = lower($2)`, [user.id, d.email]);
    return this.issueSession(user.id, ctx);
  }

  // ── Connexion ──────────────────────────────────────────────────────────────
  async login(d: { email: string; password: string; scope: Scope }, ctx: { ip: string; ua: string }) {
    const sec = await this.settings.get('security');
    const ident = `${d.scope}:${d.email}`;
    const fails = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts WHERE identifier = $1 AND NOT success AND created_at > now() - ($2 || ' minutes')::interval
         AND created_at > coalesce((SELECT max(created_at) FROM login_attempts WHERE identifier = $1 AND success), '-infinity')`,
      [ident, String(sec.lockoutMinutes)]);
    if (fails.n >= sec.maxLoginAttempts) throw new AppError('ACCOUNT_LOCKED', 429, `Trop de tentatives. Réessayez dans ${sec.lockoutMinutes} minutes.`, undefined, { 'Retry-After': String(sec.lockoutMinutes * 60) });

    const user = await this.db.maybe<any>(`SELECT * FROM users WHERE email = $1 AND kind = $2 AND status <> 'deleted'`, [d.email, d.scope]);
    const ok = await this.verifyPassword(user?.passwordHash ?? null, d.password);
    await this.db.q(`INSERT INTO login_attempts (identifier, ip, success) VALUES ($1,$2,$3)`, [ident, ctx.ip, ok]);
    if (!ok) {
      if (user?.kind === 'staff') await this.audit.log({ category: 'auth', action: 'Échec de connexion', severity: 'warning', targetType: 'user', targetId: user.id, targetName: user.email, ip: ctx.ip });
      throw new AppError('INVALID_CREDENTIALS', 401, 'E-mail ou mot de passe incorrect');
    }
    if (user.status !== 'active') throw new AppError('ACCOUNT_SUSPENDED', 403, 'Compte suspendu');
    if (user.totpEnabled) {
      const challenge = randomToken();
      await this.db.q(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'two_factor',$2, now() + interval '5 minutes')`, [user.id, sha256(challenge)]);
      return { twoFactorRequired: true as const, challenge };
    }
    return this.issueSession(user.id, ctx);
  }

  async verifyTwoFactor(challenge: string, code: string, ctx: { ip: string; ua: string }) {
    const tok = await this.db.maybe<any>(`SELECT * FROM auth_tokens WHERE token_hash = $1 AND purpose = 'two_factor' AND used_at IS NULL AND expires_at > now()`, [sha256(challenge)]);
    if (!tok) throw new AppError('CHALLENGE_EXPIRED', 401, 'Délai dépassé, reconnectez-vous');
    const user = await this.db.one<any>('SELECT * FROM users WHERE id = $1', [tok.userId]);
    let ok = totpVerify(decryptFromString(user.totpSecretEnc), code);
    if (!ok) {   // code de secours à usage unique
      const h = sha256(code.trim().toUpperCase());
      const codes: string[] = user.recoveryCodes || [];
      if (codes.includes(h)) { ok = true; await this.db.q('UPDATE users SET recovery_codes = $2 WHERE id = $1', [user.id, JSON.stringify(codes.filter(c => c !== h))]); }
    }
    await this.db.q(`INSERT INTO login_attempts (identifier, ip, success) VALUES ($1,$2,$3)`, [`2fa:${user.id}`, ctx.ip, ok]);
    if (!ok) {
      const n = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM login_attempts WHERE identifier = $1 AND NOT success AND created_at > now() - interval '5 minutes'`, [`2fa:${user.id}`]);
      if (n.n >= 5) await this.db.q('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [tok.id]);
      throw new AppError('INVALID_2FA_CODE', 401, 'Code incorrect');
    }
    await this.db.q('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [tok.id]);
    return this.issueSession(user.id, ctx);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  async issueSession(userId: string, ctx: { ip: string; ua: string }, familyId?: string, t: Queryable = this.db) {
    const user = await this.fullUser(userId, t);
    const sec = await this.settings.get('security');
    const ttlSec = user.kind === 'staff' ? sec.staffSessionHours * 3600 : sec.customerSessionDays * 86400;
    const refreshToken = randomToken(48);
    const s = await t.one<any>(
      `INSERT INTO sessions (user_id, token_hash, family_id, user_agent, ip, expires_at)
       VALUES ($1,$2, coalesce($3::uuid, gen_random_uuid()), $4, $5, now() + ($6 || ' seconds')::interval) RETURNING id, family_id`,
      [userId, sha256(refreshToken), familyId ?? null, (ctx.ua || '').slice(0, 300), ctx.ip, String(ttlSec)]);
    if (!familyId) {
      await t.q('UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = $1', [userId]);
      if (user.kind === 'staff') await this.audit.log({ actor: this.asActor(user, s.id), category: 'auth', action: 'Connexion réussie', severity: 'success', ip: ctx.ip }, t);
    }
    return {
      twoFactorRequired: false as const,
      mustEnable2fa: user.kind === 'staff' && !user.totpEnabled && sec.require2faRoles.includes(user.roleSlug),
      accessToken: signAccess({ sub: userId, sid: s.id, pv: user.permVersion, k: user.kind === 'staff' ? 's' : 'c' }),
      expiresIn: ACCESS_TTL_SEC, user: this.publicUser(user),
      refreshToken, refreshMaxAge: ttlSec, scope: user.kind as Scope,
    };
  }
  asActor(u: any, sid = ''): AuthUser {
    return { id: u.id, kind: u.kind, email: u.email, phone: u.phone, firstName: u.firstName, lastName: u.lastName, publicId: u.publicId, roleSlug: u.roleSlug ?? null, permissions: null, sessionId: sid };
  }

  /** Rotation du refresh token. La réutilisation d'un jeton déjà tourné révoque toute la famille de sessions. */
  async refresh(refreshToken: string, ctx: { ip: string; ua: string }) {
    if (!refreshToken) throw new AppError('UNAUTHENTICATED', 401, 'Connexion requise');
    return this.db.tx(async t => {
      const s = await t.maybe<any>('SELECT * FROM sessions WHERE token_hash = $1 FOR UPDATE', [sha256(refreshToken)]);
      if (!s) throw new AppError('SESSION_REVOKED', 401, 'Session terminée');
      if (s.revokedAt) {
        // deux onglets qui rafraîchissent en même temps : tolérance de 20 s, sans révoquer la famille
        if (s.replacedBy && Date.now() - new Date(s.revokedAt).getTime() < 20000) throw new AppError('TOKEN_ROTATED', 401, 'Jeton déjà renouvelé');
        await t.q('UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [s.familyId]);
        t.afterCommit(() => this.bus.emit(`user:${s.userId}`, 'session.revoked', {}));
        return { reuseDetected: true as const };
      }
      if (new Date(s.expiresAt) < new Date()) throw new AppError('SESSION_EXPIRED', 401, 'Session expirée');
      const u = await t.one<any>('SELECT status FROM users WHERE id = $1', [s.userId]);
      if (u.status !== 'active') throw new AppError('ACCOUNT_SUSPENDED', 403, 'Compte suspendu');
      const next = await this.issueSession(s.userId, ctx, s.familyId, t);
      const sid = (await t.one<any>('SELECT id FROM sessions WHERE token_hash = $1', [sha256(next.refreshToken)])).id;
      await t.q('UPDATE sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [s.id, sid]);
      await t.q('UPDATE users SET last_seen_at = now() WHERE id = $1', [s.userId]);
      return next;
    }).then(r => { if ('reuseDetected' in r) throw new AppError('SESSION_REVOKED', 401, 'Session révoquée par sécurité'); return r; });
  }
  async logout(user: AuthUser) {
    await this.db.q('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [user.sessionId]);
    if (user.kind === 'staff') await this.audit.log({ actor: user, category: 'auth', action: 'Déconnexion' });
  }
  async revokeSessions(userId: string, exceptSessionId?: string, t: Queryable = this.db) {
    await t.q('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> coalesce($2::uuid, gen_random_uuid())', [userId, exceptSessionId ?? null]);
    this.bus.emit(`user:${userId}`, 'session.revoked', { except: exceptSessionId ?? null });
  }
  listSessions(user: AuthUser) {
    return this.db.q(`SELECT id, user_agent, ip, created_at, last_used_at, expires_at, (id = $2) AS current
                        FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [user.id, user.sessionId]);
  }
  async revokeSession(user: AuthUser, sessionId: string) {
    const s = await this.db.maybe<any>('SELECT family_id FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, user.id]);
    if (!s) throw new AppError('SESSION_NOT_FOUND', 404);
    await this.db.q('UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [s.familyId]);
    this.bus.emit(`user:${user.id}`, 'session.revoked', { sessionId });
  }

  // ── Profil et mot de passe ─────────────────────────────────────────────────
  async updateMe(user: AuthUser, patch: any) {
    const before = await this.fullUser(user.id);
    const { profile, ...cols } = patch;
    if (cols.email && cols.email !== before.email) {
      const dup = await this.db.maybe(`SELECT 1 FROM users WHERE email = $1 AND id <> $2 AND status <> 'deleted'`, [cols.email, user.id]);
      if (dup) throw new AppError('EMAIL_TAKEN', 409, 'Un compte existe déjà avec cet e-mail');
    }
    if (profile) cols.profile = { ...(before.profile || {}), ...profile };
    await this.db.update('users', user.id, { ...cols, updatedAt: new Date() });
    if (user.kind === 'staff') await this.audit.log({ actor: user, category: 'profile', action: 'Profil mis à jour', diff: this.audit.diff(before, patch) });
    return this.publicUser(await this.fullUser(user.id));
  }
  async changePassword(user: AuthUser, current: string, next: string) {
    const u = await this.db.one<any>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await this.verifyPassword(u.passwordHash, current))) throw new AppError('INVALID_CREDENTIALS', 401, 'Mot de passe actuel incorrect');
    await this.db.q('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, await hashPassword(next)]);
    await this.revokeSessions(user.id, user.sessionId);
    await this.audit.log({ actor: user, category: 'security', action: 'Mot de passe modifié', severity: 'warning' });
  }
  /** Répond toujours de la même façon, que le compte existe ou non. */
  async forgotPassword(email: string, scope: Scope, lang: string) {
    const u = await this.db.maybe<any>(`SELECT id, first_name, email FROM users WHERE email = $1 AND kind = $2 AND status = 'active'`, [email, scope]);
    if (!u) return;
    const token = randomToken();
    await this.db.tx(async t => {
      await t.q(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`, [u.id]);
      await t.q(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset',$2, now() + interval '1 hour')`, [u.id, sha256(token)]);
      const base = env().publicUrl + (scope === 'staff' ? '/admin/reset-password' : '/reset-password');
      await this.outbox.enqueue({ channel: 'email', to: u.email, template: 'password_reset', lang, vars: { first_name: u.firstName, reset_url: `${base}?token=${token}`, expires_minutes: 60 } }, t);
    });
  }
  async resetPassword(token: string, password: string) {
    await this.db.tx(async t => {
      const tok = await t.maybe<any>(`SELECT * FROM auth_tokens WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(token)]);
      if (!tok) throw new AppError('RESET_TOKEN_INVALID', 400, 'Lien expiré ou déjà utilisé');
      await t.q('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [tok.id]);
      await t.q('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [tok.userId, await hashPassword(password)]);
      await t.q('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [tok.userId]);
      await this.audit.log({ category: 'security', action: 'Mot de passe réinitialisé', severity: 'warning', targetType: 'user', targetId: tok.userId }, t);
      t.afterCommit(() => this.bus.emit(`user:${tok.userId}`, 'session.revoked', {}));
    });
  }

  // ── Double authentification ────────────────────────────────────────────────
  async setupTwoFactor(user: AuthUser) {
    const secret = totpSecret();
    await this.db.q('UPDATE users SET totp_secret_enc = $2 WHERE id = $1 AND NOT totp_enabled', [user.id, encryptToString(secret)]);
    const issuer = (await this.settings.get('identity')).name;
    const uri = totpUri(secret, user.email || user.publicId, issuer);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }
  async enableTwoFactor(user: AuthUser, code: string) {
    const u = await this.db.one<any>('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = $1', [user.id]);
    if (u.totpEnabled) throw new AppError('2FA_ALREADY_ENABLED', 409);
    if (!u.totpSecretEnc || !totpVerify(decryptFromString(u.totpSecretEnc), code)) throw new AppError('INVALID_2FA_CODE', 400, 'Code incorrect');
    const recovery = Array.from({ length: 8 }, () => randomCode(10));
    await this.db.q('UPDATE users SET totp_enabled = true, recovery_codes = $2 WHERE id = $1', [user.id, JSON.stringify(recovery.map(c => sha256(c)))]);
    await this.audit.log({ actor: user, category: 'security', action: 'Double authentification activée', severity: 'success' });
    return { recoveryCodes: recovery };
  }
  async disableTwoFactor(user: AuthUser, password: string) {
    const u = await this.db.one<any>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await this.verifyPassword(u.passwordHash, password))) throw new AppError('INVALID_CREDENTIALS', 401, 'Mot de passe incorrect');
    await this.db.q(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '[]' WHERE id = $1`, [user.id]);
    await this.audit.log({ actor: user, category: 'security', action: 'Double authentification désactivée', severity: 'warning' });
  }

  // ── Données personnelles ───────────────────────────────────────────────────
  async exportMyData(user: AuthUser) {
    const u = await this.fullUser(user.id);
    const bookings = await this.db.q(
      `SELECT b.reference, b.status, b.total, b.currency, b.created_at, b.contact_name, b.contact_phone, b.contact_email,
              (SELECT json_agg(json_build_object('firstName', p.first_name, 'lastName', p.last_name, 'phone', p.phone, 'seat', p.seat_no)) FROM booking_passengers p WHERE p.booking_id = b.id) AS passengers
         FROM bookings b WHERE b.customer_id = $1 ORDER BY b.created_at`, [user.id]);
    return { exportedAt: new Date().toISOString(), account: this.publicUser(u), bookings };
  }
  /** Anonymise le compte : les réservations restent (obligation comptable) mais ne sont plus rattachées à une personne. */
  async anonymize(userId: string, actor: AuthUser | null, t0?: Queryable) {
    const run = async (t: Queryable) => {
      const u = await t.one<any>('SELECT kind, public_id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (u.kind !== 'customer') throw new AppError('FORBIDDEN', 403, 'Seuls les comptes clients peuvent être anonymisés');
      await t.q(`UPDATE users SET status = 'deleted', email = NULL, phone = NULL, password_hash = NULL, first_name = 'Client', last_name = 'supprimé',
                        gender = '', profile = '{}', notes = NULL, totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '[]', updated_at = now() WHERE id = $1`, [userId]);
      await t.q('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await t.q(`UPDATE bookings SET contact_name = 'Client supprimé', contact_phone = '', contact_email = NULL
                  WHERE customer_id = $1 AND status IN ('completed','cancelled','expired','no_show')`, [userId]);
      await t.q(`UPDATE booking_passengers p SET first_name = 'Passager', last_name = 'supprimé', phone = ''
                   FROM bookings b WHERE b.id = p.booking_id AND b.customer_id = $1 AND b.status IN ('completed','cancelled','expired','no_show')`, [userId]);
      await this.audit.log({ actor, category: 'users', action: 'Compte client anonymisé', severity: 'danger', targetType: 'user', targetId: userId, targetName: u.publicId }, t);
    };
    if (t0) await run(t0); else await this.db.tx(run);
    this.bus.emit(`user:${userId}`, 'session.revoked', {});
  }
}
