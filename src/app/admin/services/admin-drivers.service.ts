import { Injectable, computed, inject, signal } from '@angular/core';
import { AdminDriver, AdminPermissions, DriverStatus } from '../models/admin.models';
import { AdminFleetService } from './admin-fleet.service';
import { RemoteStore, clean } from './admin-store';

const toDriver = (d: any): AdminDriver => ({
  id: d.id, firstName: d.firstName, lastName: d.lastName, phone: d.phone || '', email: d.email || undefined, licenseNumber: d.licenseNumber, licenseClass: d.licenseClass,
  licenseExpiry: d.licenseExpiry || '', status: d.status, assignedBusId: d.defaultVehicleId || undefined, totalTrips: d.totalTrips || 0, totalKm: d.totalKm || 0, avgRating: 0,
  hiredAt: d.hiredAt || '', birthDate: d.birthDate || '', address: d.address || undefined, notes: d.notes || undefined, leaveUntil: d.leaveUntil || undefined, leaveReason: d.leaveReason || undefined, userId: d.userId || undefined,
});
const NULLABLE = ['email', 'licenseExpiry', 'leaveUntil', 'leaveReason', 'defaultVehicleId', 'hiredAt', 'birthDate', 'address', 'notes', 'userId'];
const toBody = (p: Partial<AdminDriver>) => clean({ firstName: p.firstName, lastName: p.lastName, phone: p.phone, email: p.email, licenseNumber: p.licenseNumber, licenseClass: p.licenseClass,
  licenseExpiry: p.licenseExpiry, status: p.status, leaveUntil: p.leaveUntil, leaveReason: p.leaveReason, hiredAt: p.hiredAt, birthDate: p.birthDate, address: p.address, notes: p.notes, userId: p.userId }, NULLABLE);

/** Chauffeurs : fiches, statut (actif, congé, suspendu), véhicule habituel. */
@Injectable({ providedIn: 'root' })
export class AdminDriversService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewDrivers', 'canViewRoutes'];
  private fleetSvc = inject(AdminFleetService);

  private readonly _drivers = signal<AdminDriver[]>([]);
  readonly drivers   = this._drivers.asReadonly();
  readonly active    = computed(() => this._drivers().filter(d => d.status === 'active'));
  readonly onLeave   = computed(() => this._drivers().filter(d => d.status === 'leave'));
  readonly suspended = computed(() => this._drivers().filter(d => d.status === 'suspended'));
  readonly resigned  = computed(() => this._drivers().filter(d => d.status === 'resigned'));
  readonly stats = computed(() => ({
    total: this._drivers().length, active: this.active().length, leave: this.onLeave().length, suspended: this.suspended().length, resigned: this.resigned().length,
    assigned: this._drivers().filter(d => d.assignedBusId).length, totalTrips: this._drivers().reduce((s, d) => s + d.totalTrips, 0),
    totalKm: this._drivers().reduce((s, d) => s + d.totalKm, 0), avgRating: 0,
  }));

  protected async fetch(): Promise<void> { this._drivers.set((await this.api.get<{ items: any[] }>('/admin/drivers', { query: { limit: 200 } })).items.map(toDriver)); }
  protected reset(): void { this._drivers.set([]); }

  busOf(driverId: string) {
    const d = this._drivers().find(x => x.id === driverId);
    return d?.assignedBusId ? this.fleetSvc.buses().find(b => b.id === d.assignedBusId) ?? null : null;
  }
  driverOfBus(busId: string) { return this._drivers().find(d => d.assignedBusId === busId) ?? null; }

  add(data: Omit<AdminDriver, 'id' | 'totalTrips' | 'totalKm' | 'avgRating'>): AdminDriver {
    const created = this.write(() => this.api.post<any>('/admin/drivers', { ...toBody(data), defaultVehicleId: data.assignedBusId || undefined }), [this.fleetSvc]);
    const driver: AdminDriver = { ...data, id: this.tempId(created), totalTrips: 0, totalKm: 0, avgRating: 0 };
    this._drivers.update(ds => [...ds, driver]);
    return driver;
  }
  update(id: string, patch: Partial<AdminDriver>): void {
    this._drivers.update(ds => ds.map(d => d.id === id ? { ...d, ...patch } : d));
    const body: any = toBody(patch);
    if ('assignedBusId' in patch) body.defaultVehicleId = patch.assignedBusId || null;
    if (Object.keys(body).length) void this.write(async () => this.api.patch(`/admin/drivers/${await this.real(id)}`, body), [this.fleetSvc]);
  }
  setStatus(id: string, status: DriverStatus, extra?: { leaveUntil?: string; leaveReason?: string; notes?: string }): void {
    this.update(id, { status, ...(status === 'leave' ? {} : { leaveUntil: '', leaveReason: '' }), ...extra });
  }
  assignBus(driverId: string, busId: string | null): void {
    // un véhicule n'a qu'un chauffeur habituel : le précédent est libéré
    if (busId) { const prev = this.driverOfBus(busId); if (prev && prev.id !== driverId) this.update(prev.id, { assignedBusId: undefined }); }
    this.update(driverId, { assignedBusId: busId ?? undefined });
  }
  remove(id: string): void {
    this._drivers.update(ds => ds.filter(d => d.id !== id));
    void this.write(async () => this.api.delete(`/admin/drivers/${await this.real(id)}`), [this.fleetSvc]);
  }
  isLicenseExpiringSoon(d: AdminDriver): boolean {
    if (!d.licenseExpiry) return false;
    const days = (new Date(d.licenseExpiry).getTime() - Date.now()) / 86400000;
    return days >= 0 && days <= 60;
  }
  isLicenseExpired(d: AdminDriver): boolean { return !!d.licenseExpiry && new Date(d.licenseExpiry) < new Date(); }
  daysUntilLeaveEnd(d: AdminDriver): number | null { return d.leaveUntil ? Math.max(0, Math.ceil((new Date(d.leaveUntil).getTime() - Date.now()) / 86400000)) : null; }
  fullName(d: AdminDriver): string { return `${d.firstName} ${d.lastName}`; }
}
