import { Injectable, computed, inject, signal } from '@angular/core';
import { AdminBus, AdminPermissions } from '../models/admin.models';
import { AdminRoutesService } from './admin-routes.service';
import { RemoteStore, clean } from './admin-store';
import { SeatRowDef } from '../../core/models/booking.models';

export interface SeatLayout { id: string; code: string; name: string; capacity: number; rows: SeatRowDef[]; isBuiltin: boolean }
const toBus = (v: any): AdminBus => ({
  id: v.id, ref: v.ref, name: v.name, type: v.type || v.layoutName || '', vehicleLayout: v.vehicleLayout, capacity: v.capacity, status: v.status, plateNumber: v.plateNumber,
  driver: v.driver || '—', totalTrips: v.totalTrips || 0, totalRevenue: v.totalRevenue || 0,
  avgOccupancy: v.totalTrips && v.capacity ? Math.min(100, Math.round(100 * (v.seatsSold || 0) / (v.totalTrips * v.capacity))) : 0,
  lastTrip: v.lastTrip || '—', nextTrip: v.nextTrip || '—', yearBuilt: v.yearBuilt ?? undefined, maintenanceNote: v.maintenanceNote || undefined, layoutId: v.layoutId, amenities: v.amenities || [],
});

/** Flotte de véhicules et plans de sièges. */
@Injectable({ providedIn: 'root' })
export class AdminFleetService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewFleet', 'canViewSeats', 'canViewRoutes', 'canSellWalkin'];
  private routesSvc = inject(AdminRoutesService);

  private readonly _buses = signal<AdminBus[]>([]);
  readonly layouts     = signal<SeatLayout[]>([]);
  readonly buses       = this._buses.asReadonly();
  readonly active      = computed(() => this._buses().filter(b => b.status === 'active'));
  readonly maintenance = computed(() => this._buses().filter(b => b.status === 'maintenance'));
  readonly retired     = computed(() => this._buses().filter(b => b.status === 'retired'));
  readonly stats = computed(() => ({
    total: this._buses().length, active: this.active().length, maintenance: this.maintenance().length, retired: this.retired().length,
    totalCap: this.active().reduce((s, b) => s + b.capacity, 0), totalTrips: this._buses().reduce((s, b) => s + b.totalTrips, 0),
    totalRevenue: this._buses().reduce((s, b) => s + b.totalRevenue, 0),
    avgOcc: Math.round(this.active().reduce((s, b) => s + b.avgOccupancy, 0) / (this.active().length || 1)),
  }));

  protected async fetch(): Promise<void> {
    const [v, layouts] = await Promise.all([this.api.get<{ items: any[] }>('/admin/vehicles', { query: { limit: 200 } }), this.api.get<SeatLayout[]>('/admin/seat-layouts')]);
    this._buses.set(v.items.map(toBus)); this.layouts.set(layouts);
  }
  protected reset(): void { this._buses.set([]); this.layouts.set([]); }
  layoutByCode(code: string): SeatLayout | undefined { return this.layouts().find(l => l.code === code); }
  routesForBus(busId: string) { return this.routesSvc.routes().filter(r => r.assignedBusIds.includes(busId)); }

  add(data: Omit<AdminBus, 'id' | 'ref' | 'totalTrips' | 'totalRevenue' | 'avgOccupancy' | 'lastTrip' | 'nextTrip'>): AdminBus {
    const layout = this.layouts().find(l => l.id === data.layoutId) ?? this.layoutByCode(data.vehicleLayout);
    const created = this.write(() => {
      if (!layout) throw new Error('Plan de sièges inconnu');
      return this.api.post<any>('/admin/vehicles', clean({ name: data.name.trim(), type: data.type || '', layoutId: layout.id, plateNumber: data.plateNumber.trim(), status: data.status,
        yearBuilt: data.yearBuilt || undefined, amenities: data.amenities, maintenanceNote: data.maintenanceNote || undefined }));
    });
    const bus: AdminBus = { ...data, capacity: layout?.capacity ?? data.capacity, id: this.tempId(created), ref: '…', totalTrips: 0, totalRevenue: 0, avgOccupancy: 0, lastTrip: '—', nextTrip: '—' };
    this._buses.update(bs => [...bs, bus]);
    return bus;
  }
  update(id: string, patch: Partial<AdminBus>): void {
    this._buses.update(bs => bs.map(b => b.id === id ? { ...b, ...patch } : b));
    const layoutId = patch.layoutId ?? (patch.vehicleLayout ? this.layoutByCode(patch.vehicleLayout)?.id : undefined);
    const body: any = clean({ name: patch.name, type: patch.type, layoutId, plateNumber: patch.plateNumber, status: patch.status, yearBuilt: patch.yearBuilt, amenities: patch.amenities,
      maintenanceNote: patch.maintenanceNote }, ['maintenanceNote', 'yearBuilt']);
    if ('maintenanceNote' in patch && patch.maintenanceNote === undefined) body.maintenanceNote = null;
    if (Object.keys(body).length) void this.write(async () => this.api.patch(`/admin/vehicles/${await this.real(id)}`, body));
  }
  setStatus(id: string, status: AdminBus['status'], note?: string): void { this.update(id, { status, maintenanceNote: note }); }
  /** Supprime un véhicule sans historique. Le serveur refuse s'il a déjà roulé (le passer en « retiré »). */
  remove(id: string): void {
    this._buses.update(bs => bs.filter(b => b.id !== id));
    void this.write(async () => this.api.delete(`/admin/vehicles/${await this.real(id)}`));
  }
  assignRoutes(busId: string, routeIds: string[]): void {
    void this.write(async () => this.api.patch(`/admin/vehicles/${await this.real(busId)}`, { routeIds }), [this.routesSvc]);
  }
}
