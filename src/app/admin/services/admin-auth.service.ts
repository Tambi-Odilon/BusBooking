import { Injectable, computed, inject, signal } from '@angular/core';
import { AdminUser, AdminPermissions, RoleChange } from '../models/admin.models';
import { AdminRolesService } from './admin-roles.service';
import { AdminSession, StaffUser } from './admin-session.service';
import { RemoteStore } from './admin-store';
import { ApiError, errorMessage } from '../../core/api/api.service';

export function toAdminUser(u: StaffUser | any): AdminUser {
  const p = u.profile || {};
  return {
    id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role, publicId: u.publicId,
    phone: u.phone || '', mobile: p.mobile || '', address: p.address || '', city: p.city || '', postalCode: p.postalCode || '', country: p.country || '',
    department: p.department || '', jobTitle: p.jobTitle || '', bio: p.bio || '', avatarColor: p.avatarColor || undefined,
    busId: p.busId || undefined, status: u.status === 'suspended' ? 'suspended' : 'active', totpEnabled: !!u.totpEnabled,
    lastLogin: u.lastLoginAt || '', isOnline: !!u.isOnline, createdAt: u.createdAt,
  };
}
const PROFILE_KEYS = ['mobile', 'address', 'city', 'postalCode', 'country', 'department', 'jobTitle', 'bio', 'avatarColor', 'busId'] as const;

/** Comptes du personnel : connexion (avec double authentification), création, rôles, mots de passe. Tout est validé par le serveur. */
@Injectable({ providedIn: 'root' })
export class AdminAuthService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewUsers', 'canManageUsers'];
  private rolesService = inject(AdminRolesService);

  readonly currentAdmin = computed<AdminUser | null>(() => { const u = this.session.user(); return u ? toAdminUser(u) : null; });
  readonly isLoggedIn   = computed(() => this.session.user() !== null);
  readonly role         = computed(() => this.session.user()?.role ?? null);
  readonly isLoading    = signal(false);
  readonly loginError   = signal<string | null>(null);
  /** Défini quand le compte exige un code de double authentification. */
  readonly twoFactorChallenge = signal<string | null>(null);
  /** Le rôle impose la double authentification et elle n'est pas encore activée. */
  readonly mustEnable2fa = signal(false);

  private readonly _admins = signal<AdminUser[]>([]);
  readonly admins = this._admins.asReadonly();
  readonly permissions = computed<AdminPermissions | null>(() => this.session.permissions());

  protected async fetch(): Promise<void> {
    const r = await this.api.get<{ items: any[] }>('/admin/staff', { query: { limit: 100 } });
    this._admins.set(r.items.map(toAdminUser));
  }
  protected reset(): void { this._admins.set([]); }
  can(permission: keyof AdminPermissions): boolean { return this.session.can(permission); }
  restore(): Promise<void> { return this.session.restore(); }

  // ── Connexion ─────────────────────────────────────────────────────────────
  async login(email: string, password: string): Promise<boolean> {
    return this.attempt(async () => {
      const r = await this.api.post<any>('/auth/login', { email: email.trim(), password, scope: 'staff' }, { scope: 'none' });
      if (r.twoFactorRequired) { this.twoFactorChallenge.set(r.challenge); return false; }
      this.mustEnable2fa.set(!!r.mustEnable2fa); this.session.open(r); return true;
    });
  }
  async verifyTwoFactor(code: string): Promise<boolean> {
    const challenge = this.twoFactorChallenge();
    if (!challenge) return false;
    return this.attempt(async () => {
      const r = await this.api.post<any>('/auth/2fa/verify', { challenge, code: code.replace(/\s/g, '') }, { scope: 'none' });
      this.twoFactorChallenge.set(null); this.session.open(r); return true;
    });
  }
  cancelTwoFactor(): void { this.twoFactorChallenge.set(null); this.loginError.set(null); }
  private async attempt(fn: () => Promise<boolean>): Promise<boolean> {
    this.isLoading.set(true); this.loginError.set(null);
    try { return await fn(); }
    catch (e) {
      const err = e as ApiError;
      this.loginError.set(err.status === 429 ? 'Trop de tentatives. Réessayez dans quelques minutes.' : errorMessage(e, 'Connexion impossible'));
      return false;
    } finally { this.isLoading.set(false); }
  }
  logout(): void { void this.session.close(); }
  async forgotPassword(email: string): Promise<void> {
    try { await this.api.post('/auth/forgot-password', { email: email.trim(), scope: 'staff', lang: 'fr' }, { scope: 'none' }); } catch { /* réponse identique dans tous les cas */ }
  }
  /** Renvoie un message d'erreur, ou null si le mot de passe a été enregistré. */
  async resetPasswordWithToken(token: string, password: string): Promise<string | null> {
    try { await this.api.post('/auth/reset-password', { token, password }, { scope: 'none' }); return null; } catch (e) { return errorMessage(e); }
  }

  // ── Comptes ───────────────────────────────────────────────────────────────
  getAllAdmins(): AdminUser[] { return this._admins(); }
  /**
   * Crée un compte interne. Sans mot de passe, le serveur envoie une invitation par e-mail (lien à usage unique).
   * Renvoie `{ error }` en cas de refus, sinon éventuellement le lien d'activation à transmettre.
   */
  async createAdmin(data: Omit<AdminUser, 'id' | 'createdAt' | 'lastLogin' | 'isOnline'>, password?: string): Promise<{ error?: string; setPasswordUrl?: string }> {
    const profile: Record<string, any> = {};
    for (const k of PROFILE_KEYS) if ((data as any)[k]) profile[k] = (data as any)[k];
    try {
      const r = await this.api.post<any>('/admin/staff', { email: data.email.trim(), firstName: data.firstName.trim(), lastName: data.lastName.trim(), role: data.role,
        phone: data.phone?.trim() || undefined, password: password || undefined, profile });
      await this.load();
      return { setPasswordUrl: r.setPasswordUrl || undefined };
    } catch (e) { return { error: errorMessage(e) }; }
  }
  updateAdmin(id: string, patch: Partial<Omit<AdminUser, 'id' | 'lastLogin' | 'isOnline' | 'createdAt'>>): void {
    const me = this.session.user()?.id === id;
    const body: any = {};
    for (const k of ['email', 'firstName', 'lastName'] as const) if (patch[k] !== undefined) body[k] = patch[k];
    if (patch.phone) body.phone = patch.phone;
    if (!me && patch.status) body.status = patch.status;
    const current = (me ? this.session.user()?.profile : this._admins().find(a => a.id === id) as any) || {};
    const profile: Record<string, any> = {};
    for (const k of PROFILE_KEYS) { const v = (patch as any)[k] ?? (current as any)[k]; if (v !== undefined && v !== '') profile[k] = v; }
    if (PROFILE_KEYS.some(k => (patch as any)[k] !== undefined)) body.profile = profile;
    this._admins.update(l => l.map(a => a.id === id ? { ...a, ...patch } : a));
    void this.write(() => me ? this.api.patch('/auth/me', body, { scope: 'staff' }) : this.api.patch(`/admin/staff/${id}`, body)).then(() => { if (me) void this.session.reloadMe(); });
  }
  changeRole(id: string, newRole: string, reason: string, _changedById?: string): void {
    this._admins.update(l => l.map(a => a.id === id ? { ...a, role: newRole } : a));
    void this.write(() => this.api.post(`/admin/staff/${id}/role`, { role: newRole, reason: reason || undefined }));
  }
  /** Change son propre mot de passe. Renvoie un message d'erreur, ou null. */
  async changeMyPassword(currentPassword: string, newPassword: string): Promise<string | null> {
    try { await this.api.post('/auth/change-password', { currentPassword, newPassword }, { scope: 'staff' }); return null; } catch (e) { return errorMessage(e); }
  }
  /** Lien de réinitialisation à usage unique (24 h) pour un autre compte. Le mot de passe n'est jamais connu de l'administrateur. */
  async generateResetLink(adminId: string): Promise<string | null> {
    try { return (await this.api.post<{ resetUrl: string }>(`/admin/staff/${adminId}/reset-password`)).resetUrl; }
    catch (e) { this.toast.error(errorMessage(e)); return null; }
  }
  async getRoleLog(adminId: string): Promise<RoleChange[]> {
    try {
      const r = await this.api.get<any>(`/admin/staff/${adminId}`);
      return (r.roleLog || []).map((c: any) => ({ id: c.id, adminId: c.userId, fromRole: c.fromRole || '', toRole: c.toRole, changedBy: c.changedByName || '—', changedAt: c.createdAt, reason: c.reason || undefined }));
    } catch { return []; }
  }
  async deleteAdmin(id: string): Promise<boolean> {
    try { await this.api.delete(`/admin/staff/${id}`); await this.load(); return true; }
    catch (e) { this.toast.error(errorMessage(e)); return false; }
  }

  // ── Double authentification et appareils ─────────────────────────────────
  setup2fa(): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> { return this.api.post('/auth/2fa/setup', undefined, { scope: 'staff' }); }
  async enable2fa(code: string): Promise<{ recoveryCodes?: string[]; error?: string }> {
    try { const r = await this.api.post<any>('/auth/2fa/enable', { code: code.replace(/\s/g, '') }, { scope: 'staff' }); this.mustEnable2fa.set(false); await this.session.reloadMe(); return { recoveryCodes: r.recoveryCodes }; }
    catch (e) { return { error: errorMessage(e) }; }
  }
  async disable2fa(password: string): Promise<string | null> {
    try { await this.api.post('/auth/2fa/disable', { password }, { scope: 'staff' }); await this.session.reloadMe(); return null; } catch (e) { return errorMessage(e); }
  }
  sessions(): Promise<any[]> { return this.api.get('/auth/sessions', { scope: 'staff' }); }
  async revokeSession(id: string): Promise<void> { await this.api.delete(`/auth/sessions/${id}`, { scope: 'staff' }); }

  // ── Affichage ─────────────────────────────────────────────────────────────
  getRoleLabel(roleId: string): string {
    const me = this.session.user();
    return this.rolesService.roles().find(r => r.id === roleId)?.name ?? (me?.role === roleId ? me.roleName : roleId);
  }
  getRoleColor(roleId: string): string {
    const me = this.session.user();
    return this.rolesService.roles().find(r => r.id === roleId)?.color ?? (me?.role === roleId ? me.roleColor : '#94a3b8');
  }
  getRoleBg(roleId: string): string { return this.getRoleColor(roleId) + '22'; }
  getRoleBadgeClass(roleId: string): string {
    const map: Record<string, string> = {
      admin: 'bg-red-500/20 text-red-300 border border-red-500/30', comptable: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
      superviseur: 'bg-blue-500/20 text-blue-300 border border-blue-500/30', employe: 'bg-slate-500/20 text-slate-300 border border-slate-500/30',
      chauffeur: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    };
    return map[roleId] ?? 'bg-slate-500/20 text-slate-300 border border-slate-500/30';
  }
}
