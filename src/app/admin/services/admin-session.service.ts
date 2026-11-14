import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { store } from '../../core/storage';
import { AdminPermissions } from '../models/admin.models';

/** Compte interne tel que renvoyé par l'API. */
export interface StaffUser {
  id: string; email: string; phone: string | null; firstName: string; lastName: string; publicId: string; status: string; totpEnabled: boolean;
  profile: Record<string, any>; role: string; roleName: string; roleColor: string; permissions: AdminPermissions; driverId: string | null;
  createdAt: string; lastLoginAt: string | null; isOnline?: boolean;
}

/**
 * Session du personnel. Le jeton d'accès reste en mémoire ; la session est restaurée à partir d'un cookie httpOnly.
 * Les permissions affichées ici ne servent qu'à masquer des menus : chaque action est revérifiée par le serveur.
 */
@Injectable({ providedIn: 'root' })
export class AdminSession {
  private api = inject(ApiService);
  private realtime = inject(RealtimeService);

  readonly user = signal<StaffUser | null>(null);
  readonly ready = signal(false);
  readonly permissions = computed<AdminPermissions | null>(() => this.user()?.permissions ?? null);

  constructor() {
    this.api.onSessionChange('staff', payload => {
      if (payload?.user) this.user.set(payload.user);
      else if (payload === null) { this.user.set(null); store.remove('session_s'); }
      this.realtime.identify('staff');
    });
    // rôle ou permissions modifiés, session révoquée : on renouvelle le jeton, ce qui recharge les droits (ou déconnecte)
    for (const ev of ['permissions.changed', 'session.revoked']) this.realtime.on(ev, () => { if (this.user()) this.api.refresh('staff'); });
  }
  can(p: keyof AdminPermissions): boolean { return this.user()?.permissions?.[p] === true; }

  async restore(): Promise<void> {
    if (store.get('session_s', false)) await this.api.refresh('staff');
    this.ready.set(true);
  }
  open(r: { accessToken: string; user: StaffUser }): void {
    this.api.setToken('staff', r.accessToken);
    this.user.set(r.user);
    store.set('session_s', true);
    this.realtime.identify('staff');
  }
  async reloadMe(): Promise<void> {
    try { this.user.set(await this.api.get<StaffUser>('/auth/me', { scope: 'staff' })); } catch { /* la session sera renouvelée au prochain appel */ }
  }
  async close(): Promise<void> {
    try { await this.api.post('/auth/logout', undefined, { scope: 'staff' }); } catch { /* session déjà fermée */ }
    this.api.setToken('staff', null);
    this.user.set(null);
    store.remove('session_s');
    this.realtime.identify('staff');
  }
}
