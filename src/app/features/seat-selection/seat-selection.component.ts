import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { VehicleLayout } from '../../core/models/booking.models';

export type SeatStatus = 'available' | 'booked' | 'selected';

export interface Seat {
  number: string;
  status: SeatStatus;
}

// ─── Pre-booked seats per vehicle layout (demo) ───────────────────────────────
const BOOKED: Record<string, string[]> = {
  bus:       ['A3', 'A4', 'B2', 'D1', 'E3', 'F4', 'H2', 'J1', 'K3'],
  minibus16: ['F1', 'F2', 'B2', 'C1', 'D3'],
  minibus10: ['B1', 'C2', 'D1'],
};

// ─── Row definitions per layout ──────────────────────────────────────────────
//  Each entry = seats in that row (array of seat-number suffixes)
//  'driver' rows are rendered as a special non-clickable strip

export interface SeatRow {
  rowId: string;
  seats: Seat[];
  /** how many empty gap cells appear between left/right groups */
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
export class SeatSelectionComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router         = inject(Router);
  readonly i18n          = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly searchParams  = this.bookingService.searchParams;
  readonly selectedSeats = this.bookingService.selectedSeats;

  readonly seatRows = signal<SeatRow[]>([]);

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

  // ─── Layout meta for template ───────────────────────────────────────────
  readonly layoutLabel = computed(() => {
    const map: Record<VehicleLayout, string> = {
      bus:       '🚌',
      minibus16: '🚐',
      minibus10: '⭐',
    };
    return map[this.layout()];
  });

  ngOnInit(): void {
    if (!this.selectedBus() || !this.searchParams()) {
      this.router.navigate(['/']); return;
    }
    this.buildLayout();
  }

  // ─── Seat interaction ────────────────────────────────────────────────────
  getSeatClass(seat: Seat): string {
    const base = 'w-10 h-10 rounded-lg flex items-center justify-center border-2 transition-all duration-150 text-xs font-medium';
    if (seat.status === 'booked')
      return `${base} bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed`;
    if (this.selectedSeats().includes(seat.number))
      return `${base} bg-blue-600 border-blue-700 text-white shadow-md shadow-blue-200`;
    return `${base} bg-white border-slate-300 text-slate-500 hover:border-blue-400 hover:bg-blue-50 cursor-pointer`;
  }

  toggleSeat(number: string): void {
    const allSeats = this.seatRows().flatMap(r => r.seats);
    const seat = allSeats.find(s => s.number === number);
    if (!seat || seat.status === 'booked') return;

    const current = [...this.selectedSeats()];
    if (current.includes(number)) {
      this.bookingService.setSelectedSeats(current.filter(s => s !== number));
    } else if (current.length < (this.searchParams()?.passengers ?? 1)) {
      this.bookingService.setSelectedSeats([...current, number]);
    }
  }

  getVipSeatClass(seat: Seat): string {
    const base = 'w-14 h-14 rounded-xl flex items-center justify-center border-2 transition-all duration-150';
    if (seat.status === 'booked')
      return `${base} bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed`;
    if (this.selectedSeats().includes(seat.number))
      return `${base} bg-violet-600 border-violet-700 text-white shadow-md shadow-violet-200`;
    return `${base} bg-white border-violet-200 text-violet-500 hover:border-violet-400 hover:bg-violet-50 cursor-pointer`;
  }

  goBack(): void { this.router.navigate(['/buses']); }

  continueToPassengers(): void {
    if (this.selectedSeats().length === this.searchParams()?.passengers)
      this.router.navigate(['/passengers']);
  }

  // ─── Layout builders ─────────────────────────────────────────────────────
  private buildLayout(): void {
    const layout = this.selectedBus()!.vehicleLayout;
    switch (layout) {
      case 'bus':       this.seatRows.set(this.buildBusLayout());       break;
      case 'minibus16': this.seatRows.set(this.buildMinibus16Layout()); break;
      case 'minibus10': this.seatRows.set(this.buildMinibus10Layout()); break;
    }
  }

  // 48-seat coach: 12 rows × [AB | CD]
  private buildBusLayout(): SeatRow[] {
    const booked = BOOKED['bus'];
    const rows: SeatRow[] = [];

    // Driver row
    rows.push({ rowId: 'driver', seats: [], isDriverRow: true });

    for (let r = 1; r <= 12; r++) {
      const letter = String.fromCharCode(64 + r);
      const seats: Seat[] = [];
      for (let c = 1; c <= 4; c++) {
        const num = `${letter}${c}`;
        seats.push({ number: num, status: booked.includes(num) ? 'booked' : 'available' });
      }
      // seats 0,1 = left bank; 2,3 = right bank — aisleAfter=2 signals template
      rows.push({ rowId: letter, seats, aisleAfter: 2 });
    }
    return rows;
  }

  // 16-seat minibus
  // Front row: [driver][F1][F2]  (2 passenger seats beside driver)
  // Row A: [A1][A2] | [A3][A4]  (4 seats)
  // Row B: [B1]    | [B2][B3]   (3 seats — left 1, right 2)
  // Row C: [C1]    | [C2][C3]   (3 seats — left 1, right 2)
  // Row D: [D1][D2] | [D3][D4]  (4 seats)
  private buildMinibus16Layout(): SeatRow[] {
    const booked = BOOKED['minibus16'];
    const mk = (num: string): Seat => ({
      number: num, status: booked.includes(num) ? 'booked' : 'available',
    });

    return [
      // Front: driver + 2 passengers
      { rowId: 'front', seats: [mk('F1'), mk('F2')], isDriverRow: true },
      // Row A — 4 seats: [A1,A2 | A3,A4]
      { rowId: 'A', seats: [mk('A1'), mk('A2'), mk('A3'), mk('A4')], aisleAfter: 2 },
      // Row B — 3 seats: [B1 | B2,B3]
      { rowId: 'B', seats: [mk('B1'), mk('B2'), mk('B3')], aisleAfter: 1 },
      // Row C — 3 seats: [C1 | C2,C3]
      { rowId: 'C', seats: [mk('C1'), mk('C2'), mk('C3')], aisleAfter: 1 },
      // Row D — 4 seats: [D1,D2 | D3,D4]
      { rowId: 'D', seats: [mk('D1'), mk('D2'), mk('D3'), mk('D4')], aisleAfter: 2 },
    ];
  }

  // 10-seat VIP minibus
  // Front: [driver][F1]    (1 passenger front)
  // Row A: [A1] | [A2]     (2 seats — 1 left, 1 right)
  // Row B: [B1] | [B2]
  // Row C: [C1] | [C2]
  // Row D: [D1] | [D2]
  // Row E: [E1][E2]        (rear bench — 2 side-by-side)
  private buildMinibus10Layout(): SeatRow[] {
    const booked = BOOKED['minibus10'];
    const mk = (num: string): Seat => ({
      number: num, status: booked.includes(num) ? 'booked' : 'available',
    });

    return [
      { rowId: 'front', seats: [mk('F1')], isDriverRow: true },
      { rowId: 'A', seats: [mk('A1'), mk('A2')], aisleAfter: 1 },
      { rowId: 'B', seats: [mk('B1'), mk('B2')], aisleAfter: 1 },
      { rowId: 'C', seats: [mk('C1'), mk('C2')], aisleAfter: 1 },
      { rowId: 'D', seats: [mk('D1'), mk('D2')], aisleAfter: 1 },
      { rowId: 'E', seats: [mk('E1'), mk('E2')], aisleAfter: 1 },
    ];
  }
}
