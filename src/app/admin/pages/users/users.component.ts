import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { AdminDataService } from '../../services/admin-data.service';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminEmailService } from '../../services/admin-email.service';
import { StatCardComponent } from '../../components/admin-shared.component';
import { AriaryPipe, PermFilterPipe } from '../../pipes/admin.pipes';
import {
  AdminClientUser, AdminUser, AdminPermissions,
  PERM_KEYS, PERM_META, PERM_GROUPS
} from '../../models/admin.models';
import { AdminRolesService } from '../../services/admin-roles.service';


@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule, StatCardComponent, AriaryPipe, DatePipe, PermFilterPipe, RouterLink],
  templateUrl: './users.component.html',
})
export class UsersComponent implements OnInit {
  private router = inject(Router);
  private route  = inject(ActivatedRoute);
  readonly data  = inject(AdminDataService);
  readonly auth  = inject(AdminAuthService);
  readonly toast = inject(AdminToastService);
  readonly audit = inject(AdminAuditService);
  readonly emailSvc    = inject(AdminEmailService);
  readonly rolesService = inject(AdminRolesService);
  readonly fleetSvc    = inject(AdminFleetService);

  readonly adminRoles: string[]  = ['admin','comptable','superviseur','employe'];
  readonly permKeys    = PERM_KEYS;
  readonly permGroups  = PERM_GROUPS;
  readonly permLabel   = (k: keyof AdminPermissions) => PERM_META[k]?.label ?? k;

  tab = signal<'clients' | 'admins' | 'roles'>('clients');

  ngOnInit(): void {
    const t = this.route.snapshot.queryParamMap.get('tab');
    if (t === 'admins' || t === 'roles' || t === 'clients') this.tab.set(t);
  }

  // ── CLIENTS ───────────────────────────────────────────────────────────────
  clientSearch = signal('');
  clientStatus = signal<'all' | AdminClientUser['status']>('all');
  clientSort   = signal<'name'|'spent'|'bookings'|'date'>('date');

  readonly clientsFiltered = computed(() => {
    const q  = this.clientSearch().toLowerCase();
    const st = this.clientStatus();
    const so = this.clientSort();
    let list = this.data.users().filter(u => {
      if (st !== 'all' && u.status !== st) return false;
      if (q) return `${u.firstName} ${u.lastName} ${u.email} ${u.phone}`.toLowerCase().includes(q);
      return true;
    });
    return [...list].sort((a, b) => {
      if (so === 'spent')    return b.totalSpent - a.totalSpent;
      if (so === 'bookings') return b.bookingCount - a.bookingCount;
      if (so === 'name')     return a.lastName.localeCompare(b.lastName);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  });

  readonly clientStats = computed(() => {
    const us = this.data.users();
    return {
      total:     us.length,
      active:    us.filter(u => u.status==='active').length,
      suspended: us.filter(u => u.status==='suspended').length,
      banned:    us.filter(u => u.status==='banned').length,
      online:    us.filter(u => u.isOnline).length,
    };
  });

  openClient(u: AdminClientUser): void {
    this.router.navigate(['/admin/users/client', u.id]);
  }

  // ── ADMINS ────────────────────────────────────────────────────────────────
  adminSearch = signal('');
  adminRoleF  = signal<string | 'all'>('all');
  showAddModal = signal(false);
  addForm = {
    firstName:'', lastName:'', email:'', role:'employe', busId:'',
    phone:'', mobile:'', department:'', jobTitle:'',
    address:'', city:'', postalCode:'', country:'', bio:'',
  };

  readonly adminsFiltered = computed(() => {
    const q  = this.adminSearch().toLowerCase();
    const rl = this.adminRoleF();
    return this.auth.admins().filter(u => {
      if (rl !== 'all' && u.role !== rl) return false;
      if (q) return `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(q);
      return true;
    });
  });

  openAdmin(u: AdminUser): void {
    this.router.navigate(['/admin/users/admin', u.id]);
  }

  openAdd(): void {
    this.addForm = {
      firstName:'', lastName:'', email:'', role:'employe', busId:'',
      phone:'', mobile:'', department:'', jobTitle:'',
      address:'', city:'', postalCode:'', country:'', bio:'',
      };
    this.showAddModal.set(true);
  }

  /** Lien d'activation à transmettre quand aucun e-mail n'a pu être envoyé. */
  readonly inviteLink = signal<string | null>(null);
  readonly adding = signal(false);
  async submitAdd(): Promise<void> {
    const f = this.addForm;
    if (!f.firstName || !f.lastName || !f.email) { this.toast.error('Champs obligatoires manquants'); return; }
    this.adding.set(true);
    const r = await this.auth.createAdmin({
      firstName: f.firstName, lastName: f.lastName.toUpperCase(), email: f.email, role: f.role,
      phone: f.phone || undefined, mobile: f.mobile || undefined,
      department: f.department || undefined, jobTitle: f.jobTitle || undefined,
      address: f.address || undefined, city: f.city || undefined,
      postalCode: f.postalCode || undefined, country: f.country || undefined, bio: f.bio || undefined,
    });
    this.adding.set(false);
    if (r.error) { this.toast.error(r.error); return; }
    this.toast.success(`Compte ${f.firstName} ${f.lastName.toUpperCase()} créé · invitation envoyée`);
    this.inviteLink.set(r.setPasswordUrl ?? null);
    if (!r.setPasswordUrl) this.showAddModal.set(false);
  }
  copyInvite(): void { const l = this.inviteLink(); if (l) navigator.clipboard?.writeText(l).then(() => this.toast.success('Lien copié'), () => this.toast.error('Copie impossible')); }
  closeAdd(): void { this.showAddModal.set(false); this.inviteLink.set(null); }

  // ── RÔLES ─────────────────────────────────────────────────────────────────
  readonly allRoles = computed(() => this.rolesService.roles());
  selectedRole = signal<string>('admin');
  permsForRole(r: string): AdminPermissions { return this.rolesService.getPermissions(r); }
  permsInGroup(r: string, group: string) {
    return this.permKeys
      .filter(k => PERM_META[k].group === group)
      .map(k => ({ key: k, value: this.rolesService.getPermissions(r)[k] }));
  }
  countPerms(r: string): number { return Object.values(this.rolesService.getPermissions(r)).filter(Boolean).length; }
  adminCountForRole(r: string): number { return this.auth.admins().filter(u => u.role === r).length; }

  // ── Helpers ───────────────────────────────────────────────────────────────
  roleColor(r: string)  { return this.auth.getRoleColor(r); }
  roleLabel(r: string)  { return this.auth.getRoleLabel(r); }
  roleBg(r: string)     { return this.auth.getRoleBg(r); }

  csColor(s: string): string { return s==='active'?'var(--a-green)':s==='suspended'?'var(--a-amber)':'var(--a-red)'; }
  csBg(s: string):    string { return s==='active'?'rgba(16,185,129,.1)':s==='suspended'?'rgba(245,158,11,.1)':'rgba(239,68,68,.1)'; }
  csLabel(s: string): string { return s==='active'?'Actif':s==='suspended'?'Suspendu':'Banni'; }
  initials(u: AdminClientUser): string { return (u.firstName[0]??'')+(u.lastName[0]??''); }
  adminInitials(u: AdminUser):  string { return (u.firstName[0]??'')+(u.lastName[0]??''); }
}
