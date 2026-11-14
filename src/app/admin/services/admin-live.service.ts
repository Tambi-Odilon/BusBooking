import { Injectable, inject } from '@angular/core';
import { ApiService, Page } from '../../core/api/api.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { ApiBooking, ApiPayment, HoldInfo, SeatRowDef, SeatState } from '../../core/models/booking.models';
import { localTime } from './admin-data.service';

/** Un départ réel (une ligne par voyage), tel que vendu aux clients. */
export interface LiveTrip {
  id: string; templateId: string | null; routeId: string; vehicleId: string; driverId: string | null; serviceDate: string; departureAt: string; arrivalAt: string;
  departure: string; arrival: string; price: number; status: 'scheduled' | 'boarding' | 'in_progress' | 'completed' | 'cancelled'; cancelReason: string | null; notes: string | null;
  fromCity: string; toCity: string; routeStatus: string; vehicleName: string; vehicleType: string; plateNumber: string; layoutCode: string; capacity: number; layoutRows: SeatRowDef[];
  driverName: string | null; driverStatus: string | null; seatsTaken: number; seatsBooked: number;
}
export interface ManifestPassenger { id: string; seatNo: string; firstName: string; lastName: string; phone: string | null; gender: string; status: string; ticketNumber: string | null; boardedAt: string | null;
  bookingId: string; reference: string; channel: string; contactPhone: string; needsAttention: boolean }
export interface Manifest { trip: any; layout: { code: string; capacity: number; rows: SeatRowDef[] }; seats: (SeatState & { expiresAt: string | null })[]; passengers: ManifestPassenger[]; serverTime: string }
export interface TicketCheck { valid: boolean; reason?: string; message: string; ticketNumber?: string; reference?: string; passenger?: string; seatNo?: string; phone?: string;
  fromCity?: string; toCity?: string; departureAt?: string; serviceDate?: string; tripId?: string; status?: string; boardedAt?: string | null }
export interface WalkinInput {
  tripId: string; holdToken?: string | null; passengers: { seatNo: string; firstName: string; lastName: string; phone?: string; gender?: 'M' | 'F' | ''; category?: 'adult' | 'child' }[];
  contact: { name: string; phone: string; email?: string | null }; paymentMethod: string; payerPhone?: string; amountReceived?: number; createAccount?: boolean;
}

/** Exploitation en direct : départs réels, plan des sièges, vente au guichet, contrôle des billets. */
@Injectable({ providedIn: 'root' })
export class AdminLiveService {
  private api = inject(ApiService);
  private cfg = inject(AppConfigService);

  private toTrip = (t: any): LiveTrip => ({ ...t, departure: localTime(t.departureAt, this.cfg.locale().timezone), arrival: localTime(t.arrivalAt, this.cfg.locale().timezone) });

  async trips(from: string, to: string, extra: Record<string, string | undefined> = {}): Promise<LiveTrip[]> {
    const r = await this.api.get<Page<any>>('/admin/trips', { query: { from, to, limit: 100, ...extra } });
    return r.items.map(this.toTrip);
  }
  async trip(id: string): Promise<LiveTrip> { return this.toTrip(await this.api.get<any>(`/admin/trips/${id}`)); }
  manifest(tripId: string): Promise<Manifest> { return this.api.get<Manifest>(`/admin/trips/${tripId}/manifest`); }
  cancelTrip(id: string, reason: string): Promise<any> { return this.api.post(`/admin/trips/${id}/cancel`, { reason }); }
  replaceVehicle(id: string, vehicleId: string): Promise<any> { return this.api.post(`/admin/trips/${id}/replace-vehicle`, { vehicleId }); }
  updateTrip(id: string, patch: { driverId?: string | null; price?: number; notes?: string | null; status?: string }): Promise<any> { return this.api.patch(`/admin/trips/${id}`, patch); }
  async mySchedule(from?: string, to?: string, driverId?: string): Promise<{ driver: any | null; trips: LiveTrip[] }> {
    const r = await this.api.get<any>('/admin/driver-schedule', { query: { from, to, driverId } });
    return { driver: r.driver, trips: (r.trips || []).map(this.toTrip) };
  }

  // ── Verrou de sièges pendant la saisie au guichet (mêmes règles que pour un client du site) ──
  hold(tripId: string, seats: string[], holdToken?: string | null): Promise<HoldInfo> {
    return this.api.post<HoldInfo>(`/trips/${tripId}/holds`, { seats, holdToken: holdToken || undefined }, { scope: 'staff' });
  }
  async release(tripId: string, holdToken: string): Promise<void> {
    try { await this.api.delete(`/trips/${tripId}/holds`, { query: { holdToken }, scope: 'staff', keepalive: true }); } catch { /* le verrou expirera de lui-même */ }
  }
  walkin(input: WalkinInput, idempotencyKey: string): Promise<{ booking: ApiBooking; payment: ApiPayment | null }> {
    return this.api.post('/admin/walkin', input, { idempotencyKey });
  }
  booking(id: string): Promise<ApiBooking> { return this.api.get<ApiBooking>(`/admin/bookings/${id}`); }
  async ticketPdf(reference: string): Promise<void> {
    const blob = await this.api.get<Blob>(`/bookings/${reference}/ticket.pdf`, { blob: true, scope: 'staff' });
    const url = URL.createObjectURL(blob);
    // ouvert dans un nouvel onglet pour impression immédiate au guichet ; téléchargement en secours si le navigateur bloque l'onglet
    if (!window.open(url, '_blank', 'noopener')) { const a = document.createElement('a'); a.href = url; a.download = `billet-${reference}.pdf`; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  verifyTicket(code: string, tripId?: string): Promise<TicketCheck> { return this.api.post<TicketCheck>('/tickets/verify', { code: code.trim(), tripId: tripId || undefined }); }
  boardTicket(code: string, tripId?: string): Promise<TicketCheck> { return this.api.post<TicketCheck>('/tickets/board', { code: code.trim(), tripId: tripId || undefined }); }
}
