import { Injectable, computed, inject, signal } from '@angular/core';
import { UserProfile, LoginCredentials, SignupData, AuthError } from '../models/user.models';
import { ApiError, ApiService } from '../api/api.service';
import { RealtimeService } from '../realtime/realtime.service';
import { store } from '../storage';

const ERROR_BY_CODE: Record<string, NonNullable<AuthError>> = {
  INVALID_CREDENTIALS: 'invalid_credentials', EMAIL_TAKEN: 'email_taken', ACCOUNT_LOCKED: 'account_locked', ACCOUNT_SUSPENDED: 'account_suspended',
  INVALID_2FA_CODE: 'invalid_code', CHALLENGE_EXPIRED: 'invalid_code', NETWORK_ERROR: 'network',
};
function toAuthError(e: unknown): NonNullable<AuthError> {
  if (!(e instanceof ApiError)) return 'unknown';
  if (e.code === 'VALIDATION_ERROR') {
    const paths = (e.details?.issues || []).map((i: any) => String(i.path));
    return paths.includes('password') ? 'weak_password' : paths.includes('email') ? 'invalid_email' : 'missing_fields';
  }
  if (e.status === 429) return 'account_locked';
  return ERROR_BY_CODE[e.code] ?? (e.status === 0 ? 'network' : 'unknown');
}
const toProfile = (u: any): UserProfile => ({ id: u.id, email: u.email, firstName: u.firstName || '', lastName: u.lastName || '', phone: u.phone || '', gender: u.gender || '',
  createdAt: u.createdAt, totpEnabled: !!u.totpEnabled, publicId: u.publicId });

/** Compte client. Le mot de passe est envoyé au serveur (HTTPS) qui le hache ; rien n'est conservé dans le navigateur. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(ApiService);
  private realtime = inject(RealtimeService);

  readonly currentUser = signal<UserProfile | null>(null);
  readonly isLoggedIn  = computed(() => this.currentUser() !== null);
  readonly authError   = signal<AuthError>(null);
  readonly isLoading   = signal(false);
  /** Présent quand le compte est protégé par la double authentification : le code est demandé à l'étape suivante. */
  readonly twoFactorChallenge = signal<string | null>(null);
  /** Vrai une fois la session éventuelle restaurée (évite un clignotement « non connecté » au chargement). */
  readonly ready = signal(false);

  constructor() {
    this.api.onSessionChange('customer', payload => {
      if (payload?.user) this.currentUser.set(toProfile(payload.user));
      else if (payload === null) { this.currentUser.set(null); store.remove('session_c'); }
      this.realtime.identify('customer');
    });
    this.realtime.on('session.revoked', () => { if (this.currentUser()) this.api.refresh('customer'); });
  }
  /** Restaure la session à l'ouverture de l'application (cookie httpOnly), sans rien demander à l'utilisateur. */
  async restore(): Promise<void> {
    if (store.get('session_c', false)) await this.api.refresh('customer');
    this.ready.set(true);
  }
  private open(r: any): void {
    this.api.setToken('customer', r.accessToken);
    this.currentUser.set(toProfile(r.user));
    store.set('session_c', true);
    this.realtime.identify('customer');
  }

  async login(credentials: LoginCredentials): Promise<boolean> {
    return this.run(async () => {
      const r = await this.api.post<any>('/auth/login', { email: credentials.email.trim(), password: credentials.password, scope: 'customer' }, { scope: 'none' });
      if (r.twoFactorRequired) { this.twoFactorChallenge.set(r.challenge); return false; }
      this.open(r); return true;
    });
  }
  async verifyTwoFactor(code: string): Promise<boolean> {
    const challenge = this.twoFactorChallenge();
    if (!challenge) return false;
    return this.run(async () => {
      this.open(await this.api.post<any>('/auth/2fa/verify', { challenge, code: code.replace(/\s/g, '') }, { scope: 'none' }));
      this.twoFactorChallenge.set(null); return true;
    });
  }
  async signup(data: SignupData): Promise<boolean> {
    return this.run(async () => {
      this.open(await this.api.post<any>('/auth/register', { email: data.email.trim(), password: data.password, firstName: data.firstName.trim(),
        lastName: data.lastName.trim(), phone: data.phone.trim(), gender: ({ M: 'M', F: 'F', male: 'M', female: 'F' } as Record<string, string>)[data.gender] ?? '' }, { scope: 'none' }));
      return true;
    });
  }
  async logout(): Promise<void> {
    try { await this.api.post('/auth/logout', undefined, { scope: 'customer' }); } catch { /* session déjà fermée */ }
    this.api.setToken('customer', null);
    this.currentUser.set(null);
    this.authError.set(null);
    store.remove('session_c');
    this.realtime.identify('customer');
  }
  async updateProfile(updates: Partial<UserProfile>): Promise<boolean> {
    return this.run(async () => {
      const body: any = {};
      for (const k of ['email', 'firstName', 'lastName', 'phone', 'gender'] as const) if (updates[k] !== undefined) body[k] = updates[k];
      this.currentUser.set(toProfile(await this.api.patch<any>('/auth/me', body, { scope: 'customer' })));
      return true;
    });
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
    return this.run(async () => { await this.api.post('/auth/change-password', { currentPassword, newPassword }, { scope: 'customer' }); return true; });
  }
  /** Toujours « succès » pour l'utilisateur : on ne révèle pas si l'adresse correspond à un compte. */
  async forgotPassword(email: string, lang: string): Promise<void> {
    try { await this.api.post('/auth/forgot-password', { email: email.trim(), scope: 'customer', lang }, { scope: 'none' }); } catch { /* idem */ }
  }
  async resetPassword(token: string, password: string): Promise<boolean> {
    return this.run(async () => { await this.api.post('/auth/reset-password', { token, password }, { scope: 'none' }); return true; });
  }
  exportMyData(): Promise<any> { return this.api.get('/auth/me/export', { scope: 'customer' }); }
  async deleteAccount(): Promise<boolean> {
    return this.run(async () => { await this.api.delete('/auth/me', { scope: 'customer' }); this.api.setToken('customer', null); this.currentUser.set(null); store.remove('session_c'); return true; });
  }
  clearError(): void { this.authError.set(null); this.twoFactorChallenge.set(null); }

  private async run(fn: () => Promise<boolean>): Promise<boolean> {
    this.isLoading.set(true); this.authError.set(null);
    try { return await fn(); }
    catch (e) { this.authError.set(toAuthError(e)); return false; }
    finally { this.isLoading.set(false); }
  }

  getErrorMessage(error: AuthError, lang = 'fr'): string {
    const msgs: Record<NonNullable<AuthError>, Record<string, string>> = {
      invalid_credentials: { fr: 'Email ou mot de passe incorrect', en: 'Incorrect email or password', mg: 'Email na teny miafina diso', zh: '邮箱或密码不正确' },
      email_taken:         { fr: 'Un compte existe déjà avec cet email', en: 'An account already exists with this email', mg: 'Misy kaonty sahady amin\'ity email ity', zh: '该邮箱已注册' },
      weak_password:       { fr: 'Mot de passe trop faible : 10 caractères minimum, avec une majuscule, une minuscule et un chiffre', en: 'Password too weak: at least 10 characters with an uppercase letter, a lowercase letter and a digit',
                             mg: 'Malemy loatra ny teny miafina: litera 10 farafahakeliny, misy sora-baventy, sora-madinika ary tarehimarika', zh: '密码太弱：至少10个字符，包含大写字母、小写字母和数字' },
      invalid_email:       { fr: 'Adresse email invalide', en: 'Invalid email address', mg: 'Adiresy email tsy mety', zh: '无效的邮箱地址' },
      missing_fields:      { fr: 'Veuillez vérifier les champs obligatoires', en: 'Please check the required fields', mg: 'Hamarino ny saha rehetra ilaina', zh: '请检查必填字段' },
      account_locked:      { fr: 'Trop de tentatives. Réessayez dans quelques minutes.', en: 'Too many attempts. Try again in a few minutes.', mg: 'Be loatra ny fanandramana. Andramo indray afaka minitra vitsy.', zh: '尝试次数过多，请几分钟后再试。' },
      account_suspended:   { fr: 'Ce compte est suspendu. Contactez-nous.', en: 'This account is suspended. Please contact us.', mg: 'Naato ity kaonty ity. Mifandraisa aminay.', zh: '该账户已被暂停，请联系我们。' },
      invalid_code:        { fr: 'Code incorrect ou expiré', en: 'Incorrect or expired code', mg: 'Kaody diso na lany daty', zh: '验证码错误或已过期' },
      network:             { fr: 'Connexion impossible. Vérifiez votre réseau.', en: 'Unable to connect. Check your network.', mg: 'Tsy afaka mifandray. Hamarino ny tambajotra.', zh: '无法连接，请检查网络。' },
      unknown:             { fr: 'Une erreur est survenue. Réessayez.', en: 'Something went wrong. Please try again.', mg: 'Nisy olana. Andramo indray.', zh: '出现错误，请重试。' },
    };
    if (!error) return '';
    return msgs[error]?.[lang] ?? msgs[error]?.['fr'] ?? '';
  }
}
