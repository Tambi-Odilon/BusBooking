import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { ApiService, Page, errorMessage } from '../api/api.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SavedBooking } from '../models/user.models';
import { ApiBooking } from '../models/booking.models';

export function toSavedBooking(b: ApiBooking): SavedBooking {
  const status: SavedBooking['status'] = b.status === 'pending_payment' ? 'pending' : b.status === 'no_show' ? 'completed' : b.status;
  return {
    id: b.id, userId: (b as any).customerId ?? '', reference: b.reference, createdAt: b.createdAt, status,
    from: b.trip.fromCity, to: b.trip.toCity, date: b.trip.serviceDate, departure: b.trip.departure, arrival: b.trip.arrival, duration: b.trip.duration,
    busId: b.trip.tripId, busName: b.trip.vehicleName, busType: b.trip.vehicleType || '',
    seats: b.seats,
    passengers: b.passengers.map(p => ({ firstName: p.firstName, lastName: p.lastName, phone: p.phone || '', gender: p.gender, seatNumber: p.seatNo, ticketNumber: p.ticketNumber, status: p.status })),
    totalAmount: b.total, paymentMethod: b.payment.method ?? undefined, paymentStatus: b.payment.status,
    canCancel: b.canCancel, canChange: b.canChange, accessToken: b.accessToken, refundPendingAmount: b.payment.refundPendingAmount, refundedAmount: b.payment.refundedAmount,
  };
}

/** Historique des réservations du client connecté (lu sur le serveur, paginé). */
@Injectable({ providedIn: 'root' })
export class UserService {
  private auth = inject(AuthService);
  private api = inject(ApiService);
  private realtime = inject(RealtimeService);

  readonly myBookings = signal<SavedBooking[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private page = 1;
  readonly hasMore = computed(() => this.myBookings().length < this.total());

  readonly upcomingBookings = computed(() => this.myBookings().filter(b => b.status === 'confirmed' || b.status === 'pending'));
  readonly pastBookings = computed(() => this.myBookings().filter(b => b.status === 'completed' || b.status === 'cancelled' || b.status === 'expired'));

  constructor() {
    effect(() => { if (this.auth.currentUser()) this.loadBookings(); else this.clearBookings(); });
    for (const ev of ['booking.confirmed', 'booking.cancelled', 'booking.updated', 'payment.updated'])
      this.realtime.on(ev, () => { if (this.auth.currentUser()) this.loadBookings(); });
  }
  async loadBookings(_userId?: string): Promise<void> {
    this.loading.set(true);
    try {
      const r = await this.api.get<Page<ApiBooking>>('/bookings/mine', { query: { page: 1, limit: 20 }, scope: 'customer' });
      this.myBookings.set(r.items.map(toSavedBooking)); this.total.set(r.total); this.page = 1; this.error.set(null);
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }
  async loadMore(): Promise<void> {
    if (!this.hasMore() || this.loading()) return;
    this.loading.set(true);
    try {
      const r = await this.api.get<Page<ApiBooking>>('/bookings/mine', { query: { page: this.page + 1, limit: 20 }, scope: 'customer' });
      this.myBookings.update(list => [...list, ...r.items.map(toSavedBooking)]); this.total.set(r.total); this.page++;
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }
  /** Annulation selon la politique de la société (délai, remboursement). Renvoie un message d'erreur, ou null si tout s'est bien passé. */
  async cancelBooking(bookingId: string): Promise<string | null> {
    const b = this.myBookings().find(x => x.id === bookingId);
    if (!b) return 'Réservation introuvable';
    try { await this.api.post(`/bookings/${b.reference}/cancel`, {}, { scope: 'customer' }); await this.loadBookings(); return null; }
    catch (e) { return errorMessage(e); }
  }
  clearBookings(): void { this.myBookings.set([]); this.total.set(0); }
}
