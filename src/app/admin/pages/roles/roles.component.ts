import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminRolesService } from '../../services/admin-roles.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { CustomRole, AdminPermissions, PERM_KEYS, PERM_META, PERM_GROUPS } from '../../models/admin.models';

const PRESET_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#10b981',
  '#06b6d4','#3b82f6','#8b5cf6','#ec4899','#94a3b8',
];

function emptyPerms(): AdminPermissions {
  return Object.fromEntries(PERM_KEYS.map(k => [k, false])) as unknown as AdminPermissions;
}

type ModalType = 'create' | 'edit' | 'delete' | null;

@Component({
  selector: 'app-roles',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './roles.component.html',
})
export class RolesComponent {
  readonly rolesService = inject(AdminRolesService);
  readonly auth         = inject(AdminAuthService);
  readonly toast        = inject(AdminToastService);

  readonly permKeys    = PERM_KEYS;
  readonly permGroups  = PERM_GROUPS;
  readonly permMeta    = PERM_META;
  readonly presetColors  = PRESET_COLORS;
  readonly builtinCount  = () => this.rolesService.roles().filter(r => r.isBuiltin).length;
  readonly customCount   = () => this.rolesService.roles().filter(r => !r.isBuiltin).length;

  // Rôle sélectionné pour édition des permissions inline
  selectedRoleId = signal<string | null>(null);
  readonly selectedRole = computed(() =>
    this.rolesService.roles().find(r => r.id === this.selectedRoleId()) ?? null
  );

  // Copie locale des permissions en cours d'édition
  editingPerms = signal<AdminPermissions | null>(null);
  hasUnsavedChanges = signal(false);

  // Modal
  modal = signal<ModalType>(null);
  modalRole = signal<CustomRole | null>(null);

  // Form nouveau/édition rôle
  roleForm = {
    name: '', description: '', color: '#3b82f6',
  };

  // ── Sélection d'un rôle pour éditer ses permissions ───────────────────────
  selectRole(id: string): void {
    if (this.hasUnsavedChanges()) {
      if (!confirm('Modifications non sauvegardées. Continuer ?')) return;
    }
    if (this.selectedRoleId() === id) {
      this.selectedRoleId.set(null);
      this.editingPerms.set(null);
      this.hasUnsavedChanges.set(false);
      return;
    }
    this.selectedRoleId.set(id);
    const perms = this.rolesService.getPermissions(id);
    this.editingPerms.set({ ...perms });
    this.hasUnsavedChanges.set(false);
  }

  // ── Toggle d'une permission dans le formulaire local ─────────────────────
  togglePerm(key: keyof AdminPermissions): void {
    const current = this.editingPerms();
    if (!current) return;
    const next = { ...current, [key]: !current[key] };

    // Règle Voir → Gérer : si on active Gérer, activer Voir aussi
    const meta = PERM_META[key];
    if (meta.viewKey && next[key]) next[meta.viewKey] = true;
    // Règle Gérer → Voir : si on désactive Voir, désactiver Gérer aussi
    if (meta.manageKey && !next[key]) next[meta.manageKey] = false;

    this.editingPerms.set(next);
    this.hasUnsavedChanges.set(true);
  }

  savePermissions(): void {
    const id = this.selectedRoleId();
    const perms = this.editingPerms();
    if (!id || !perms) return;
    this.rolesService.updatePermissions(id, perms);
    this.hasUnsavedChanges.set(false);
    this.toast.success('Permissions enregistrées');
  }

  discardChanges(): void {
    const id = this.selectedRoleId();
    if (!id) return;
    this.editingPerms.set({ ...this.rolesService.getPermissions(id) });
    this.hasUnsavedChanges.set(false);
  }

  enableAll(): void {
    const all = Object.fromEntries(PERM_KEYS.map(k => [k, true])) as unknown as AdminPermissions;
    this.editingPerms.set(all);
    this.hasUnsavedChanges.set(true);
  }

  disableAll(): void {
    const none = Object.fromEntries(PERM_KEYS.map(k => [k, false])) as unknown as AdminPermissions;
    this.editingPerms.set(none);
    this.hasUnsavedChanges.set(true);
  }

  resetBuiltin(roleId: string): void {
    if (!confirm('Remettre les permissions par défaut ?')) return;
    this.rolesService.resetBuiltinPermissions(roleId);
    if (this.selectedRoleId() === roleId) {
      this.editingPerms.set({ ...this.rolesService.getPermissions(roleId) });
      this.hasUnsavedChanges.set(false);
    }
    this.toast.success('Permissions réinitialisées');
  }

  // ── Modal créer ───────────────────────────────────────────────────────────
  openCreate(): void {
    this.roleForm = { name:'', description:'', color:'#3b82f6' };
    this.modal.set('create');
  }

  submitCreate(): void {
    if (!this.roleForm.name.trim()) { this.toast.error('Nom obligatoire'); return; }
    const created = this.rolesService.createRole({
      name: this.roleForm.name,
      description: this.roleForm.description,
      color: this.roleForm.color,
      permissions: emptyPerms(),
    });
    this.toast.success(`Rôle "${created.name}" créé`);
    this.modal.set(null);
    // Sélectionner immédiatement le nouveau rôle pour configurer ses perms
    this.selectRole(created.id);
  }

  // ── Modal éditer métadonnées ──────────────────────────────────────────────
  openEdit(role: CustomRole, e?: Event): void {
    e?.stopPropagation();
    this.roleForm = { name: role.name, description: role.description, color: role.color };
    this.modalRole.set(role);
    this.modal.set('edit');
  }

  submitEdit(): void {
    const r = this.modalRole()!;
    if (!this.roleForm.name.trim()) { this.toast.error('Nom obligatoire'); return; }
    this.rolesService.updateRole(r.id, {
      name: this.roleForm.name,
      description: this.roleForm.description,
      color: this.roleForm.color,
    });
    this.toast.success('Rôle mis à jour');
    this.modal.set(null);
  }

  // ── Modal supprimer ───────────────────────────────────────────────────────
  openDelete(role: CustomRole, e?: Event): void {
    e?.stopPropagation();
    this.modalRole.set(role);
    this.modal.set('delete');
  }

  confirmDelete(): void {
    const r = this.modalRole()!;
    const usersWithRole = this.auth.admins().filter(u => u.role === r.id).length;
    if (usersWithRole > 0) {
      this.toast.error(`Impossible : ${usersWithRole} compte(s) utilise(nt) ce rôle`);
      this.modal.set(null);
      return;
    }
    this.rolesService.deleteRole(r.id);
    if (this.selectedRoleId() === r.id) {
      this.selectedRoleId.set(null);
      this.editingPerms.set(null);
    }
    this.toast.warn(`Rôle "${r.name}" supprimé`);
    this.modal.set(null);
  }

  closeModal(): void { this.modal.set(null); }

  // ── Helpers ───────────────────────────────────────────────────────────────
  permsInGroup(group: string, perms: AdminPermissions): Array<{ key: keyof AdminPermissions; value: boolean }> {
    return PERM_KEYS
      .filter(k => PERM_META[k].group === group)
      .map(k => ({ key: k, value: perms[k] }));
  }

  groupEnabled(group: string, perms: AdminPermissions): boolean {
    return PERM_KEYS.filter(k => PERM_META[k].group === group).some(k => perms[k]);
  }

  usersForRole(roleId: string): number {
    return this.auth.admins().filter(u => u.role === roleId).length;
  }

  countEnabled(perms: AdminPermissions): number {
    return Object.values(perms).filter(Boolean).length;
  }

  countEnabledInGroup(group: string, perms: AdminPermissions): number {
    return PERM_KEYS.filter(k => PERM_META[k].group === group && perms[k]).length;
  }

  hasCustomRoles(): boolean {
    return this.rolesService.roles().some(r => !r.isBuiltin);
  }

  canEdit(role: CustomRole): boolean {
    // Admin builtin ne peut pas être édité (protection)
    return role.id !== 'admin';
  }

  roleColor(id: string): string { return this.auth.getRoleColor(id); }
}
