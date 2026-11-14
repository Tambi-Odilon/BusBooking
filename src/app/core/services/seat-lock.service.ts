import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiError, ApiService } from '../api/api.service';
import { RealtimeService } from '../realtime/realtime.service';
import { BookingService } from './booking.service';
import { HoldInfo, SeatRowDef, SeatState } from '../models/booking.models';

export interface SeatMap { tripId: string; layoutCode: string; rows: SeatRowDef[]; seats: SeatState[]; tripStatus: string }

/**
 * Sièges d'un départ : plan, état en temps réel et verrou temporaire.
 * Le verrou est posé par le SERVEUR (un seul gagnant quand deux personnes cliquent en même temps) ;
 * le navigateur ne fait qu'afficher l'état et le compte à rebours.
 */
@Injectable({ providedIn: 'root' })
export class SeatLockService {
  private api = inject(ApiService);
  private realtime = inject(RealtimeService);
  private flow = inject(BookingService);

  readonly map = signal<SeatMap | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Événement du voyage à signaler au client (annulation, changement de véhicule). */
  readonly tripNotice = signal<'cancelled' | 'vehicle_changed' | null>(null);
  private readonly now = signal(Date.now());
  private watching: string | null = null;
  private offs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  /** Sièges que je suis en train de demander au serveur. */
  private requested = new Set<string>();
  /** Marque mes sièges comme « à moi » dans la carte (jamais affichés comme pris par un autre). */
  private markMine(tripId: string, seats: string[]): void {
    const m = this.map();
    if (!m || m.tripId !== tripId) return;
    const set = new Set(seats);
    this.map.set({ ...m, seats: m.seats.map(x => x.status === 'held' && set.has(x.seat) ? { ...x, mine: true } : x) });
  }

  readonly booked = computed(() => (this.map()?.seats ?? []).filter(s => s.status === 'booked').map(s => s.seat));
  /** Sièges retenus par quelqu'un d'autre (affichés en jaune). */
  readonly heldByOthers = computed(() => (this.map()?.seats ?? []).filter(s => s.status === 'held' && !s.mine).map(s => s.seat));
  /** Secondes restantes sur mon verrou ; null si je n'ai rien retenu. */
  readonly remainingSeconds = computed<number | null>(() => {
    const h = this.flow.hold();
    if (!h) return null;
    return Math.max(0, Math.ceil((new Date(h.expiresAt).getTime() - this.now()) / 1000));
  });

  /** Commence à suivre un départ : lecture complète, puis mises à jour en temps réel. */
  async watch(tripId: string): Promise<void> {
    if (this.watching !== tripId) {
      this.unwatch();
      this.watching = tripId;
      this.tripNotice.set(null);
      this.realtime.joinTrip(tripId);
      const mine = (p: any) => p?.tripId === tripId;
      const apply = (status: 'held' | 'booked' | null) => (p: any) => { if (mine(p)) this.patch(p.seats || [], status); };
      this.offs = [
        this.realtime.on('seat.held', apply('held')), this.realtime.on('seat.booked', apply('booked')), this.realtime.on('seat.released', apply(null)),
        this.realtime.on('trip.cancelled', p => { if (mine(p)) { this.tripNotice.set('cancelled'); this.load(tripId); } }),
        this.realtime.on('trip.vehicle_changed', p => { if (mine(p)) { this.tripNotice.set('vehicle_changed'); this.load(tripId); } }),
        this.realtime.on('trip.updated', p => { if (mine(p)) this.load(tripId); }),
        // après une coupure, des événements ont pu être perdus : on relit tout
        this.realtime.onReconnect(() => { if (this.watching === tripId) this.load(tripId); }),
      ];
      this.timer = setInterval(() => this.now.set(Date.now()), 1000);
    }
    await this.load(tripId);
  }
  unwatch(): void {
    if (this.watching) this.realtime.leaveTrip(this.watching);
    this.offs.forEach(off => off()); this.offs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.watching = null;
  }
  async load(tripId: string): Promise<void> {
    this.loading.set(!this.map() || this.map()!.tripId !== tripId);
    try {
      const token = this.flow.hold()?.tripId === tripId ? this.flow.hold()!.token : undefined;
      const r = await this.api.get<any>(`/trips/${tripId}/seats`, { query: { holdToken: token }, scope: 'none' });
      this.map.set({ tripId, layoutCode: r.layout.code, rows: r.layout.rows, seats: r.seats, tripStatus: r.trip.status });
      // mon verrou a expiré ou a été libéré côté serveur : la sélection locale est remise à zéro
      if (token && !r.hold) this.flow.hold.set(null);
      else if (r.hold) this.flow.hold.set({ ...this.flow.hold()!, ...r.hold, tripId });
      this.error.set(null);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Erreur');
    } finally { this.loading.set(false); }
  }
  /**
   * Après un rafraîchissement de page ou une coupure : si ma sélection n'est plus retenue côté serveur, on tente de la reprendre.
   * Renvoie false si les sièges ont été pris entre-temps (la sélection locale est alors vidée).
   */
  async ensureHold(tripId: string): Promise<boolean> {
    const seats = this.flow.selectedSeats();
    if (!seats.length || this.flow.booking()) return true;
    if (this.flow.hold()?.tripId === tripId && (this.remainingSeconds() ?? 0) > 0) return true;
    try { await this.select(tripId, seats); return true; }
    catch { this.flow.hold.set(null); this.flow.setSelectedSeats([]); return false; }
  }
  private patch(seats: string[], status: 'held' | 'booked' | null): void {
    const m = this.map();
    if (!m) return;
    // « à moi » = déjà sélectionné, ou en cours de demande (l'événement temps réel peut arriver avant la réponse HTTP)
    const mineSeats = new Set([...(this.flow.hold()?.tripId === m.tripId ? this.flow.selectedSeats() : []), ...this.requested]);
    const rest = m.seats.filter(s => !seats.includes(s.seat));
    const added = status ? seats.map(seat => ({ seat, status, mine: mineSeats.has(seat) })) : [];
    this.map.set({ ...m, seats: [...rest, ...added] });
  }

  /**
   * Demande au serveur de retenir exactement cette liste de sièges (tout ou rien).
   * Les appels sont mis en file : deux clics rapprochés ne se croisent jamais.
   * Rejette avec ApiError('SEAT_TAKEN') si un siège vient d'être pris ; `details.seats` liste les sièges concernés.
   */
  select(tripId: string, seats: string[], scope: 'customer' | 'staff' = 'customer'): Promise<HoldInfo | null> {
    const run = async (): Promise<HoldInfo | null> => {
      const current = this.flow.hold()?.tripId === tripId ? this.flow.hold() : null;
      if (!seats.length) { if (current) await this.release(); return null; }
      this.requested = new Set(seats);
      try {
        const h = await this.api.post<HoldInfo>(`/trips/${tripId}/holds`, { seats, holdToken: current?.token ?? null }, { scope });
        this.flow.hold.set({ ...h, tripId });
        this.markMine(tripId, seats);
        return h;
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'HOLD_EXPIRED' && current) {   // mon verrou a expiré entre-temps : on repart d'un verrou neuf
          this.flow.hold.set(null);
          const h = await this.api.post<HoldInfo>(`/trips/${tripId}/holds`, { seats, holdToken: null }, { scope });
          this.flow.hold.set({ ...h, tripId });
          this.markMine(tripId, seats);
          return h;
        }
        if (err.code === 'SEAT_TAKEN') this.load(tripId);
        throw e;
      } finally { this.requested = new Set(); }
    };
    const p = this.pending.then(run, run);
    this.pending = p.catch(() => undefined);
    return p;
  }
  /** Prolonge le verrou (une fois par défaut) : appelé à l'entrée dans l'écran de paiement. */
  async extend(): Promise<boolean> {
    const h = this.flow.hold();
    if (!h || h.extensionsLeft <= 0) return false;
    try { const r = await this.api.patch<HoldInfo>(`/trips/${h.tripId}/holds`, { holdToken: h.token }, { scope: 'none' }); this.flow.hold.set({ ...r, tripId: h.tripId }); return true; }
    catch { return false; }
  }
  /** Abandon : les sièges redeviennent libres immédiatement pour les autres clients. */
  async release(): Promise<void> {
    const h = this.flow.hold();
    if (!h) return;
    this.flow.hold.set(null);
    try { await this.api.delete(`/trips/${h.tripId}/holds`, { query: { holdToken: h.token }, scope: 'none' }); } catch { /* le verrou expirera de lui-même */ }
  }
  /** Fermeture de l'onglet : `sendBeacon` part même si la page est en train de disparaître. */
  releaseOnClose(): void {
    const h = this.flow.hold();
    if (!h || this.flow.booking()) return;      // une réservation en attente de paiement garde ses sièges
    try { navigator.sendBeacon(this.api.url(`/trips/${h.tripId}/holds/release`, { holdToken: h.token })); } catch { /* idem */ }
  }
}
