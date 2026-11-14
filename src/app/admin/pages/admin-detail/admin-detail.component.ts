import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminAuditEntry, AuditCategory } from '../../models/admin.models';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminEmailService } from '../../services/admin-email.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminDataService } from '../../services/admin-data.service';
import { AdminUser, AdminPermissions, PERM_KEYS, PERM_META, PERM_GROUPS, RoleChange } from '../../models/admin.models';
import { AdminRolesService } from '../../services/admin-roles.service';
import { AppConfigService } from '../../../core/config/app-config.service';


type ActiveTab = 'info' | 'permissions' | 'history' | 'activity' | 'emails';
type ActiveModal = 'editInfo' | 'changeRole' | 'resetPwd' | 'delete' | null;

@Component({
  selector: 'app-admin-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, RouterLink],
  templateUrl: './admin-detail.component.html',
})
export class AdminDetailComponent implements OnInit {
  private route  = inject(ActivatedRoute);
  private router = inject(Router);
  readonly auth       = inject(AdminAuthService);
  readonly rolesService = inject(AdminRolesService);
  readonly email = inject(AdminEmailService);
  readonly toast = inject(AdminToastService);
  readonly data      = inject(AdminDataService);
  readonly auditSvc  = inject(AdminAuditService);
  readonly cfg       = inject(AppConfigService);

  adminId    = '';
  activeTab  = signal<ActiveTab>('info');
  modal      = signal<ActiveModal>(null);

  readonly user = computed<AdminUser | null>(() =>
    this.auth.admins().find(u => u.id === this.adminId) ?? null
  );
  // Audit log
  auditFilter   = signal<string>('all');
  selectedEntry   = signal<AdminAuditEntry | null>(null);
  showMailForm    = signal(false);
  mailTo          = '';

  readonly auditLog = computed(() => {
    const u = this.user();
    if (!u) return [];
    const cat = this.auditFilter();
    const entries = this.auditSvc.getForAdmin(u.id);
    return cat === 'all' ? entries : entries.filter(e => e.category === cat);
  });
  readonly auditCategories = this.auditSvc.categories;

  readonly roleLog = signal<RoleChange[]>([]);
  readonly userEmails = computed(() => { const u = this.user(); return u ? this.email.forRecipient(u.email, u.phone) : []; });
  readonly resetLink = signal<string | null>(null);
  readonly busy = signal(false);
  readonly perms = computed(() =>
    this.user() ? this.rolesService.getPermissions(this.user()!.role) : null
  );

  readonly permKeys  = PERM_KEYS;
  readonly permGroups = PERM_GROUPS;
  readonly adminRoles = this.rolesService.roles;

  editInfoForm = { firstName:'', lastName:'', email:'' };
  roleForm     = { role:'employe' , reason:'' };

  ngOnInit(): void {
    this.adminId = this.route.snapshot.paramMap.get('id') ?? '';
    void this.loadRoleLog();
    // la liste des comptes peut encore être en cours de chargement : on ne quitte la page que si le compte n'existe vraiment pas
    void this.auth.load().then(() => { if (!this.user()) this.router.navigate(['/admin/users']); });
  }
  private async loadRoleLog(): Promise<void> { this.roleLog.set(await this.auth.getRoleLog(this.adminId)); }

  openEditInfo(): void {
    const u = this.user()!;
    this.editInfoForm = { firstName: u.firstName, lastName: u.lastName, email: u.email };
    this.modal.set('editInfo');
  }
  openChangeRole(): void {
    this.roleForm = { role: this.user()!.role, reason:'' };
    this.modal.set('changeRole');
  }
  openResetPwd(): void {
    this.resetLink.set(null);
    this.modal.set('resetPwd');
  }
  openDelete(): void { this.modal.set('delete'); }
  closeModal(): void { this.modal.set(null); }

  submitEditInfo(): void {
    const f = this.editInfoForm;
    if (!f.firstName || !f.lastName || !f.email) { this.toast.error('Champs obligatoires'); return; }
    this.auth.updateAdmin(this.adminId, {
      firstName: f.firstName.trim(),
      lastName:  f.lastName.trim().toUpperCase(),
      email:     f.email.trim(),
    });
    this.toast.success('Informations mises à jour');
    const uu = this.user()!;
    this.auditSvc.log(this.auth.currentAdmin()!.id,'users','Informations admin modifiées',{severity:'info',targetId:uu.id,targetName:uu.firstName+' '+uu.lastName});
    this.modal.set(null);
  }

  submitChangeRole(): void {
    const u = this.user()!;
    if (this.roleForm.role === u.role) { this.toast.warn('Aucun changement'); this.modal.set(null); return; }
    if (this.adminId === this.auth.currentAdmin()?.id && this.roleForm.role !== 'admin') {
      this.toast.error('Vous ne pouvez pas retirer votre propre rôle admin'); return;
    }
    const oldLabel = this.auth.getRoleLabel(u.role);
    const newLabel = this.auth.getRoleLabel(this.roleForm.role);
    this.auth.changeRole(this.adminId, this.roleForm.role, this.roleForm.reason, this.auth.currentAdmin()!.id);

    this.toast.success(`Rôle modifié : ${oldLabel} → ${newLabel}`);
    setTimeout(() => void this.loadRoleLog(), 800);
    this.modal.set(null);
  }

  async generateLink(): Promise<void> {
    this.busy.set(true);
    const link = await this.auth.generateResetLink(this.adminId);
    this.busy.set(false);
    if (link) { this.resetLink.set(link); this.toast.success('Lien créé : transmettez-le à la personne concernée'); }
  }
  copyLink(): void {
    const link = this.resetLink();
    if (link) navigator.clipboard?.writeText(link).then(() => this.toast.success('Lien copié'), () => this.toast.error('Copie impossible : sélectionnez le lien à la main'));
  }

  async confirmDelete(): Promise<void> {
    const u = this.user()!;
    if (!(await this.auth.deleteAdmin(this.adminId))) return;
    this.toast.warn(`Compte ${u.firstName} ${u.lastName} supprimé`);
    this.router.navigate(['/admin/users'], { queryParams: { tab: 'admins' } });
  }

  roleLabel(r: string)  { return this.auth.getRoleLabel(r); }
  roleColor(r: string)  { return this.auth.getRoleColor(r); }
  roleBg(r: string)     { return this.auth.getRoleBg(r); }
  countPerms(r: string) { return Object.values(this.rolesService.getPermissions(r)).filter(Boolean).length; }
  permLabel(k: keyof AdminPermissions) { return PERM_META[k].label; }
  permOf(r: string) { return this.rolesService.getPermissions(r); }
  permsInGroup(r: string, group: string): Array<{ key: keyof AdminPermissions; value: boolean }> {
    return this.permKeys
      .filter(k => PERM_META[k].group === group)
      .map(k => ({ key: k, value: this.rolesService.getPermissions(r)[k] }));
  }

  roleChangeActor(rc: RoleChange): string {
    const a = this.auth.admins().find(x => x.id === rc.changedBy);
    return a ? `${a.firstName} ${a.lastName}` : rc.changedBy;
  }
  emailStatusLabel(st: string): string { return ({ sent: 'Envoyé', pending: 'En attente', failed: 'Échec', simulated: 'Simulé (aucun fournisseur configuré)' } as Record<string, string>)[st] ?? st; }
  emailTypeColor(st: string): string { return ({ sent: 'var(--a-green)', pending: 'var(--a-amber)', failed: 'var(--a-red)', simulated: 'var(--a-cyan)' } as Record<string, string>)[st] ?? 'var(--a-tx3)'; }
  initials(u: AdminUser): string { return (u.firstName[0]??'') + (u.lastName[0]??''); }

  private fleetSvc = inject(AdminFleetService);
  busName(id: string): string  { return this.fleetSvc.buses().find(b => b.id === id)?.name ?? id; }
  busPlate(id: string): string { return this.fleetSvc.buses().find(b => b.id === id)?.plateNumber ?? ''; }

  setAuditFilter(cat: string): void { this.auditFilter.set(cat); }
  openEntryDetail(e: AdminAuditEntry): void { this.selectedEntry.set(e); this.showMailForm.set(false); this.mailTo = ''; }
  closeEntryDetail(): void { this.selectedEntry.set(null); }

  printEntry(): void {
    const e = this.selectedEntry();
    if (!e) return;
    const u = this.user();
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(this.buildEntryHtml(e, u));
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 300);
  }

  downloadPdf(): void {
    const e = this.selectedEntry();
    if (!e) return;
    const u = this.user();
    const html = this.buildEntryHtml(e, u);
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'activite-' + e.id + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    this.toast.success('Rapport téléchargé');
  }

  sendByEmail(): void {
    const e = this.selectedEntry();
    if (!e || !this.mailTo.includes('@')) { this.toast.error('Email invalide'); return; }
    const u = this.user();
    const subject = encodeURIComponent('[' + this.cfg.name() + '] Activité — ' + e.action);
    const body = encodeURIComponent(
      'Activité enregistrée\n\n'
      + 'Utilisateur : ' + (u ? u.firstName + ' ' + u.lastName : e.adminId) + '\n'
      + 'Action : ' + e.action + '\n'
      + 'Catégorie : ' + this.auditSvc.categoryLabel(e.category) + '\n'
      + 'Date : ' + new Date(e.createdAt).toLocaleString('fr-FR') + '\n'
      + (e.targetName ? 'Cible : ' + e.targetName + '\n' : '')
      + (e.details ? 'Détails : ' + e.details + '\n' : '')
      + '\n' + this.cfg.name() + ' — Back-office'
    );
    window.open('mailto:' + this.mailTo + '?subject=' + subject + '&body=' + body);
    this.toast.success('Client email ouvert');
    this.showMailForm.set(false);
  }

  private buildEntryHtml(e: AdminAuditEntry, u: any): string {
    const colors: Record<string, string> = {
      info:'#0891b2', success:'#10b981', warning:'#f59e0b', danger:'#ef4444'
    };
    const col = colors[e.severity] ?? '#64748b';
    // les valeurs viennent de saisies d'utilisateurs : elles sont échappées avant d'être insérées dans le document
    const h = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Activité — ' + h(e.action) + '</title>'
      + '<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:40px auto;color:#1e293b;line-height:1.6}'
      + '.header{background:' + col + ';color:#fff;padding:24px;border-radius:12px;margin-bottom:24px}'
      + '.field{padding:10px 0;border-bottom:1px solid #e2e8f0;display:flex;gap:16px}'
      + '.label{font-size:12px;color:#64748b;min-width:140px;font-weight:600}'
      + '.value{font-size:13px;font-weight:500}'
      + '.badge{display:inline-block;padding:2px 10px;border-radius:8px;font-size:11px;font-weight:700;background:' + col + '22;color:' + col + '}'
      + '@media print{body{margin:0}}'
      + '</style></head><body>'
      + '<div class="header"><div style="font-size:22px;font-weight:800;margin-bottom:4px">' + h(e.action) + '</div>'
      + '<div style="opacity:.85;font-size:13px">' + this.auditSvc.categoryIcon(e.category) + ' ' + this.auditSvc.categoryLabel(e.category) + ' · ' + new Date(e.createdAt).toLocaleString('fr-FR') + '</div></div>'
      + '<div class="field"><div class="label">Utilisateur</div><div class="value">' + h(u ? u.firstName + ' ' + u.lastName + ' (' + u.email + ')' : e.adminId) + '</div></div>'
      + '<div class="field"><div class="label">Sévérité</div><div class="value"><span class="badge">' + h(e.severity) + '</span></div></div>'
      + '<div class="field"><div class="label">Catégorie</div><div class="value">' + this.auditSvc.categoryLabel(e.category) + '</div></div>'
      + '<div class="field"><div class="label">Date & heure</div><div class="value">' + new Date(e.createdAt).toLocaleString('fr-FR') + '</div></div>'
      + (e.targetName ? '<div class="field"><div class="label">Ressource cible</div><div class="value">' + h(e.targetName) + '</div></div>' : '')
      + (e.targetId ? '<div class="field"><div class="label">ID cible</div><div class="value" style="font-family:monospace;font-size:11px">' + h(e.targetId) + '</div></div>' : '')
      + (e.details ? '<div class="field"><div class="label">Détails</div><div class="value">' + h(e.details) + '</div></div>' : '')
      + (e.adminPublicId ? '<div class="field"><div class="label">🔐 ID public auteur</div><div class="value" style="font-family:monospace;font-weight:700">' + h(e.adminPublicId) + '</div></div>' : '')
      + (e.diff && e.diff.length > 0 ? '<div style="margin-top:24px"><h3 style="font-size:13px;font-weight:700;margin-bottom:12px;color:#1e293b">🔄 Modifications</h3>'
        + '<table style="width:100%;border-collapse:collapse;font-size:12px">'
        + '<thead><tr style="background:#f1f5f9"><th style="padding:8px 12px;text-align:left;font-weight:700;color:#64748b">Champ</th><th style="padding:8px 12px;text-align:left;font-weight:700;color:#ef4444">Avant</th><th style="padding:8px 12px;text-align:left;font-weight:700;color:#10b981">Après</th></tr></thead>'
        + '<tbody>' + e.diff.map((d, i) => '<tr style="background:' + (i%2===0?'#fff':'#f8fafc') + '">'
          + '<td style="padding:8px 12px;font-weight:600;color:#475569">' + h(d.label) + '</td>'
          + '<td style="padding:8px 12px;color:#ef4444;font-family:monospace;text-decoration:line-through">' + h(d.before) + '</td>'
          + '<td style="padding:8px 12px;color:#10b981;font-family:monospace;font-weight:700">✓ ' + h(d.after) + '</td>'
          + '</tr>').join('')
        + '</tbody></table></div>' : '')
      + '<div style="margin-top:32px;font-size:11px;color:#94a3b8;text-align:center">' + h(this.cfg.name()) + ' — Journal d\'activité — Généré le ' + new Date().toLocaleString('fr-FR') + '</div>'
      + '</body></html>';
  }
}
