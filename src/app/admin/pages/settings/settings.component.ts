import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminThemeService } from '../../services/admin-theme.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminRolesService } from '../../services/admin-roles.service';
import { AdminDatePipe } from '../../pipes/admin.pipes';
import { AdminPermissions, PERM_KEYS } from '../../models/admin.models';
import { AppConfigService } from '../../../core/config/app-config.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, AdminDatePipe, RouterLink],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  constructor() { void this.refreshHealth(); }
  readonly theme        = inject(AdminThemeService);
  readonly auth         = inject(AdminAuthService);
  readonly toast        = inject(AdminToastService);
  readonly rolesService = inject(AdminRolesService);
  readonly cfg          = inject(AppConfigService);

  tab = signal<'admins'|'roles'|'system'>('admins');
  readonly tabs: Array<'admins'|'roles'|'system'> = ['admins', 'roles', 'system'];
  readonly tabLabel: Record<'admins'|'roles'|'system', string> = {
    admins: 'Comptes admin', roles: 'Rôles & Permissions', system: 'Système',
  };

  // Roles as signal (reactive)
  readonly roles = this.rolesService.roles;
  readonly permKeys = PERM_KEYS;

  getRoleLabel(r: string)  { return this.auth.getRoleLabel(r); }
  getRoleColor(r: string)  { return this.auth.getRoleColor(r); }
  getRoleBg(r: string)     { return this.auth.getRoleBg(r); }
  countPerms(r: string)    { return this.rolesService.countPerms(r); }

  getPermissions(roleId: string): AdminPermissions {
    return this.rolesService.getPermissions(roleId);
  }

  // ── Onglet Système : état réel du serveur ─────────────────────────────────
  readonly health = signal<{ status: string; checks: Record<string, string> } | null>(null);
  readonly healthError = signal(false);
  readonly systemInfo = computed(() => {
    const h = this.health();
    const label = (v?: string) => v === 'ok' ? 'Opérationnel' : v ? 'Indisponible' : '—';
    return [
      { label: 'Version', value: this.cfg.config().version || '—' },
      { label: 'Serveur', value: this.healthError() ? 'Injoignable' : h ? (h.status === 'ok' ? 'Opérationnel' : h.status === 'degraded' ? 'Mode dégradé' : 'En panne') : '…' },
      { label: 'Base de données', value: label(h?.checks?.['database']) },
      { label: 'Cache et temps réel', value: label(h?.checks?.['redis']) },
    ];
  });

  async refreshHealth(): Promise<void> {
    this.healthError.set(false);
    try {
      const r = await fetch('/health/ready', { cache: 'no-store' });
      this.health.set(await r.json());
    } catch { this.health.set(null); this.healthError.set(true); }
  }

  /** Recharge la configuration de la société depuis le serveur (utile après une modification faite sur un autre poste). */
  async reloadConfig(): Promise<void> {
    await this.cfg.load();
    this.toast.success('Configuration rechargée');
  }

  exportData(): void {
    const data = {
      exportDate: new Date().toISOString(),
      company: this.cfg.name(),
      admins: this.auth.getAllAdmins(),
      roles: this.rolesService.roles(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `comptes-et-roles-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.toast.success('Export téléchargé');
  }
}
