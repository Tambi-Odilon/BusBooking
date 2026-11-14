import { Injectable, computed, signal } from '@angular/core';
import { AdminPermissions, AdminRoute } from '../models/admin.models';
import { RemoteStore, clean } from './admin-store';

export interface AdminCity { id: string; name: string; region: string | null; stationAddress: string | null; isActive: boolean }
const toRoute = (r: any): AdminRoute => ({
  id: r.id, from: r.fromCity, to: r.toCity, distanceKm: r.distanceKm, durationMin: r.durationMin, basePrice: r.basePrice,
  priceByLayout: r.priceByLayout || {}, durationByLayout: r.durationByLayout || {}, status: r.status, assignedBusIds: r.assignedVehicleIds || [],
  totalTrips: r.totalTrips || 0, totalRevenue: r.totalRevenue || 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
  notes: r.notes || undefined, suspendReason: r.suspendReason || undefined, suspendedUntil: r.suspendedUntil || undefined,
});
const dropEmpty = (o?: Record<string, number | undefined>) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === 'number' && v > 0));

/** Itinéraires et villes desservies. */
@Injectable({ providedIn: 'root' })
export class AdminRoutesService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewRoutes', 'canSellWalkin', 'canViewSeats'];
  private readonly _routes = signal<AdminRoute[]>([]);
  readonly cities = signal<AdminCity[]>([]);

  readonly routes    = this._routes.asReadonly();
  readonly active    = computed(() => this._routes().filter(r => r.status === 'active'));
  readonly suspended = computed(() => this._routes().filter(r => r.status === 'suspended'));
  readonly deleted   = computed(() => this._routes().filter(r => r.status === 'deleted'));
  readonly stats = computed(() => {
    const all = this._routes();
    return { total: all.length, active: this.active().length, suspended: this.suspended().length, deleted: this.deleted().length,
      totalRevenue: all.reduce((s, r) => s + r.totalRevenue, 0), totalTrips: all.reduce((s, r) => s + r.totalTrips, 0) };
  });

  protected async fetch(): Promise<void> {
    const [routes, cities] = await Promise.all([
      this.api.get<{ items: any[] }>('/admin/routes', { query: { limit: 200, includeDeleted: true } }),
      this.api.get<AdminCity[]>('/admin/cities').catch(() => [] as AdminCity[]),
    ]);
    this._routes.set(routes.items.map(toRoute)); this.cities.set(cities);
  }
  protected reset(): void { this._routes.set([]); this.cities.set([]); }

  add(data: Omit<AdminRoute, 'id' | 'createdAt' | 'updatedAt' | 'totalTrips' | 'totalRevenue'>): AdminRoute {
    const now = new Date().toISOString();
    const created = this.write(() => this.api.post<any>('/admin/routes', clean({ fromCity: data.from.trim(), toCity: data.to.trim(), distanceKm: Math.round(data.distanceKm || 0),
      durationMin: Math.round(data.durationMin), basePrice: Math.round(data.basePrice), priceByLayout: dropEmpty(data.priceByLayout), durationByLayout: dropEmpty(data.durationByLayout),
      notes: data.notes || undefined, vehicleIds: data.assignedBusIds?.length ? data.assignedBusIds : undefined })));
    const route: AdminRoute = { ...data, id: this.tempId(created), totalTrips: 0, totalRevenue: 0, createdAt: now, updatedAt: now };
    this._routes.update(rs => [...rs, route]);
    return route;
  }
  update(id: string, patch: Partial<AdminRoute>): void {
    this._routes.update(rs => rs.map(r => r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r));
    const body: any = clean({ fromCity: patch.from, toCity: patch.to, distanceKm: patch.distanceKm, durationMin: patch.durationMin, basePrice: patch.basePrice,
      priceByLayout: patch.priceByLayout && dropEmpty(patch.priceByLayout), durationByLayout: patch.durationByLayout && dropEmpty(patch.durationByLayout),
      notes: patch.notes, vehicleIds: patch.assignedBusIds }, ['notes']);
    if (Object.keys(body).length) void this.write(async () => this.api.patch(`/admin/routes/${await this.real(id)}`, body));
  }
  suspend(id: string, reason: string, until?: string): void {
    this._routes.update(rs => rs.map(r => r.id === id ? { ...r, status: 'suspended', suspendReason: reason, suspendedUntil: until } : r));
    void this.write(async () => this.api.post(`/admin/routes/${await this.real(id)}/suspend`, clean({ reason, until: until || undefined })));
  }
  reactivate(id: string): void {
    this._routes.update(rs => rs.map(r => r.id === id ? { ...r, status: 'active', suspendReason: undefined, suspendedUntil: undefined } : r));
    void this.write(async () => this.api.post(`/admin/routes/${await this.real(id)}/reactivate`));
  }
  softDelete(id: string): void {
    this._routes.update(rs => rs.map(r => r.id === id ? { ...r, status: 'deleted' } : r));
    void this.write(async () => this.api.delete(`/admin/routes/${await this.real(id)}`));
  }
  restore(id: string): void { this.reactivate(id); }
  hardDelete(id: string): void {
    this._routes.update(rs => rs.filter(r => r.id !== id));
    void this.write(async () => this.api.delete(`/admin/routes/${await this.real(id)}`, { query: { hard: true } }));
  }

  formatDuration(min: number): string { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`; }
  isSuspensionExpired(route: AdminRoute): boolean { return !!route.suspendedUntil && new Date(route.suspendedUntil) < new Date(); }
  daysUntilReactivation(route: AdminRoute): number | null {
    if (!route.suspendedUntil) return null;
    return Math.max(0, Math.ceil((new Date(route.suspendedUntil).getTime() - Date.now()) / 86400000));
  }
}
