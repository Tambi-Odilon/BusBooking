import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { env } from './env';
import { Db } from './db';
import { AppError } from './errors';
import { RateLimiter } from './redis';
import { Permission, PermissionSet, normalizePermissions } from './permissions';
import { SettingsService } from '../modules/settings/settings.service';

export interface AuthUser {
  id: string; kind: 'customer' | 'staff'; email: string | null; phone: string | null;
  firstName: string; lastName: string; publicId: string;
  roleSlug: string | null; permissions: PermissionSet | null; sessionId: string;
  /** Vrai si le rôle impose la double authentification et qu'elle n'est pas encore activée : seules les routes /auth restent accessibles. */
  mustEnable2fa?: boolean;
}
export interface AccessPayload { sub: string; sid: string; pv: number; k: 'c' | 's' }

export const ACCESS_TTL_SEC = 15 * 60;
export const signAccess = (p: AccessPayload) => jwt.sign(p, env().jwtSecret, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SEC });
export function verifyAccess(token: string): AccessPayload {
  try { return jwt.verify(token, env().jwtSecret, { algorithms: ['HS256'] }) as AccessPayload; }
  catch (e: any) { throw new AppError(e?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', 401, 'Session expirée'); }
}

/** Route accessible sans authentification. */
export const Public = () => SetMetadata('auth:public', true);
/** Route accessible aux invités, mais qui identifie l'utilisateur s'il est connecté. */
export const OptionalAuth = () => SetMetadata('auth:optional', true);
/** Réservé aux comptes internes. */
export const Staff = () => SetMetadata('auth:staff', true);
/** Réservé aux comptes internes possédant AU MOINS UNE des permissions listées. */
export const RequirePermission = (...perms: Permission[]) => SetMetadata('auth:perms', perms);
export const RateLimit = (bucket: string, limit: number, windowSec = 60) => SetMetadata('auth:rl', { bucket, limit, windowSec });
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | null => ctx.switchToHttp().getRequest().user ?? null);
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().ip || '');

export const can = (u: AuthUser | null, p: Permission) => !!u && u.kind === 'staff' && u.permissions?.[p] === true;

@Injectable()
export class AuthLoader {
  constructor(private db: Db, private settings: SettingsService) {}
  /** Recharge l'utilisateur, son rôle et sa session à chaque requête : une révocation ou un changement de rôle est immédiat. */
  async load(p: AccessPayload): Promise<AuthUser> {
    const row = await this.db.maybe<any>(
      `SELECT u.id, u.kind, u.email, u.phone, u.first_name, u.last_name, u.public_id, u.status, u.perm_version, u.totp_enabled,
              r.slug AS role_slug, r.permissions, s.revoked_at, s.expires_at
         FROM users u
         JOIN sessions s ON s.id = $2 AND s.user_id = u.id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`, [p.sub, p.sid]);
    if (!row || row.revokedAt || new Date(row.expiresAt) < new Date()) throw new AppError('SESSION_REVOKED', 401, 'Session terminée');
    if (row.status !== 'active') throw new AppError('ACCOUNT_SUSPENDED', 403, 'Compte suspendu');
    if (row.permVersion !== p.pv) throw new AppError('PERMISSIONS_CHANGED', 401, 'Vos droits ont changé, reconnexion nécessaire');
    const required = row.kind === 'staff' && !row.totpEnabled && (await this.settings.get('security')).require2faRoles.includes(row.roleSlug);
    return {
      mustEnable2fa: required,
      id: row.id, kind: row.kind, email: row.email, phone: row.phone, firstName: row.firstName, lastName: row.lastName,
      publicId: row.publicId, roleSlug: row.roleSlug, sessionId: p.sid,
      permissions: row.kind === 'staff' ? normalizePermissions(row.permissions) : null,
    };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private loader: AuthLoader, private limiter: RateLimiter) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest();
    const meta = <T>(k: string) => this.reflector.getAllAndOverride<T>(k, [ctx.getHandler(), ctx.getClass()]);
    const ip = req.ip || 'unknown';

    await this.limiter.hit('global', ip, 600, 60);
    const rl = meta<{ bucket: string; limit: number; windowSec: number }>('auth:rl');
    if (rl) await this.limiter.hit(rl.bucket, ip, rl.limit, rl.windowSec);

    const isPublic = meta<boolean>('auth:public');
    const optional = meta<boolean>('auth:optional');
    const staffOnly = meta<boolean>('auth:staff');
    const perms = meta<Permission[]>('auth:perms');
    if (isPublic) return true;

    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      if (optional) return true;
      throw new AppError('UNAUTHENTICATED', 401, 'Connexion requise');
    }
    const user = await this.loader.load(verifyAccess(token));
    req.user = user;
    if (user.mustEnable2fa && !String(req.routeOptions?.url || req.url).startsWith('/api/v1/auth/'))
      throw new AppError('TWO_FACTOR_SETUP_REQUIRED', 403, 'Votre rôle exige la double authentification : activez-la dans votre profil pour continuer');
    if ((staffOnly || perms?.length) && user.kind !== 'staff') throw new AppError('FORBIDDEN', 403, 'Accès réservé au personnel');
    if (perms?.length && !perms.some(p => user.permissions?.[p])) throw new AppError('PERMISSION_DENIED', 403, 'Permission insuffisante', { required: perms });
    return true;
  }
}
