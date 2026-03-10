import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';

type SeatStatus = 'available' | 'booked' | 'selected';
export interface Seat { number: string; status: SeatStatus; }
const BOOKED_SEATS = ['A3', 'A4', 'B2', 'D1', 'E3', 'F4', 'H2', 'J1', 'K3'];

@Component({
  selector: 'app-seat-selection',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './seat-selection.component.html',
  styleUrl: './seat-selection.component.scss',
})
export class SeatSelectionComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);
  readonly i18n = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly searchParams  = this.bookingService.searchParams;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly seats         = signal<Seat[]>([]);
  readonly rows          = Array.from({ length: 12 });

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + (this.selectedSeats().length > 0 ? 2000 : 0));

  ngOnInit(): void {
    if (!this.selectedBus() || !this.searchParams()) { this.router.navigate(['/']); return; }
    this.generateSeats();
  }

  getRowLabel(index: number): string { return String.fromCharCode(65 + index); }

  getSeatClass(seat: Seat): string {
    const base = 'w-11 h-11 rounded-lg flex items-center justify-center border-2 transition-all duration-150';
    if (seat.status === 'booked') return `${base} bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed`;
    if (this.selectedSeats().includes(seat.number)) return `${base} bg-blue-600 border-blue-700 text-white hover:bg-blue-700`;
    return `${base} bg-white border-slate-300 text-slate-600 hover:border-blue-400 hover:bg-blue-50`;
  }

  toggleSeat(number: string): void {
    const seat = this.seats().find(s => s.number === number);
    if (!seat || seat.status === 'booked') return;
    const current = [...this.selectedSeats()];
    if (current.includes(number)) {
      this.bookingService.setSelectedSeats(current.filter(s => s !== number));
    } else if (current.length < (this.searchParams()?.passengers ?? 1)) {
      this.bookingService.setSelectedSeats([...current, number]);
    }
  }

  goBack(): void { this.router.navigate(['/buses']); }

  continueToPassengers(): void {
    if (this.selectedSeats().length === this.searchParams()?.passengers)
      this.router.navigate(['/passengers']);
  }

  private generateSeats(): void {
    const list: Seat[] = [];
    for (let row = 1; row <= 12; row++) {
      const letter = String.fromCharCode(64 + row);
      for (let col = 1; col <= 4; col++) {
        const number = `${letter}${col}`;
        list.push({ number, status: BOOKED_SEATS.includes(number) ? 'booked' : 'available' });
      }
    }
    this.seats.set(list);
  }
}
