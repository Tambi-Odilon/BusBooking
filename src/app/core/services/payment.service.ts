import { Injectable, inject } from '@angular/core';
import { ApiService, newKey } from '../api/api.service';
import { RealtimeService } from '../realtime/realtime.service';
import { BookingService } from './booking.service';
import { ApiBooking, ApiPayment, Passenger } from '../models/booking.models';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export type PaymentOutcome = { result: 'confirmed'; booking: ApiBooking } | { result: 'failed'; reason: string } | { result: 'refunded'; booking: ApiBooking } | { result: 'timeout' };

/**
 * Réservation et paiement. Tout se passe côté serveur : le navigateur n'appelle jamais un opérateur de paiement
 * et ne connaît aucune clé. Le montant est calculé par le serveur.
 */
@Injectable({ providedIn: 'root' })
export class PaymentService {
  private api = inject(ApiService);
  private realtime = inject(RealtimeService);
  private flow = inject(BookingService);
  private headers(b: ApiBooking | null): Record<string, string> { return b?.accessToken ? { 'x-booking-token': b.accessToken } : {}; }

  /** Crée la réservation à partir du verrou. La même clé est réutilisée tant que le parcours est le même (double clic, rafraîchissement). */
  async createBooking(tripId: string, holdToken: string, passengers: Passenger[], contact: { name: string; phone: string; email?: string }, lang: string): Promise<ApiBooking> {
    const existing = this.flow.booking();
    if (existing && existing.status === 'pending_payment' && existing.trip.tripId === tripId
      && [...existing.seats].sort().join() === passengers.map(p => p.seatNumber).sort().join()) return existing;
    this.flow.idempotencyKey = newKey(); this.flow.paymentKey = null;
    const b = await this.api.post<ApiBooking>('/bookings', {
      tripId, holdToken, lang,
      passengers: passengers.map(p => ({ seatNo: p.seatNumber, firstName: p.firstName.trim(), lastName: p.lastName.trim(), phone: p.phone.trim() || undefined,
        gender: ({ M: 'M', F: 'F', male: 'M', female: 'F' } as Record<string, string>)[p.gender] ?? '', category: p.category ?? 'adult' })),
      contact: { name: contact.name, phone: contact.phone, email: contact.email || undefined },
    }, { idempotencyKey: this.flow.idempotencyKey, scope: 'customer' });
    this.flow.setBooking(b);
    return b;
  }
  /** Lance le paiement mobile : le client reçoit une demande de validation sur son téléphone. */
  async start(method: string, payerPhone: string): Promise<ApiPayment> {
    const b = this.flow.booking()!;
    this.flow.paymentKey = newKey();
    return this.api.post<ApiPayment>('/payments', { reference: b.reference, method, payerPhone }, { idempotencyKey: this.flow.paymentKey, headers: this.headers(b), scope: 'customer' });
  }
  async refreshBooking(): Promise<ApiBooking | null> {
    const b = this.flow.booking();
    if (!b) return null;
    const fresh = await this.api.get<ApiBooking>(`/bookings/${b.reference}`, { headers: this.headers(b), scope: 'customer' });
    this.flow.setBooking(fresh);
    return this.flow.booking();
  }
  /**
   * Attend le résultat du paiement : notification temps réel quand elle arrive, et relecture régulière en secours
   * (réseau mobile instable, page mise en veille). S'arrête au bout de `timeoutMs`.
   */
  async waitForResult(payment: ApiPayment, timeoutMs: number, isCancelled: () => boolean = () => false): Promise<PaymentOutcome> {
    const b = this.flow.booking()!;
    let poke: () => void = () => undefined;
    const offs = ['payment.updated', 'booking.confirmed', 'booking.cancelled'].map(ev => this.realtime.on(ev, () => poke()));
    this.realtime.joinBooking(b.reference, b.accessToken || '');
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline && !isCancelled()) {
        try {
          const fresh = await this.refreshBooking();
          if (fresh?.status === 'confirmed') return { result: 'confirmed', booking: fresh };
          if (fresh && (fresh.status === 'cancelled' || fresh.status === 'expired')) {
            return fresh.payment.paidAmount > 0 ? { result: 'refunded', booking: fresh } : { result: 'failed', reason: fresh.status };
          }
          const p = await this.api.get<ApiPayment>(`/payments/${payment.id}`, { query: { reference: b.reference }, headers: this.headers(b), scope: 'customer' });
          if (p.status === 'failed' || p.status === 'expired') return { result: 'failed', reason: p.failureReason || p.status };
        } catch { /* coupure réseau : on réessaie au prochain tour */ }
        await Promise.race([sleep(3000), new Promise<void>(r => { poke = r; })]);
      }
      return { result: 'timeout' };
    } finally { offs.forEach(off => off()); this.realtime.leaveBooking(b.reference); }
  }
  /** Abandon avant paiement : la réservation en attente est annulée et les sièges sont libérés. */
  async abandon(): Promise<void> {
    const b = this.flow.booking();
    if (!b || b.status !== 'pending_payment') return;
    try { await this.api.post(`/bookings/${b.reference}/cancel`, {}, { headers: this.headers(b), scope: 'customer' }); } catch { /* elle expirera d'elle-même */ }
    this.flow.setBooking(null); this.flow.hold.set(null);
  }
  /** « Retrouver mon billet » sans compte : référence + téléphone de contact. */
  lookup(reference: string, phone: string): Promise<ApiBooking> { return this.api.post<ApiBooking>('/bookings/lookup', { reference: reference.trim(), phone: phone.trim() }, { scope: 'none' }); }
  byLink(reference: string, token: string): Promise<ApiBooking> { return this.api.get<ApiBooking>(`/bookings/${reference}`, { query: { t: token }, scope: 'customer' }); }
  cancel(b: ApiBooking, passengerIds?: string[]): Promise<ApiBooking> { return this.api.post<ApiBooking>(`/bookings/${b.reference}/cancel`, passengerIds ? { passengerIds } : {}, { headers: this.headers(b), scope: 'customer' }); }
}
