import {
  Component, inject, OnInit, OnDestroy, signal, computed, effect,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { SeatLockService } from '../../core/services/seat-lock.service';
import { VehicleLayout } from '../../core/models/booking.models';

export type SeatStatus = 'available' | 'booked' | 'selected' | 'pending';

export interface Seat {
  number: string;
  status: SeatStatus;
}

const BOOKED: Record<string, string[]> = {
  bus:       ['A3', 'A4', 'B2', 'D1', 'E3', 'F4', 'H2', 'J1', 'K3'],
  minibus16: ['F1', 'F2', 'B2', 'C1', 'D3'],
  minibus10: ['B1', 'C2', 'D1'],
};

export interface SeatRow {
  rowId: string;
  seats: Seat[];
  aisleAfter?: number;
  isDriverRow?: boolean;
}

@Component({
  selector: 'app-seat-selection',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './seat-selection.component.html',
  styleUrl:    './seat-selection.component.scss',
})
export class SeatSelectionComponent implements OnInit, OnDestroy {
  private bookingService = inject(BookingService);
  private router         = inject(Router);
  private seatLockSvc    = inject(SeatLockService);
  readonly i18n          = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly searchParams  = this.bookingService.searchParams;
  readonly selectedSeats = this.bookingService.selectedSeats;

  readonly seatRows = signal<SeatRow[]>([]);

  readonly busKey = computed(() => {
    const bus = this.selectedBus();
    const p   = this.searchParams();
    if (!bus || !p) return '';
    return this.seatLockSvc.buildKey(bus.id, p.from, p.to, p.date);
  });

  readonly layout = computed<VehicleLayout>(
    () => this.selectedBus()?.vehicleLayout ?? 'bus'
  );

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(
    () => this.ticketTotal() + (this.selectedSeats().length > 0 ? 2000 : 0)
  );

  readonly layoutLabel = computed(() => {
    const map: Record<VehicleLayout, string> = {
      bus: '🚌', minibus16: '🚐', minibus10: '⭐',
    };
    return map[this.layout()];
  });

  // ── Compte à rebours ─────────────────────────────────────────────────────
  readonly remainingSec  = signal<number | null>(null);
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  readonly remainingLabel = computed(() => {
    const s = this.remainingSec();
    if (s === null || s <= 0) return null;
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  });

  readonly isExpiringSoon = computed(() => {
    const s = this.remainingSec();
    return s !== null && s <= 120 && s > 0;
  });

  readonly lockExpired = computed(() => {
    const s = this.remainingSec();
    return s !== null && s === 0;
  });

  // ── Sièges réservés par d'autres ─────────────────────────────────────────
  readonly pendingSeats = computed(() => this.seatLockSvc.lockedByOthers(this.busKey()));

  ngOnInit(): void {
    if (!this.selectedBus() || !this.searchParams()) {
      this.router.navigate(['/']); return;
    }

    this.buildLayout();
    this._startCountdown();

    const seats = this.selectedSeats();
    if (seats.length > 0 && this.busKey()) {
      this.seatLockSvc.lockSeats(this.busKey(), seats);
    }

    // Rebuild quand les sièges en cours changent (autres onglets)
    effect(() => {
      const _p = this.pendingSeats();
      this.buildLayout();
    });
  }

  ngOnDestroy(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    const key = this.busKey();
    if (key) this.seatLockSvc.releaseSeats(key);
  }

  // ── Interaction ──────────────────────────────────────────────────────────
  toggleSeat(number: string): void {
    const allSeats = this.seatRows().flatMap(r => r.seats);
    const seat = allSeats.find(s => s.number === number);
    if (!seat || seat.status === 'booked' || seat.status === 'pending') return;

    const current  = [...this.selectedSeats()];
    const maxSeats = this.searchParams()?.passengers ?? 1;
    const key      = this.busKey();

    if (current.includes(number)) {
      const next = current.filter(s => s !== number);
      this.bookingService.setSelectedSeats(next);
      if (key) this.seatLockSvc.lockSeats(key, next);
      if (next.length === 0 && key) {
        this.seatLockSvc.releaseSeats(key);
        this.remainingSec.set(null);
      }
    } else if (current.length < maxSeats) {
      const next = [...current, number];
      this.bookingService.setSelectedSeats(next);
      if (key) this.seatLockSvc.lockSeats(key, next);
      if (current.length === 0) this._startCountdown();
    }
    this.buildLayout();
  }

  // ── Classes CSS ──────────────────────────────────────────────────────────
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

  goBack(): void { this.router.navigate(['/buses']); }

  continueToPassengers(): void {
    if (this.selectedSeats().length === this.searchParams()?.passengers) {
      // Verrou maintenu pendant le tunnel de réservation — libéré à la confirmation
      this.router.navigate(['/passengers']);
    }
  }

  // ── Compte à rebours ─────────────────────────────────────────────────────
  private _startCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = setInterval(() => {
      const s = this.seatLockSvc.remainingSeconds(this.busKey());
      this.remainingSec.set(s);
      if (s !== null && s <= 0) {
        this.bookingService.setSelectedSeats([]);
        this.buildLayout();
        clearInterval(this.countdownTimer!);
        this.countdownTimer = null;
      }
    }, 1000);
  }

  // ── Builders ─────────────────────────────────────────────────────────────
  private buildLayout(): void {
    if (!this.selectedBus()) return;
    const layout = this.selectedBus()!.vehicleLayout;
    switch (layout) {
      case 'bus':       this.seatRows.set(this.buildBusLayout());       break;
      case 'minibus16': this.seatRows.set(this.buildMinibus16Layout()); break;
      case 'minibus10': this.seatRows.set(this.buildMinibus10Layout()); break;
    }
  }

  private mkSeat(num: string, bookedList: string[]): Seat {
    const pending = this.pendingSeats();
    if (bookedList.includes(num)) return { number: num, status: 'booked' };
    if (pending.includes(num))    return { number: num, status: 'pending' };
    return { number: num, status: 'available' };
  }

  private buildBusLayout(): SeatRow[] {
    const booked = BOOKED['bus'];
    const rows: SeatRow[] = [{ rowId: 'driver', seats: [], isDriverRow: true }];
    for (let r = 1; r <= 12; r++) {
      const letter = String.fromCharCode(64 + r);
      const seats: Seat[] = [];
      for (let c = 1; c <= 4; c++) {
        seats.push(this.mkSeat(`${letter}${c}`, booked));
      }
      rows.push({ rowId: letter, seats, aisleAfter: 2 });
    }
    return rows;
  }

  private buildMinibus16Layout(): SeatRow[] {
    const booked = BOOKED['minibus16'];
    const mk = (n: string) => this.mkSeat(n, booked);
    return [
      { rowId: 'front', seats: [mk('F1'), mk('F2')], isDriverRow: true },
      { rowId: 'A', seats: [mk('A1'), mk('A2'), mk('A3'), mk('A4')], aisleAfter: 2 },
      { rowId: 'B', seats: [mk('B1'), mk('B2'), mk('B3')], aisleAfter: 2 },
      { rowId: 'C', seats: [mk('C1'), mk('C2'), mk('C3')], aisleAfter: 2 },
      { rowId: 'D', seats: [mk('D1'), mk('D2'), mk('D3'), mk('D4')], aisleAfter: 2 },
    ];
  }

  private buildMinibus10Layout(): SeatRow[] {
    const booked = BOOKED['minibus10'];
    const mk = (n: string) => this.mkSeat(n, booked);
    return [
      { rowId: 'front', seats: [mk('F1')], isDriverRow: true },
      { rowId: 'A', seats: [mk('A1'), mk('A2'), mk('A3')], aisleAfter: 2 },
      { rowId: 'B', seats: [mk('B1'), mk('B2'), mk('B3')], aisleAfter: 2 },
      { rowId: 'C', seats: [mk('C1'), mk('C2'), mk('C3')], aisleAfter: 2 },
    ];
  }
}
