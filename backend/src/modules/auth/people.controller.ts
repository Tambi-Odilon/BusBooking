import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePermission, Staff } from '../../common/auth';
import { Api, ZBody, normalizePhone, zColor, zEmail, zId, zOptText, zPassword, zPhone, zText } from '../../common/zod';
import { Db, paging } from '../../common/db';
import { AppError } from '../../common/errors';
import { Audit } from '../../common/audit';
import { EventBus } from '../../common/events';
import { PERMISSIONS, BUILTIN_ROLES, normalizePermissions } from '../../common/permissions';
import { randomCode, randomToken, sha256 } from '../../common/crypto';
import { env } from '../../common/env';
import { Outbox } from '../notifications/outbox';
import { AuthService, hashPassword, newPublicId } from './auth.service';

const zPerms = z.record(z.enum(PERMISSIONS), z.boolean());
const roleCreate = z.strictObject({ name: zText(60), description: zOptText(300), color: zColor.default('#94a3b8'), permissions: zPerms });
const roleUpdate = z.strictObject({ name: zText(60).optional(), description: zOptText(300), color: zColor.optional(), permissions: zPerms.optional() });
const staffProfile = z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]));
const staffCreate = z.strictObject({
  email: zEmail, firstName: zText(60), lastName: zText(60), phone: zPhone.transform(normalizePhone).optional(),
  role: z.string().min(1).max(80), password: zPassword.optional(), profile: staffProfile.optional(), sendInvite: z.boolean().default(true),
});
const staffUpdate = z.strictObject({
  email: zEmail.optional(), firstName: zText(60).optional(), lastName: zText(60).optional(),
  phone: zPhone.transform(normalizePhone).optional(), status: z.enum(['active', 'suspended']).optional(), profile: staffProfile.optional(),
});
const roleChange = z.strictObject({ role: z.string().min(1).max(80), reason: zOptText(300) });
const customerUpdate = z.strictObject({
  firstName: zText(60).optional(), lastName: zText(60).optional(), email: zEmail.optional(),
  phone: zPhone.transform(normalizePhone).optional(), notes: z.string().max(2000).optional(), status: z.enum(['active', 'suspended', 'banned']).optional(),
});

@ApiTags('Administration · rôles')
@Controller('admin/roles')
export class RolesController {
  constructor(private db: Db, private audit: Audit, private bus: EventBus) {}

  @Staff() @Get() @Api('Liste des rôles et de leurs permissions')
  async list() {
    const roles = await this.db.q<any>(`SELECT r.*, (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.status <> 'deleted') AS user_count FROM roles r ORDER BY r.is_builtin DESC, r.created_at`);
    return roles.map(r => ({ ...r, permissions: normalizePermissions(r.permissions) }));
  }
  @RequirePermission('canManageSettings') @Post() @Api('Créer un rôle personnalisé', roleCreate)
  async create(@ZBody(roleCreate) b: any, @CurrentUser() u: AuthUser) {
    const slug = 'custom-' + b.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + randomCode(4).toLowerCase();
    const r = await this.db.insert('roles', { slug, name: b.name, description: b.description ?? '', color: b.color, permissions: normalizePermissions(b.permissions) });
    await this.audit.log({ actor: u, category: 'roles', action: 'Rôle créé', severity: 'success', targetType: 'role', targetId: r.id, targetName: r.name });
    return r;
  }
  @RequirePermission('canManageSettings') @Patch(':id') @Api('Modifier un rôle', roleUpdate)
  async update(@Param('id') id: string, @ZBody(roleUpdate) b: any, @CurrentUser() u: AuthUser) {
    const affected = await this.db.tx(async t => {
      const before = await t.maybe<any>('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [zId.parse(id)]);
      if (!before) throw new AppError('ROLE_NOT_FOUND', 404);
      const patch: any = { ...b, updatedAt: new Date() };
      if (b.permissions) {
        patch.permissions = normalizePermissions(b.permissions);
        // garde-fou : le rôle « admin » ne peut pas perdre la gestion des paramètres (sinon plus personne ne peut la rendre)
        if (before.slug === 'admin' && !patch.permissions.canManageSettings) throw new AppError('ADMIN_ROLE_LOCKED', 409, 'Le rôle Administrateur doit conserver la gestion des paramètres');
      }
      await t.update('roles', id, patch);
      let users: Array<{ id: string }> = [];
      if (b.permissions) users = await t.q('UPDATE users SET perm_version = perm_version + 1 WHERE role_id = $1 RETURNING id', [id]);
      await this.audit.log({ actor: u, category: 'roles', action: 'Rôle modifié', severity: 'warning', targetType: 'role', targetId: id, targetName: before.name,
        diff: this.audit.diff({ ...before, permissions: normalizePermissions(before.permissions) }, { ...b, permissions: patch.permissions }) }, t);
      return users;
    });
    for (const x of affected) this.bus.emit(`user:${x.id}`, 'permissions.changed', {});
    return this.db.one('SELECT * FROM roles WHERE id = $1', [id]);
  }
  @RequirePermission('canManageSettings') @HttpCode(200) @Post(':id/reset') @Api('Rétablir les permissions par défaut d\'un rôle intégré')
  async reset(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const r = await this.db.one<any>('SELECT * FROM roles WHERE id = $1', [zId.parse(id)]);
    const def = BUILTIN_ROLES.find(x => x.slug === r.slug);
    if (!def) throw new AppError('NOT_BUILTIN_ROLE', 409, 'Seuls les rôles intégrés peuvent être rétablis');
    return this.update(id, { permissions: def.permissions }, u);
  }
  @RequirePermission('canManageSettings') @HttpCode(204) @Delete(':id') @Api('Supprimer un rôle personnalisé')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const r = await this.db.one<any>(`SELECT r.*, (SELECT count(*)::int FROM users x WHERE x.role_id = r.id AND x.status <> 'deleted') AS user_count FROM roles r WHERE id = $1`, [zId.parse(id)]);
    if (r.isBuiltin) throw new AppError('BUILTIN_ROLE', 409, 'Un rôle intégré ne peut pas être supprimé');
    if (r.userCount > 0) throw new AppError('ROLE_IN_USE', 409, 'Ce rôle est encore attribué à des comptes');
    await this.db.q(`UPDATE users SET role_id = (SELECT id FROM roles WHERE slug = 'employe') WHERE role_id = $1 AND status = 'deleted'`, [id]);
    await this.db.q(`DELETE FROM roles WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE role_id = $1)`, [id]);
    await this.audit.log({ actor: u, category: 'roles', action: 'Rôle supprimé', severity: 'danger', targetType: 'role', targetId: id, targetName: r.name });
  }
}

@ApiTags('Administration · comptes internes')
@Controller('admin/staff')
export class StaffController {
  constructor(private db: Db, private auth: AuthService, private audit: Audit, private bus: EventBus, private outbox: Outbox) {}

  private async roleBySlug(slug: string) {
    const r = await this.db.maybe<any>('SELECT * FROM roles WHERE slug = $1 OR id::text = $1', [slug]);
    if (!r) throw new AppError('ROLE_NOT_FOUND', 404, 'Rôle inconnu');
    return r;
  }
  private async assertNotLastAdmin(userId: string) {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.slug = 'admin' AND u.status = 'active' AND u.id <> $1`, [userId]);
    if (r.n === 0) throw new AppError('LAST_ADMIN', 409, 'Impossible : ce compte est le dernier administrateur actif');
  }

  @RequirePermission('canViewUsers') @Get() @Api('Liste des comptes internes')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q);
    const search = String(q.search || '').trim().slice(0, 80);
    const where = `u.kind = 'staff' AND u.status <> 'deleted' AND ($1 = '' OR u.email ILIKE '%'||$1||'%' OR u.first_name ILIKE '%'||$1||'%' OR u.last_name ILIKE '%'||$1||'%' OR u.public_id ILIKE '%'||$1||'%')
                   AND ($2 = '' OR r.slug = $2)`;
    const params = [search, String(q.role || '')];
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`, params)).n;
    const rows = await this.db.q<any>(
      `SELECT u.*, r.slug AS role_slug, r.name AS role_name, r.color AS role_color, r.permissions, d.id AS driver_id,
              EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.last_used_at > now() - interval '15 minutes') AS is_online
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN drivers d ON d.user_id = u.id
        WHERE ${where} ORDER BY u.created_at LIMIT $3 OFFSET $4`, [...params, limit, offset]);
    return { items: rows.map(r => ({ ...this.auth.publicUser(r), isOnline: r.isOnline })), total, page, limit };
  }
  @RequirePermission('canViewUsers') @Get(':id') @Api('Détail d\'un compte interne')
  async get(@Param('id') id: string) {
    const u = await this.auth.fullUser(zId.parse(id));
    if (u.kind !== 'staff') throw new AppError('USER_NOT_FOUND', 404);
    const roleLog = await this.db.q(`SELECT rc.*, (SELECT first_name || ' ' || last_name FROM users WHERE id = rc.changed_by) AS changed_by_name FROM role_changes rc WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
    return { ...this.auth.publicUser(u), roleLog };
  }
  @RequirePermission('canManageUsers') @Post() @Api('Créer un compte interne', staffCreate)
  async create(@ZBody(staffCreate) b: any, @CurrentUser() actor: AuthUser) {
    const role = await this.roleBySlug(b.role);
    const dup = await this.db.maybe(`SELECT 1 FROM users WHERE email = $1 AND status <> 'deleted'`, [b.email]);
    if (dup) throw new AppError('EMAIL_TAKEN', 409, 'Un compte existe déjà avec cet e-mail');
    return this.db.tx(async t => {
      const u = await t.insert<any>('users', {
        kind: 'staff', email: b.email, firstName: b.firstName, lastName: b.lastName, phone: b.phone ?? null, roleId: role.id,
        passwordHash: b.password ? await hashPassword(b.password) : null, publicId: newPublicId(), profile: b.profile ?? {},
      });
      let setPasswordUrl: string | null = null;
      if (!b.password) {   // le collaborateur choisit lui-même son mot de passe via un lien à usage unique (72 h)
        const token = randomToken();
        await t.q(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset',$2, now() + interval '72 hours')`, [u.id, sha256(token)]);
        setPasswordUrl = `${env().publicUrl}/admin/reset-password?token=${token}`;
      }
      if (b.sendInvite) await this.outbox.enqueue({ channel: 'email', to: b.email, template: 'staff_welcome',
        vars: { first_name: b.firstName, email: b.email, role_name: role.name, login_url: `${env().publicUrl}/admin/login`, set_password_url: setPasswordUrl ?? '' } }, t);
      await this.audit.log({ actor, category: 'users', action: 'Compte créé', severity: 'success', targetType: 'user', targetId: u.id, targetName: `${u.firstName} ${u.lastName}`, details: 'Rôle : ' + role.name }, t);
      return { ...this.auth.publicUser(await this.auth.fullUser(u.id, t)), setPasswordUrl };
    });
  }
  @RequirePermission('canManageUsers') @Patch(':id') @Api('Modifier un compte interne', staffUpdate)
  async update(@Param('id') id: string, @ZBody(staffUpdate) b: any, @CurrentUser() actor: AuthUser) {
    const before = await this.auth.fullUser(zId.parse(id));
    if (before.kind !== 'staff') throw new AppError('USER_NOT_FOUND', 404);
    if (b.status === 'suspended') { if (id === actor.id) throw new AppError('CANNOT_SUSPEND_SELF', 409, 'Vous ne pouvez pas suspendre votre propre compte'); if (before.roleSlug === 'admin') await this.assertNotLastAdmin(id); }
    const patch: any = { ...b, updatedAt: new Date() };
    if (b.profile) patch.profile = { ...(before.profile || {}), ...b.profile };
    await this.db.update('users', id, patch);
    if (b.status === 'suspended') await this.auth.revokeSessions(id);
    await this.audit.log({ actor, category: 'users', action: 'Compte modifié', targetType: 'user', targetId: id, targetName: `${before.firstName} ${before.lastName}`, diff: this.audit.diff(before, b) });
    return this.auth.publicUser(await this.auth.fullUser(id));
  }
  /** Le changement de rôle prend effet immédiatement : la version de permissions change et le jeton en cours est refusé. */
  @RequirePermission('canManageUsers') @HttpCode(200) @Post(':id/role') @Api('Changer le rôle d\'un compte', roleChange)
  async changeRole(@Param('id') id: string, @ZBody(roleChange) b: any, @CurrentUser() actor: AuthUser) {
    if (zId.parse(id) === actor.id) throw new AppError('CANNOT_CHANGE_OWN_ROLE', 409, 'Vous ne pouvez pas modifier votre propre rôle');
    const role = await this.roleBySlug(b.role);
    const before = await this.auth.fullUser(id);
    if (before.kind !== 'staff') throw new AppError('USER_NOT_FOUND', 404);
    if (before.roleId === role.id) return this.auth.publicUser(before);
    if (before.roleSlug === 'admin') await this.assertNotLastAdmin(id);
    await this.db.tx(async t => {
      await t.q('UPDATE users SET role_id = $2, perm_version = perm_version + 1, updated_at = now() WHERE id = $1', [id, role.id]);
      await t.q('INSERT INTO role_changes (user_id, from_role, to_role, changed_by, reason) VALUES ($1,$2,$3,$4,$5)', [id, before.roleSlug, role.slug, actor.id, b.reason ?? null]);
      await this.audit.log({ actor, category: 'roles', action: 'Rôle changé', severity: 'warning', targetType: 'user', targetId: id, targetName: `${before.firstName} ${before.lastName}`,
        details: b.reason, diff: [{ field: 'role', label: 'Rôle', before: before.roleName, after: role.name }] }, t);
      t.afterCommit(() => this.bus.emit(`user:${id}`, 'permissions.changed', { role: role.slug }));
    });
    return this.auth.publicUser(await this.auth.fullUser(id));
  }
  @RequirePermission('canManageUsers') @HttpCode(200) @Post(':id/reset-password') @Api('Générer un lien de réinitialisation du mot de passe')
  async resetPassword(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    const u = await this.auth.fullUser(zId.parse(id));
    if (u.kind !== 'staff') throw new AppError('USER_NOT_FOUND', 404);
    const token = randomToken();
    await this.db.tx(async t => {
      await t.q(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`, [id]);
      await t.q(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset',$2, now() + interval '24 hours')`, [id, sha256(token)]);
      await this.audit.log({ actor, category: 'security', action: 'Lien de réinitialisation généré', severity: 'warning', targetType: 'user', targetId: id, targetName: u.email }, t);
    });
    return { resetUrl: `${env().publicUrl}/admin/reset-password?token=${token}`, expiresInHours: 24 };
  }
  @RequirePermission('canManageUsers') @HttpCode(204) @Delete(':id') @Api('Supprimer un compte interne')
  async remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    if (zId.parse(id) === actor.id) throw new AppError('CANNOT_DELETE_SELF', 409, 'Vous ne pouvez pas supprimer votre propre compte');
    const u = await this.auth.fullUser(id);
    if (u.kind !== 'staff') throw new AppError('USER_NOT_FOUND', 404);
    if (u.roleSlug === 'admin') await this.assertNotLastAdmin(id);
    await this.db.q(`UPDATE users SET status = 'deleted', email = NULL, password_hash = NULL, totp_enabled = false, updated_at = now() WHERE id = $1`, [id]);
    await this.db.q('UPDATE drivers SET user_id = NULL WHERE user_id = $1', [id]);
    await this.auth.revokeSessions(id);
    await this.audit.log({ actor, category: 'users', action: 'Compte supprimé', severity: 'danger', targetType: 'user', targetId: id, targetName: `${u.firstName} ${u.lastName} (${u.publicId})` });
  }
}

@ApiTags('Administration · clients')
@Controller('admin/customers')
export class CustomersController {
  constructor(private db: Db, private auth: AuthService, private audit: Audit) {}

  @RequirePermission('canViewUsers', 'canSellWalkin') @Get() @Api('Liste paginée des clients (recherche par nom, e-mail, téléphone)')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q);
    const search = String(q.search || '').trim().slice(0, 80);
    const status = String(q.status || '');
    const where = `u.kind = 'customer' AND u.status <> 'deleted' AND ($2 = '' OR u.status = $2)
       AND ($1 = '' OR u.email ILIKE '%'||$1||'%' OR u.first_name ILIKE '%'||$1||'%' OR u.last_name ILIKE '%'||$1||'%' OR u.phone LIKE '%'||$1||'%' OR u.public_id ILIKE '%'||$1||'%')`;
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, [search, status])).n;
    const items = await this.db.q(
      `SELECT u.id, u.public_id, u.email, u.phone, u.first_name, u.last_name, u.gender, u.status, u.notes, u.created_at, u.last_seen_at AS last_active,
              (u.password_hash IS NOT NULL) AS has_password,
              coalesce(s.booking_count, 0) AS booking_count, coalesce(s.total_spent, 0) AS total_spent
         FROM users u
         LEFT JOIN LATERAL (SELECT count(*)::int AS booking_count, sum(total) FILTER (WHERE status IN ('confirmed','completed','no_show'))::bigint AS total_spent
                              FROM bookings b WHERE b.customer_id = u.id) s ON true
        WHERE ${where} ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`, [search, status, limit, offset]);
    return { items, total, page, limit };
  }
  @RequirePermission('canViewUsers') @Get(':id') @Api('Fiche client avec ses réservations')
  async get(@Param('id') id: string) {
    const u = await this.auth.fullUser(zId.parse(id));
    if (u.kind !== 'customer') throw new AppError('USER_NOT_FOUND', 404);
    const bookings = await this.db.q(
      `SELECT b.id, b.reference, b.status, b.total, b.currency, b.channel, b.created_at, t.service_date, t.departure_at, cf.name AS from_city, ct.name AS to_city,
              (SELECT array_agg(seat_no ORDER BY seat_no) FROM booking_passengers p WHERE p.booking_id = b.id AND p.status <> 'cancelled') AS seats
         FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
        WHERE b.customer_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [id]);
    return { ...this.auth.publicUser(u), notes: u.notes, lastActive: u.lastSeenAt, bookings };
  }
  @RequirePermission('canManageUsers') @Patch(':id') @Api('Modifier un client (coordonnées, notes, statut)', customerUpdate)
  async update(@Param('id') id: string, @ZBody(customerUpdate) b: any, @CurrentUser() actor: AuthUser) {
    const before = await this.auth.fullUser(zId.parse(id));
    if (before.kind !== 'customer') throw new AppError('USER_NOT_FOUND', 404);
    await this.db.update('users', id, { ...b, updatedAt: new Date() });
    if (b.status && b.status !== 'active') await this.auth.revokeSessions(id);
    await this.audit.log({ actor, category: 'users', action: 'Client modifié', severity: b.status && b.status !== before.status ? 'warning' : 'info',
      targetType: 'user', targetId: id, targetName: `${before.firstName} ${before.lastName}`, diff: this.audit.diff(before, b) });
    return this.get(id);
  }
  @RequirePermission('canManageUsers') @HttpCode(204) @Delete(':id') @Api('Anonymiser un client (droit à l\'effacement)')
  async anonymize(@Param('id') id: string, @CurrentUser() actor: AuthUser) { await this.auth.anonymize(zId.parse(id), actor); }
}
