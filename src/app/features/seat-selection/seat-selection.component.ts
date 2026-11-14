import { Component, HostListener, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { SeatLockService } from '../../core/services/seat-lock.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { ApiError } from '../../core/api/api.service';
import { MoneyPipe } from '../../core/pipes/format.pipes';

export type SeatStatus = 'available' | 'booked' | 'selected' | 'pending';
export interface Seat { number: string; status: SeatStatus }
export interface SeatRow { rowId: string; seats: Seat[]; aisleAfter?: number; isDriverRow?: boolean }

@Component({
  selector: 'app-seat-selection',
  standalone: true,
  imports: [CommonModule, MoneyPipe],
  templateUrl: './seat-selection.component.html',
  styleUrl:    './seat-selection.component.scss',
})
export class SeatSelectionComponent implements OnInit, OnDestroy {
  private bookingService = inject(BookingService);
  private router         = inject(Router);
  private seatLockSvc    = inject(SeatLockService);
  readonly i18n          = inject(I18nService);
  readonly cfg           = inject(AppConfigService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly searchParams  = this.bookingService.searchParams;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly loading       = this.seatLockSvc.loading;
  readonly loadError     = this.seatLockSvc.error;
  readonly tripNotice    = this.seatLockSvc.tripNotice;
  /** Message affiché quand un siège vient d'être pris par quelqu'un d'autre, ou que la sélection a expiré. */
  readonly notice        = signal<string | null>(null);
  /** Siège en cours d'envoi au serveur (évite les doubles clics). */
  readonly busySeat      = signal<string | null>(null);

  /** Plan des sièges fourni par le serveur (les 3 plans d'origine et les plans personnalisés). */
  readonly seatRows = computed<SeatRow[]>(() => {
    const m = this.seatLockSvc.map();
    if (!m) return [];
    const booked = new Set(this.seatLockSvc.booked()), pending = new Set(this.seatLockSvc.heldByOthers());
    return m.rows.map(r => ({ rowId: r.rowId, isDriverRow: r.isDriverRow, aisleAfter: r.aisleAfter,
      seats: r.seats.map(n => ({ number: n, status: (booked.has(n) ? 'booked' : pending.has(n) ? 'pending' : 'available') as SeatStatus })) }));
  });
  /** Gabarit d'affichage : les plans personnalisés utilisent la grille générique du grand bus. */
  readonly layout = computed<string>(() => {
    const code = this.seatLockSvc.map()?.layoutCode ?? this.selectedBus()?.vehicleLayout ?? 'bus';
    return ['bus', 'minibus16', 'minibus10'].includes(code) ? code : 'bus';
  });
  private readonly est   = computed(() => this.cfg.estimate(this.selectedBus()?.price ?? 0, this.selectedSeats().length));
  readonly ticketTotal   = computed(() => this.est().subtotal);
  readonly fee           = computed(() => this.est().fee);
  readonly total         = computed(() => this.est().total);
  readonly layoutLabel   = computed(() => ({ bus: '🚌', minibus16: '🚐', minibus10: '⭐' } as Record<string, string>)[this.layout()] ?? '🚌');

  // ── Compte à rebours (l'échéance vient du serveur) ────────────────────────
  readonly remainingSec   = this.seatLockSvc.remainingSeconds;
  readonly remainingLabel = computed(() => {
    const s = this.remainingSec();
    if (s === null || s <= 0) return null;
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  });
  readonly isExpiringSoon = computed(() => { const s = this.remainingSec(); return s !== null && s <= 120 && s > 0; });
  readonly lockExpired    = signal(false);
  readonly pendingSeats   = this.seatLockSvc.heldByOthers;

  constructor() {
    // Le verrou vient d'expirer : la sélection est vidée et l'état réel est relu.
    effect(() => {
      if (this.remainingSec() === 0 && this.selectedSeats().length && !this.bookingService.booking()) {
        this.bookingService.hold.set(null);
        this.bookingService.setSelectedSeats([]);
        this.lockExpired.set(true);
        const id = this.selectedBus()?.tripId;
        if (id) this.seatLockSvc.load(id);
      }
    });
    // Un siège que j'avais choisi apparaît vendu ou retenu par un autre (changement de véhicule, expiration) : on le retire.
    effect(() => {
      const lost = this.selectedSeats().filter(s => this.seatLockSvc.booked().includes(s) || this.pendingSeats().includes(s));
      if (lost.length && !this.bookingService.booking()) {
        this.bookingService.setSelectedSeats(this.selectedSeats().filter(s => !lost.includes(s)));
        this.notice.set(this.i18n.t().x.seatTaken);
      }
    });
  }
  async ngOnInit(): Promise<void> {
    const bus = this.selectedBus();
    if (!bus?.tripId || !this.searchParams()) { this.router.navigate(['/']); return; }
    // Retour depuis l'écran de paiement : la réservation en attente garde ses sièges, on revient à l'étape passagers.
    await this.seatLockSvc.watch(bus.tripId);
    if (!(await this.seatLockSvc.ensureHold(bus.tripId))) this.notice.set(this.i18n.t().x.holdLost);
  }
  ngOnDestroy(): void { this.seatLockSvc.unwatch(); }
  /** Fermeture de l'onglet sans réservation : les sièges sont rendus tout de suite. */
  @HostListener('window:pagehide') onPageHide(): void { this.seatLockSvc.releaseOnClose(); }

  reload(): void { const id = this.selectedBus()?.tripId; if (id) this.seatLockSvc.load(id); }

  // ── Interaction ───────────────────────────────────────────────────────────
  /** Les appuis rapides sont traités l'un après l'autre : aucun n'est perdu, même sur un réseau lent. */
  private queue: Promise<void> = Promise.resolve();
  toggleSeat(number: string): Promise<void> {
    this.queue = this.queue.then(() => this.applyToggle(number));
    return this.queue;
  }
  private async applyToggle(number: string): Promise<void> {
    const seat = this.seatRows().flatMap(r => r.seats).find(s => s.number === number);
    const tripId = this.selectedBus()?.tripId;
    if (!seat || !tripId || (seat.status !== 'available' && !this.selectedSeats().includes(number))) return;
    const current  = this.selectedSeats();
    const maxSeats = this.searchParams()?.passengers ?? 1;
    const next = current.includes(number) ? current.filter(s => s !== number) : current.length < maxSeats ? [...current, number] : null;
    if (!next) return;
    this.busySeat.set(number); this.notice.set(null); this.lockExpired.set(false);
    // une réservation en attente existait pour une autre sélection : elle sera remplacée à la prochaine validation
    if (this.bookingService.booking()) this.bookingService.setBooking(null);
    try {
      await this.seatLockSvc.select(tripId, next);
      this.bookingService.setSelectedSeats(next);
    } catch (e) {
      const err = e as ApiError;
      this.notice.set(err.code === 'SEAT_TAKEN' ? this.i18n.t().x.seatTaken
        : err.code === 'SALES_CLOSED' || err.code === 'TRIP_NOT_SELLABLE' ? this.i18n.t().x.salesClosed
        : err.status === 0 ? this.i18n.t().x.offline : (err.message || this.i18n.t().x.seatsError));
    } finally { this.busySeat.set(null); }
  }

  getSeatClass(seat: Seat): string {
    const base = 'w-10 h-10 rounded-lg flex items-center justify-center border-2 transition-all duration-150 text-xs font-medium';
    return `${base} ${this._seatColor(seat, false)}`;
  }

  getVipSeatClass(seat: Seat): string {
    const base = 'w-14 h-14 rounded-xl flex items-center justify-center border-2 transition-all duration-150';
    return `${base} ${this._seatColor(seat, true)}`;
  }

  private _seatColor(seat: Seat, isVip: boolean): string {
    if (seat.status === 'booked')
      return 'bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed';
    if (seat.status === 'pending')
      return 'bg-amber-100 border-amber-400 text-amber-600 cursor-not-allowed animate-pulse';
    if (this.selectedSeats().includes(seat.number))
      return isVip
        ? 'bg-violet-600 border-violet-700 text-white shadow-md shadow-violet-200'
        : 'bg-blue-600 border-blue-700 text-white shadow-md shadow-blue-200';
    return isVip
      ? 'bg-white border-violet-200 text-violet-500 hover:border-violet-400 hover:bg-violet-50 cursor-pointer'
      : 'bg-white border-slate-300 text-slate-500 hover:border-blue-400 hover:bg-blue-50 cursor-pointer';
  }

  /** Libellé lu par les lecteurs d'écran : « Siège A3 — disponible ». */
  seatLabel(seat: Seat): string {
    const t = this.i18n.t().seats;
    const state = this.selectedSeats().includes(seat.number) ? t.legendSelected : seat.status === 'booked' ? t.legendBooked : seat.status === 'pending' ? t.legendPending : t.legendAvailable;
    return `${seat.number} — ${state}`;
  }
  goBack(): void { this.seatLockSvc.release(); this.bookingService.setSelectedSeats([]); this.router.navigate(['/buses']); }
  continueToPassengers(): void {
    if (this.selectedSeats().length === this.searchParams()?.passengers && (this.remainingSec() ?? 0) > 0) this.router.navigate(['/passengers']);
  }
}
