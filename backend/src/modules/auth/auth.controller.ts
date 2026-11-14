import { Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, ClientIp, CurrentUser, Public, RateLimit } from '../../common/auth';
import { Api, ZBody, normalizePhone, zEmail, zPassword, zPhone, zText } from '../../common/zod';
import { env } from '../../common/env';
import { AppError } from '../../common/errors';
import { AuthService, Scope, cookieName } from './auth.service';

const zScope = z.enum(['customer', 'staff']).default('customer');
const registerSchema = z.strictObject({
  email: zEmail, password: zPassword, firstName: zText(60), lastName: zText(60),
  phone: zPhone.transform(normalizePhone), gender: z.enum(['M', 'F', '']).default(''),
});
const loginSchema = z.strictObject({ email: zEmail, password: z.string().min(1).max(128), scope: zScope });
const twoFaSchema = z.strictObject({ challenge: z.string().min(10).max(200), code: z.string().min(6).max(12) });
const scopeSchema = z.strictObject({ scope: zScope });
const forgotSchema = z.strictObject({ email: zEmail, scope: zScope, lang: z.string().max(5).default('fr') });
const resetSchema = z.strictObject({ token: z.string().min(10).max(200), password: zPassword });
const changePwdSchema = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: zPassword });
const meSchema = z.strictObject({
  email: zEmail.optional(), firstName: zText(60).optional(), lastName: zText(60).optional(),
  phone: zPhone.transform(normalizePhone).optional(), gender: z.enum(['M', 'F', '']).optional(),
  profile: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
});

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private ctx(req: any, ip: string) { return { ip, ua: String(req.headers['user-agent'] || '') }; }
  /** Le refresh token ne quitte jamais un cookie httpOnly limité au chemin /api/v1/auth. */
  private send(res: any, r: any) {
    if (r.twoFactorRequired) return r;
    const { refreshToken, refreshMaxAge, scope, ...body } = r;
    res.setCookie(cookieName(scope), refreshToken, { httpOnly: true, secure: env().cookieSecure, sameSite: 'strict', path: '/api/v1/auth', maxAge: refreshMaxAge });
    return body;
  }
  private clear(res: any, scope: Scope) { res.clearCookie(cookieName(scope), { path: '/api/v1/auth' }); }

  @Public() @RateLimit('register', 10, 600) @Post('register') @Api('Créer un compte client', registerSchema)
  async register(@ZBody(registerSchema) b: any, @Req() req: any, @Res({ passthrough: true }) res: any, @ClientIp() ip: string) {
    return this.send(res, await this.auth.register(b, this.ctx(req, ip)));
  }
  @Public() @RateLimit('login', 20, 60) @HttpCode(200) @Post('login') @Api('Connexion (client ou personnel)', loginSchema)
  async login(@ZBody(loginSchema) b: any, @Req() req: any, @Res({ passthrough: true }) res: any, @ClientIp() ip: string) {
    return this.send(res, await this.auth.login(b, this.ctx(req, ip)));
  }
  @Public() @RateLimit('2fa', 20, 60) @HttpCode(200) @Post('2fa/verify') @Api('Valider le code de double authentification', twoFaSchema)
  async verify2fa(@ZBody(twoFaSchema) b: any, @Req() req: any, @Res({ passthrough: true }) res: any, @ClientIp() ip: string) {
    return this.send(res, await this.auth.verifyTwoFactor(b.challenge, b.code, this.ctx(req, ip)));
  }
  @Public() @RateLimit('refresh', 60, 60) @HttpCode(200) @Post('refresh') @Api('Renouveler le jeton d\'accès', scopeSchema)
  async refresh(@ZBody(scopeSchema) b: any, @Req() req: any, @Res({ passthrough: true }) res: any, @ClientIp() ip: string) {
    try { return this.send(res, await this.auth.refresh(req.cookies?.[cookieName(b.scope)] || '', this.ctx(req, ip))); }
    catch (e) { if (e instanceof AppError && e.code !== 'TOKEN_ROTATED') this.clear(res, b.scope); throw e; }
  }
  @HttpCode(204) @Post('logout') @Api('Déconnexion')
  async logout(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: any) { await this.auth.logout(u); this.clear(res, u.kind); }

  @Public() @RateLimit('forgot', 5, 600) @HttpCode(202) @Post('forgot-password') @Api('Demander un lien de réinitialisation', forgotSchema)
  async forgot(@ZBody(forgotSchema) b: any) { await this.auth.forgotPassword(b.email, b.scope, b.lang); return { ok: true }; }
  @Public() @RateLimit('reset', 10, 600) @HttpCode(200) @Post('reset-password') @Api('Définir un nouveau mot de passe', resetSchema)
  async reset(@ZBody(resetSchema) b: any) { await this.auth.resetPassword(b.token, b.password); return { ok: true }; }

  @Get('me') @Api('Profil de l\'utilisateur connecté')
  async me(@CurrentUser() u: AuthUser) { return this.auth.publicUser(await this.auth.fullUser(u.id)); }
  @Patch('me') @Api('Modifier son profil', meSchema)
  updateMe(@CurrentUser() u: AuthUser, @ZBody(meSchema) b: any) { return this.auth.updateMe(u, b); }
  @HttpCode(200) @Post('change-password') @Api('Changer son mot de passe', changePwdSchema)
  async changePassword(@CurrentUser() u: AuthUser, @ZBody(changePwdSchema) b: any) { await this.auth.changePassword(u, b.currentPassword, b.newPassword); return { ok: true }; }

  @Get('sessions') @Api('Appareils connectés')
  sessions(@CurrentUser() u: AuthUser) { return this.auth.listSessions(u); }
  @HttpCode(204) @Delete('sessions/:id') @Api('Déconnecter un appareil')
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.auth.revokeSession(u, id); }

  @HttpCode(200) @Post('2fa/setup') @Api('Préparer la double authentification (QR code)')
  setup2fa(@CurrentUser() u: AuthUser) { return this.auth.setupTwoFactor(u); }
  @HttpCode(200) @Post('2fa/enable') @Api('Activer la double authentification')
  enable2fa(@CurrentUser() u: AuthUser, @ZBody(z.strictObject({ code: z.string().min(6).max(8) })) b: any) { return this.auth.enableTwoFactor(u, b.code); }
  @HttpCode(200) @Post('2fa/disable') @Api('Désactiver la double authentification')
  async disable2fa(@CurrentUser() u: AuthUser, @ZBody(z.strictObject({ password: z.string().min(1).max(128) })) b: any) { await this.auth.disableTwoFactor(u, b.password); return { ok: true }; }

  @Get('me/export') @Api('Exporter mes données personnelles')
  export(@CurrentUser() u: AuthUser) { return this.auth.exportMyData(u); }
  @HttpCode(204) @Delete('me') @Api('Supprimer mon compte (anonymisation)')
  async deleteMe(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: any) {
    if (u.kind !== 'customer') throw new AppError('FORBIDDEN', 403, 'Un compte du personnel se supprime depuis le back-office');
    await this.auth.anonymize(u.id, u); this.clear(res, 'customer');
  }
}
