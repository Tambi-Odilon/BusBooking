import { Injectable, inject, signal, computed } from '@angular/core';
import { AuthService } from './auth.service';
import { SavedBooking } from '../models/user.models';
import { Bus, Passenger, SearchParams } from '../models/booking.models';

const BOOKINGS_KEY = 'soatrans_bookings';

@Injectable({ providedIn: 'root' })
export class UserService {
  private authService = inject(AuthService);

  // Toutes les réservations de l'utilisateur courant
  readonly myBookings = signal<SavedBooking[]>([]);

  readonly upcomingBookings = computed(() =>
    this.myBookings()
      .filter(b => b.status === 'confirmed')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  );

  readonly pastBookings = computed(() =>
    this.myBookings()
      .filter(b => b.status === 'completed' || b.status === 'cancelled')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  );

  constructor() {
    // Charger les réservations au démarrage si une session est active
    const user = this.authService.currentUser();
    if (user) this.loadBookings(user.id);
  }

  // ── Sauvegarde une nouvelle réservation ───────────────────────────────────
  saveBooking(params: {
    reference:     string;
    searchParams:  SearchParams;
    bus:           Bus;
    seats:         string[];
    passengers:    Passenger[];
    total:         number;
    paymentMethod?: string;
  }): void {
    const user = this.authService.currentUser();
    if (!user) return;

    const booking: SavedBooking = {
      id:          this.generateId(),
      userId:      user.id,
      reference:   params.reference,
      createdAt:   new Date().toISOString(),
      status:      'confirmed',
      from:        params.searchParams.from,
      to:          params.searchParams.to,
      date:        params.searchParams.date,
      departure:   params.bus.departure,
      arrival:     params.bus.arrival,
      duration:    params.bus.duration,
      busId:       params.bus.id,
      busName:     params.bus.name,
      busType:     params.bus.type,
      seats:       params.seats,
      passengers:  params.passengers,
      totalAmount: params.total,
      paymentMethod: params.paymentMethod,
    };

    const all = this.loadAllBookings();
    all.push(booking);
    this.saveAllBookings(all);
    this.loadBookings(user.id);
  }

  // ── Annuler une réservation ───────────────────────────────────────────────
  cancelBooking(bookingId: string): void {
    const all = this.loadAllBookings().map(b =>
      b.id === bookingId ? { ...b, status: 'cancelled' as const } : b
    );
    this.saveAllBookings(all);
    const user = this.authService.currentUser();
    if (user) this.loadBookings(user.id);
  }

  // ── Recharger les réservations de l'utilisateur ───────────────────────────
  loadBookings(userId: string): void {
    const all = this.loadAllBookings();
    this.myBookings.set(all.filter(b => b.userId === userId));
  }

  clearBookings(): void {
    this.myBookings.set([]);
  }

  // ── Persistance ───────────────────────────────────────────────────────────
  private loadAllBookings(): SavedBooking[] {
    try {
      const raw = localStorage.getItem(BOOKINGS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  private saveAllBookings(bookings: SavedBooking[]): void {
    localStorage.setItem(BOOKINGS_KEY, JSON.stringify(bookings));
  }

  private generateId(): string {
    return 'bk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
}
