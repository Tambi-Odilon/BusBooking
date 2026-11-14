import { Injectable, computed, inject, signal } from '@angular/core';
import { AdminBooking, AdminClientUser, AdminPermissions, DashboardStats, OnlineActivity, RevenuePoint, RouteRevenue } from '../models/admin.models';
import { RemoteStore } from './admin-store';
import { Page, errorMessage } from '../../core/api/api.service';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { ApiBooking } from '../../core/models/booking.models';

const BOOKING_STATUS: Record<string, AdminBooking['status']> = { pending_payment: 'pending', confirmed: 'confirmed', cancelled: 'cancelled', expired: 'cancelled', completed: 'completed', no_show: 'completed' };
const PAY_STATUS: Record<string, AdminBooking['paymentStatus']> = { paid: 'paid', refunded: 'refunded', partially_refunded: 'refunded', refund_pending: 'refunded' };
/** Heure locale « HH:mm » d'un instant, dans le fuseau donné. */
export function localTime(isoDate: string | null | undefined, timeZone: string): string {
  if (!isoDate) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(isoDate)); } catch { return ''; }
}
export const toAdminBooking = (b: any): AdminBooking => ({
  id: b.id, reference: b.reference, createdAt: b.createdAt, userId: b.customerId || '', userName: b.contactName || '', userEmail: b.contactEmail || undefined, phone: b.contactPhone || '',
  from: b.fromCity, to: b.toCity, date: b.serviceDate, departure: b.departureAt, busName: b.vehicleName, tripId: b.tripId, seats: b.seats || [], passengerCount: (b.seats || []).length,
  totalAmount: b.total, status: BOOKING_STATUS[b.status] ?? 'pending', paymentMethod: b.paymentMethod || (b.channel === 'counter' ? 'cash' : ''),
  paymentStatus: PAY_STATUS[b.paymentStatus] ?? 'pending', channel: b.channel, needsAttention: !!b.needsAttention, soldByName: b.soldByName || undefined,
});
export const toClient = (u: any): AdminClientUser => ({
  id: u.id, email: u.email || '', firstName: u.firstName || '', lastName: u.lastName || '', phone: u.phone || '', gender: u.gender || '', createdAt: u.createdAt, lastActive: u.lastActive || u.createdAt,
  isOnline: false, totalSpent: Number(u.totalSpent || 0), bookingCount: u.bookingCount || 0, status: u.status, notes: u.notes || undefined,
});
const EMPTY_STATS: DashboardStats & Record<string, number> = { todayRevenue: 0, monthRevenue: 0, totalRevenue: 0, todayBookings: 0, monthBookings: 0, totalBookings: 0, activeUsers: 0, totalUsers: 0,
  totalSeats: 0, availableSeats: 0, pendingSeats: 0, occupancyRate: 0, revenueGrowth: 0, bookingsGrowth: 0, cancelRate: 0, pendingBookings: 0, needsAttention: 0, manualRefunds: 0, pendingRefunds: 0, tripsToday: 0, bookedSeats: 0 };
export interface BookingQuery { search?: string; status?: string; channel?: string; from?: string; to?: string; tripId?: string; attention?: boolean; page?: number; limit?: number }
export interface Refund { id: string; bookingId: string; reference: string; amount: number; currency: string; reason: string | null; status: string; method: string; payerPhone: string | null; contactName: string; createdAt: string; processedAt: string | null }

/**
 * Données de pilotage du back-office : indicateurs, réservations, clients, chiffre d'affaires, remboursements.
 * Tout est calculé par le serveur à partir des ventes réelles ; les listes sont paginées.
 */
@Injectable({ providedIn: 'root' })
export class AdminDataService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewDashboard', 'canViewBookings', 'canViewRevenue', 'canViewUsers'];
  private realtime = inject(RealtimeService);

  private readonly _bookings = signal<AdminBooking[]>([]);
  private readonly _users    = signal<AdminClientUser[]>([]);
  private readonly _revenue  = signal<RevenuePoint[]>([]);
  private readonly _stats    = signal<DashboardStats & Record<string, number>>(EMPTY_STATS);
  private readonly _activity = signal<AdminBooking[]>([]);

  /** Les 100 réservations les plus récentes (les écrans de liste interrogent le serveur page par page). */
  readonly bookings = this._bookings.asReadonly();
  readonly bookingsTotal = signal(0);
  readonly users    = this._users.asReadonly();
  readonly usersTotal = signal(0);
  readonly revenue  = this._revenue.asReadonly();
  readonly stats    = this._stats.asReadonly();
  readonly routeRevenues = signal<RouteRevenue[]>([]);
  readonly revenueByMethod = signal<{ method: string; collected: number; refunded: number; payments: number }[]>([]);
  readonly revenueByChannel = signal<{ channel: string; revenue: number; bookings: number }[]>([]);
  readonly onlineActivity = computed<OnlineActivity[]>(() => this._activity().slice(0, 12).map(b => ({
    userId: b.userId, userName: b.userName || 'Client', action: b.channel === 'counter' ? 'Vente au guichet' : 'Réservation en ligne', page: `${b.from} → ${b.to}`, timestamp: b.createdAt })));
  readonly recentBookings = this._activity.asReadonly();

  constructor() {
    super();
    for (const ev of ['booking.created', 'booking.updated', 'booking.confirmed', 'booking.cancelled', 'dashboard.tick', 'alert'])
      this.realtime.on(ev, () => { if (this.session.user() && this.allowed()) this.scheduleReload(900); });
  }

  protected async fetch(): Promise<void> {
    const can = (p: keyof AdminPermissions) => this.session.can(p);
    const quiet = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const [stats, activity, bookings, users, revenue] = await Promise.all([
      can('canViewDashboard') ? this.api.get<any>('/admin/dashboard') : Promise.resolve(null),
      can('canViewDashboard') ? quiet(this.api.get<any[]>('/admin/activity'), []) : Promise.resolve([]),
      can('canViewBookings') ? this.api.get<Page<any>>('/admin/bookings', { query: { limit: 100 } }) : Promise.resolve(null),
      can('canViewUsers') ? quiet(this.api.get<Page<any>>('/admin/customers', { query: { limit: 100 } }), null) : Promise.resolve(null),
      can('canViewRevenue') ? quiet(this.api.get<any>('/admin/reports/revenue', { query: { days: 90 } }), null) : Promise.resolve(null),
    ]);
    if (stats) this._stats.set({ ...EMPTY_STATS, ...stats });
    this._activity.set((activity || []).map(toAdminBooking));
    if (bookings) { this._bookings.set(bookings.items.map(toAdminBooking)); this.bookingsTotal.set(bookings.total); }
    if (users) { this._users.set(users.items.map(toClient)); this.usersTotal.set(users.total); }
    if (revenue) {
      this._revenue.set(revenue.daily);
      this.routeRevenues.set((revenue.byRoute as any[]).map(r => ({ from: r.fromCity, to: r.toCity, revenue: r.revenue, bookings: r.bookings })));
      this.revenueByMethod.set(revenue.byMethod || []); this.revenueByChannel.set(revenue.byChannel || []);
    }
  }
  protected reset(): void { this._bookings.set([]); this._users.set([]); this._revenue.set([]); this._stats.set(EMPTY_STATS); this._activity.set([]); this.routeRevenues.set([]); }

  // ── Réservations ──────────────────────────────────────────────────────────
  async searchBookings(q: BookingQuery): Promise<Page<AdminBooking>> {
    const r = await this.api.get<Page<any>>('/admin/bookings', { query: { ...q, attention: q.attention ? 'true' : undefined } });
    return { ...r, items: r.items.map(toAdminBooking) };
  }
  bookingDetail(id: string): Promise<ApiBooking> { return this.api.get<ApiBooking>(`/admin/bookings/${id}`); }
  /** Annulation par le personnel : remboursement selon la politique, ou pourcentage imposé. Renvoie un message d'erreur ou null. */
  async cancelBooking(id: string, o: { reason?: string; refundPercent?: number; passengerIds?: string[] } = {}): Promise<string | null> {
    try { await this.api.post(`/admin/bookings/${id}/cancel`, o); this.scheduleReload(0); return null; } catch (e) { return errorMessage(e); }
  }
  async markNoShow(id: string, passengerIds?: string[]): Promise<string | null> {
    try { await this.api.post(`/admin/bookings/${id}/no-show`, passengerIds ? { passengerIds } : {}); this.scheduleReload(0); return null; } catch (e) { return errorMessage(e); }
  }
  async resolveAttention(id: string): Promise<string | null> {
    try { await this.api.post(`/admin/bookings/${id}/resolve`, {}); this.scheduleReload(0); return null; } catch (e) { return errorMessage(e); }
  }
  updateBookingStatus(id: string, status: AdminBooking['status']): void {
    if (status !== 'cancelled') return;
    this._bookings.update(l => l.map(b => b.id === id ? { ...b, status: 'cancelled' } : b));
    void this.cancelBooking(id).then(err => { if (err) { this.toast.error(err); this.scheduleReload(0); } });
  }

  // ── Clients ───────────────────────────────────────────────────────────────
  async searchClients(search: string, page = 1, limit = 25, status = ''): Promise<Page<AdminClientUser>> {
    const r = await this.api.get<Page<any>>('/admin/customers', { query: { search, page, limit, status } });
    return { ...r, items: r.items.map(toClient) };
  }
  /** Fiche complète d'un client, avec ses réservations. */
  async client(id: string): Promise<{ client: AdminClientUser; bookings: AdminBooking[] } | null> {
    try {
      const u = await this.api.get<any>(`/admin/customers/${id}`);
      const bookings: AdminBooking[] = (u.bookings || []).map((b: any) => toAdminBooking({ ...b, contactName: `${u.firstName} ${u.lastName}`, contactEmail: u.email, contactPhone: u.phone, customerId: u.id,
        paymentStatus: ['confirmed', 'completed', 'no_show'].includes(b.status) ? 'paid' : b.status === 'cancelled' ? 'refunded' : 'pending' }));
      const spent = bookings.filter(b => b.status === 'confirmed' || b.status === 'completed').reduce((s, b) => s + b.totalAmount, 0);
      return { client: { ...toClient(u), bookingCount: bookings.length, totalSpent: spent }, bookings };
    } catch { return null; }
  }
  updateUserStatus(id: string, status: AdminClientUser['status']): void { this.updateUser(id, { status }); }
  updateUser(id: string, patch: Partial<Pick<AdminClientUser, 'firstName' | 'lastName' | 'email' | 'phone' | 'notes' | 'status'>>): void {
    this._users.update(l => l.map(u => u.id === id ? { ...u, ...patch } : u));
    const body: any = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && !(k !== 'notes' && v === '')) body[k] = v;
    void this.write(() => this.api.patch(`/admin/customers/${id}`, body));
  }
  /** Droit à l'effacement : les données personnelles sont anonymisées, les billets et la comptabilité sont conservés. */
  async anonymizeClient(id: string): Promise<string | null> {
    try { await this.api.delete(`/admin/customers/${id}`); this.scheduleReload(0); return null; } catch (e) { return errorMessage(e); }
  }
  /** Client connu par son téléphone ou son e-mail (guichet). */
  async findClient(term: string): Promise<AdminClientUser | null> {
    const t = term.trim();
    if (t.length < 4) return null;
    try { const r = await this.searchClients(t, 1, 5); return r.items[0] ?? null; } catch { return null; }
  }

  // ── Finances ──────────────────────────────────────────────────────────────
  getRevenueLast(n: number): RevenuePoint[] { return this._revenue().slice(-n); }
  async exportCsv(from: string, to: string): Promise<void> {
    const blob = await this.api.get<Blob>('/admin/reports/export.csv', { query: { from, to }, blob: true });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `encaissements-${from}-${to}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async refunds(status = '', page = 1): Promise<Page<Refund>> { return this.api.get<Page<Refund>>('/admin/refunds', { query: { status, page, limit: 25 } }); }
  async markRefundDone(id: string, providerRef?: string): Promise<string | null> {
    try { await this.api.post(`/admin/refunds/${id}/mark-done`, providerRef ? { providerRef } : {}); this.scheduleReload(0); return null; } catch (e) { return errorMessage(e); }
  }
}
