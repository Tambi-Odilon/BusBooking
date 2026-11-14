import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AdminAuthService }  from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AdminToastService } from '../../services/admin-toast.service';

type Tab = 'info' | 'pro' | 'security';

const AVATAR_COLORS = [
  '#0891b2','#10b981','#8b5cf6','#ef4444','#f59e0b',
  '#3b82f6','#ec4899','#14b8a6','#f97316','#6366f1',
];

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './profile.component.html',
})
export class ProfileComponent implements OnInit {
  readonly auth     = inject(AdminAuthService);
  readonly auditSvc = inject(AdminAuditService);
  readonly fleetSvc = inject(AdminFleetService);
  readonly toast    = inject(AdminToastService);
  readonly router   = inject(Router);
  private route     = inject(ActivatedRoute);

  tab = signal<Tab>('info');
  readonly avatarColors = AVATAR_COLORS;

  // ── Formulaire identité ──────────────────────────────────────────────────
  infoForm = {
    firstName: '', lastName: '', email: '',
    phone: '', mobile: '', avatarColor: AVATAR_COLORS[0],
  };

  // ── Formulaire profil professionnel ─────────────────────────────────────
  proForm = {
    department: '', jobTitle: '',
    address: '', city: '', postalCode: '', country: '',
    bio: '',
  };

  saving = signal(false);

  // ── Formulaire mot de passe ──────────────────────────────────────────────
  pwdForm = { current: '', next: '', confirm: '' };
  pwdSaving   = signal(false);
  showCurrent = signal(false);
  showNext    = signal(false);
  showConfirm = signal(false);

  readonly me = computed(() => this.auth.currentAdmin());

  readonly myBus = computed(() => {
    const id = this.me()?.busId;
    return id ? this.fleetSvc.buses().find(b => b.id === id) : null;
  });

  readonly initials = computed(() => {
    const u = this.me();
    return u ? (u.firstName[0] ?? '').toUpperCase() + (u.lastName[0] ?? '').toUpperCase() : '?';
  });

  readonly avatarColor = computed(() =>
    this.infoForm.avatarColor || this.me()?.avatarColor || AVATAR_COLORS[0]
  );

  readonly permCount = computed(() => {
    const perms = this.auth.permissions();
    return perms ? Object.values(perms).filter(Boolean).length : 0;
  });
  readonly permTotal = computed(() => {
    const perms = this.auth.permissions();
    return perms ? Object.keys(perms).length : 0;
  });

  ngOnInit(): void {
    void this.loadSessions();
    const wanted = this.route.snapshot.queryParamMap.get('tab');
    if (wanted === 'security' || wanted === 'pro' || wanted === 'info') this.tab.set(wanted);
    const u = this.me();
    if (!u) return;
    this.infoForm = {
      firstName:   u.firstName,
      lastName:    u.lastName,
      email:       u.email,
      phone:       u.phone       ?? '',
      mobile:      u.mobile      ?? '',
      avatarColor: u.avatarColor ?? AVATAR_COLORS[0],
    };
    this.proForm = {
      department: u.department ?? '',
      jobTitle:   u.jobTitle   ?? '',
      address:    u.address    ?? '',
      city:       u.city       ?? '',
      postalCode: u.postalCode ?? '',
      country:    u.country    ?? 'Madagascar',
      bio:        u.bio        ?? '',
    };
  }

  // ── Sauvegarder identité + contact ───────────────────────────────────────
  saveInfo(): void {
    const u = this.me();
    if (!u) return;
    if (!this.infoForm.firstName.trim() || !this.infoForm.lastName.trim()) {
      this.toast.error('Prénom et nom sont obligatoires'); return;
    }
    if (!this.infoForm.email.includes('@')) {
      this.toast.error('Email invalide'); return;
    }
    const others = this.auth.admins().filter(a => a.id !== u.id);
    if (others.some(a => a.email.toLowerCase() === this.infoForm.email.toLowerCase())) {
      this.toast.error('Cet email est déjà utilisé'); return;
    }
    this.saving.set(true);
    this.auth.updateAdmin(u.id, {
      firstName:   this.infoForm.firstName.trim(),
      lastName:    this.infoForm.lastName.trim().toUpperCase(),
      email:       this.infoForm.email.trim().toLowerCase(),
      phone:       this.infoForm.phone.trim()  || undefined,
      mobile:      this.infoForm.mobile.trim() || undefined,
      avatarColor: this.infoForm.avatarColor,
    });
    this.toast.success('Identité mise à jour');
    const u2 = this.me();
    if (u2) this.auditSvc.log(u2.id,'profile','Identité & contact mis à jour',{severity:'info'});
    this.saving.set(false);
  }

  // ── Sauvegarder profil professionnel ─────────────────────────────────────
  savePro(): void {
    const u = this.me();
    if (!u) return;
    this.saving.set(true);
    this.auth.updateAdmin(u.id, {
      department: this.proForm.department.trim() || undefined,
      jobTitle:   this.proForm.jobTitle.trim()   || undefined,
      address:    this.proForm.address.trim()    || undefined,
      city:       this.proForm.city.trim()       || undefined,
      postalCode: this.proForm.postalCode.trim() || undefined,
      country:    this.proForm.country.trim()    || 'Madagascar',
      bio:        this.proForm.bio.trim()        || undefined,
    });
    this.toast.success('Profil professionnel mis à jour');
    const u3 = this.me();
    if (u3) this.auditSvc.log(u3.id,'profile','Profil professionnel mis à jour',{severity:'info'});
    this.saving.set(false);
  }

  // ── Changer le mot de passe ──────────────────────────────────────────────
  async savePassword(): Promise<void> {
    if (!this.me()) return;
    if (!this.pwdForm.current) { this.toast.error('Entrez votre mot de passe actuel'); return; }
    if (this.pwdForm.next.length < 10) { this.toast.error('10 caractères minimum'); return; }
    if (this.pwdForm.next !== this.pwdForm.confirm) { this.toast.error('Les mots de passe ne correspondent pas'); return; }
    this.pwdSaving.set(true);
    const error = await this.auth.changeMyPassword(this.pwdForm.current, this.pwdForm.next);
    this.pwdSaving.set(false);
    if (error) { this.toast.error(error); return; }
    this.pwdForm = { current: '', next: '', confirm: '' };
    this.toast.success('Mot de passe modifié. Les autres appareils ont été déconnectés.');
    void this.loadSessions();
  }

  // ── Double authentification ──────────────────────────────────────────────
  readonly twoFa = signal<{ secret: string; otpauthUrl: string; qrDataUrl: string } | null>(null);
  readonly twoFaBusy = signal(false);
  readonly recoveryCodes = signal<string[]>([]);
  twoFaCode = '';
  twoFaPassword = '';
  async start2fa(): Promise<void> {
    this.twoFaBusy.set(true);
    try { this.twoFa.set(await this.auth.setup2fa()); this.twoFaCode = ''; }
    catch { this.toast.error('Préparation impossible pour le moment'); }
    finally { this.twoFaBusy.set(false); }
  }
  async confirm2fa(): Promise<void> {
    this.twoFaBusy.set(true);
    const r = await this.auth.enable2fa(this.twoFaCode);
    this.twoFaBusy.set(false);
    if (r.error) { this.toast.error(r.error); return; }
    this.twoFa.set(null); this.twoFaCode = '';
    this.recoveryCodes.set(r.recoveryCodes ?? []);
    this.toast.success('Double authentification activée');
  }
  async disable2fa(): Promise<void> {
    this.twoFaBusy.set(true);
    const error = await this.auth.disable2fa(this.twoFaPassword);
    this.twoFaBusy.set(false);
    if (error) { this.toast.error(error); return; }
    this.twoFaPassword = ''; this.recoveryCodes.set([]);
    this.toast.warn('Double authentification désactivée');
  }
  copyRecovery(): void { navigator.clipboard?.writeText(this.recoveryCodes().join('\n')).then(() => this.toast.success('Codes copiés'), () => this.toast.error('Copie impossible')); }

  // ── Appareils connectés ──────────────────────────────────────────────────
  readonly sessions = signal<any[]>([]);
  async loadSessions(): Promise<void> { try { this.sessions.set(await this.auth.sessions()); } catch { /* affichage facultatif */ } }
  async revoke(id: string): Promise<void> {
    try { await this.auth.revokeSession(id); this.toast.success('Appareil déconnecté'); } catch { this.toast.error('Action impossible'); }
    void this.loadSessions();
  }
  deviceLabel(ua: string | null): string {
    if (!ua) return 'Appareil inconnu';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
  }

  roleColor(): string { return this.auth.getRoleColor(this.me()?.role ?? ''); }
  roleLabel(): string { return this.auth.getRoleLabel(this.me()?.role ?? ''); }
  roleBg(): string    { return this.auth.getRoleBg(this.me()?.role ?? ''); }
  logout(): void      { this.auth.logout(); this.router.navigate(['/admin/login']); }

  pwdStrength(): number {
    const p = this.pwdForm.next;
    if (!p) return 0;
    let s = 0;
    if (p.length >= 8)  s++;
    if (p.length >= 12) s++;
    if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
    if (/[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
    return Math.min(4, s);
  }

  toggleCurrent(): void { this.showCurrent.update(v => !v); }
  toggleNext():    void { this.showNext.update(v => !v); }
  toggleConfirm(): void { this.showConfirm.update(v => !v); }
}
