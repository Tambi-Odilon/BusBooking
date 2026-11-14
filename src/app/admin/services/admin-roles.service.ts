import { Injectable, computed, signal } from '@angular/core';
import { AdminPermissions, CustomRole, PERM_KEYS, BUILTIN_ROLE_PERMISSIONS } from '../models/admin.models';
import { RemoteStore } from './admin-store';

function emptyPerms(): AdminPermissions { return Object.fromEntries(PERM_KEYS.map(k => [k, false])) as unknown as AdminPermissions; }
const toRole = (r: any): CustomRole => ({ id: r.slug, uuid: r.id, name: r.name, description: r.description || '', permissions: { ...emptyPerms(), ...r.permissions },
  color: r.color, isBuiltin: r.isBuiltin, createdAt: r.createdAt, updatedAt: r.updatedAt, userCount: r.userCount });

/** Rôles et permissions. Enregistrés et appliqués par le serveur ; un changement prend effet immédiatement pour les comptes concernés. */
@Injectable({ providedIn: 'root' })
export class AdminRolesService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewSettings', 'canViewUsers', 'canManageUsers'];
  private readonly _roles = signal<CustomRole[]>([]);
  readonly roles = computed<CustomRole[]>(() => this._roles());

  protected async fetch(): Promise<void> { this._roles.set((await this.api.get<any[]>('/admin/roles')).map(toRole)); }
  protected reset(): void { this._roles.set([]); }
  private uuid(roleId: string): string { return this._roles().find(r => r.id === roleId)?.uuid ?? roleId; }

  getPermissions(roleId: string): AdminPermissions { return this._roles().find(r => r.id === roleId)?.permissions ?? emptyPerms(); }
  hasPermission(roleId: string, perm: keyof AdminPermissions): boolean { return this.getPermissions(roleId)[perm] ?? false; }

  updatePermissions(roleId: string, perms: AdminPermissions): void {
    const uuid = this.uuid(roleId);
    this._roles.update(l => l.map(r => r.id === roleId ? { ...r, permissions: { ...perms } } : r));
    void this.write(() => this.api.patch(`/admin/roles/${uuid}`, { permissions: perms })).then(() => this.session.reloadMe());
  }
  togglePermission(roleId: string, perm: keyof AdminPermissions): void {
    const current = this.getPermissions(roleId);
    this.updatePermissions(roleId, { ...current, [perm]: !current[perm] });
  }
  createRole(data: { name: string; description: string; color: string; permissions: AdminPermissions }): CustomRole {
    const now = new Date().toISOString();
    const role: CustomRole = { id: 'tmp-' + Date.now(), name: data.name.trim(), description: data.description.trim(), permissions: { ...data.permissions }, color: data.color, isBuiltin: false, createdAt: now, updatedAt: now };
    this._roles.update(l => [...l, role]);
    void this.write(() => this.api.post('/admin/roles', { name: role.name, description: role.description || undefined, color: role.color, permissions: role.permissions }));
    return role;
  }
  updateRole(id: string, data: Partial<{ name: string; description: string; color: string }>): void {
    const uuid = this.uuid(id);
    this._roles.update(l => l.map(r => r.id === id ? { ...r, ...data } : r));
    void this.write(() => this.api.patch(`/admin/roles/${uuid}`, data));
  }
  deleteRole(id: string): boolean {
    const role = this._roles().find(r => r.id === id);
    if (!role || role.isBuiltin) return false;
    if ((role.userCount ?? 0) > 0) { this.toast.error(`Ce rôle est encore attribué à ${role.userCount} compte(s). Changez d'abord leur rôle.`); return false; }
    this._roles.update(l => l.filter(r => r.id !== id));
    void this.write(() => this.api.delete(`/admin/roles/${role.uuid}`));
    return true;
  }
  resetBuiltinPermissions(roleId: string): void {
    const uuid = this.uuid(roleId);
    if (BUILTIN_ROLE_PERMISSIONS[roleId]) this._roles.update(l => l.map(r => r.id === roleId ? { ...r, permissions: { ...BUILTIN_ROLE_PERMISSIONS[roleId] } } : r));
    void this.write(() => this.api.post(`/admin/roles/${uuid}/reset`)).then(() => this.session.reloadMe());
  }
  /** Vrai si un rôle intégré ne correspond plus à ses permissions d'origine. */
  isModified(roleId: string): boolean {
    const def = BUILTIN_ROLE_PERMISSIONS[roleId];
    if (!def) return false;
    const cur = this.getPermissions(roleId);
    return PERM_KEYS.some(k => !!cur[k] !== !!def[k]);
  }
  countPerms(roleId: string): number { return Object.values(this.getPermissions(roleId)).filter(Boolean).length; }
}
