import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { BookingService } from '../../services/booking.service';
import { DecimalPipe } from '@angular/common';

type SeatStatus = 'available' | 'booked' | 'selected';

interface Seat {
  number: string;
  status: SeatStatus;
}

const BOOKED_SEATS = ['A3', 'A4', 'B2', 'D1', 'E3', 'F4', 'H2', 'J1', 'K3'];

@Component({
  selector: 'app-seat-selection',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    <div class="space-y-6">
      <button (click)="goBack()" class="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors text-sm font-medium">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        Retour aux bus
      </button>

      <!-- Bus Info Bar -->
      @if (selectedBus()) {
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div class="flex justify-between items-center">
            <div>
              <h3 class="font-bold text-slate-900">{{ selectedBus()!.name }}</h3>
              <p class="text-sm text-slate-600">
                {{ searchParams()?.from }} → {{ searchParams()?.to }} · {{ selectedBus()!.departure }}
              </p>
            </div>
            <div class="text-right">
              <p class="text-xs text-slate-500">Tarif de base</p>
              <p class="font-bold text-slate-900">{{ selectedBus()!.price | number }} Ar/siège</p>
            </div>
          </div>
        </div>
      }

      <div class="grid lg:grid-cols-3 gap-6">
        <!-- Seat Map -->
        <div class="lg:col-span-2">
          <div class="bg-white rounded-2xl border border-slate-200 p-6">
            <div class="flex items-center justify-between mb-6">
              <h3 class="font-bold text-slate-900">Choisir vos sièges</h3>
              <div class="flex items-center gap-2 text-slate-500 text-sm">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                </svg>
                Chauffeur
              </div>
            </div>

            <!-- Legend -->
            <div class="flex gap-4 mb-6 text-xs">
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-lg bg-white border-2 border-slate-300"></div>
                <span class="text-slate-600">Disponible</span>
              </div>
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-lg bg-blue-600 border-2 border-blue-700"></div>
                <span class="text-slate-600">Sélectionné</span>
              </div>
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-lg bg-slate-200 border-2 border-slate-300"></div>
                <span class="text-slate-600">Réservé</span>
              </div>
            </div>

            <!-- Seat Grid -->
            <div class="space-y-2">
              @for (row of rows; track row; let rowIndex = $index) {
                <div class="flex gap-2 justify-center items-center">
                  <span class="text-xs text-slate-400 w-5 text-center font-medium">{{ getRowLabel(rowIndex) }}</span>
                  @for (colIndex of [0, 1]; track colIndex) {
                    @let seat = seats()[rowIndex * 4 + colIndex];
                    @if (seat) {
                      <button (click)="toggleSeat(seat.number)"
                        [disabled]="seat.status === 'booked'"
                        [class]="getSeatClass(seat)"
                        [title]="seat.number">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/>
                          <path d="M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0Z"/>
                          <path d="M5 18v2"/><path d="M19 18v2"/>
                        </svg>
                      </button>
                    }
                  }
                  <div class="w-6"></div>
                  @for (colIndex of [2, 3]; track colIndex) {
                    @let seat = seats()[rowIndex * 4 + colIndex];
                    @if (seat) {
                      <button (click)="toggleSeat(seat.number)"
                        [disabled]="seat.status === 'booked'"
                        [class]="getSeatClass(seat)"
                        [title]="seat.number">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/>
                          <path d="M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0Z"/>
                          <path d="M5 18v2"/><path d="M19 18v2"/>
                        </svg>
                      </button>
                    }
                  }
                </div>
              }
            </div>
          </div>
        </div>

        <!-- Summary -->
        <div class="lg:col-span-1">
          <div class="bg-white rounded-2xl border border-slate-200 p-6 sticky top-24">
            <h3 class="font-bold text-slate-900 mb-4">Récapitulatif</h3>

            <div class="mb-4">
              <p class="text-sm text-slate-500 mb-2">Sièges sélectionnés</p>
              <div class="flex flex-wrap gap-2 min-h-[40px]">
                @for (seat of selectedSeats(); track seat) {
                  <span class="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium">{{ seat }}</span>
                }
                @if (selectedSeats().length === 0) {
                  <p class="text-sm text-slate-400">Aucun siège sélectionné</p>
                }
              </div>
              <p class="text-xs text-slate-500 mt-2">
                {{ selectedSeats().length }} / {{ searchParams()?.passengers }} sièges sélectionnés
              </p>
            </div>

            <div class="border-t border-slate-100 pt-4 space-y-2 mb-4">
              <div class="flex justify-between text-sm">
                <span class="text-slate-600">{{ selectedSeats().length }} × {{ selectedBus()?.price | number }} Ar</span>
                <span class="font-medium">{{ ticketTotal() | number }} Ar</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-slate-600">Frais de service</span>
                <span class="font-medium">2 000 Ar</span>
              </div>
              <div class="border-t border-slate-100 pt-2 flex justify-between">
                <span class="font-bold">Total</span>
                <span class="text-xl font-bold text-blue-600">{{ total() | number }} Ar</span>
              </div>
            </div>

            <button (click)="continueToPassengers()"
              [disabled]="selectedSeats().length !== searchParams()?.passengers"
              class="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:cursor-not-allowed
                text-white disabled:text-slate-400 font-semibold rounded-xl transition-all text-sm">
              Continuer
            </button>

            @if (selectedSeats().length < (searchParams()?.passengers ?? 0)) {
              <p class="text-xs text-amber-600 text-center mt-2">
                Sélectionnez encore {{ (searchParams()?.passengers ?? 0) - selectedSeats().length }} siège(s)
              </p>
            }
          </div>
        </div>
      </div>
    </div>
  `
})
export class SeatSelectionComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);

  readonly selectedBus = this.bookingService.selectedBus;
  readonly searchParams = this.bookingService.searchParams;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly seats = signal<Seat[]>([]);
  readonly rows = Array.from({ length: 12 });

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    const seats = this.selectedSeats();
    return bus ? bus.price * seats.length : 0;
  });

  readonly total = computed(() => this.ticketTotal() + (this.selectedSeats().length > 0 ? 2000 : 0));

  ngOnInit(): void {
    if (!this.selectedBus() || !this.searchParams()) {
      this.router.navigate(['/']);
      return;
    }
    this.generateSeats();
  }

  private generateSeats(): void {
    const seatList: Seat[] = [];
    for (let row = 1; row <= 12; row++) {
      const rowLetter = String.fromCharCode(64 + row);
      for (let col = 1; col <= 4; col++) {
        const number = `${rowLetter}${col}`;
        seatList.push({
          number,
          status: BOOKED_SEATS.includes(number) ? 'booked' : 'available',
        });
      }
    }
    this.seats.set(seatList);
  }

  getRowLabel(index: number): string {
    return String.fromCharCode(65 + index);
  }

  getSeatClass(seat: Seat): string {
    const base = 'w-11 h-11 rounded-lg flex items-center justify-center border-2 transition-all duration-150';
    if (seat.status === 'booked') {
      return `${base} bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed`;
    }
    if (this.selectedSeats().includes(seat.number)) {
      return `${base} bg-blue-600 border-blue-700 text-white hover:bg-blue-700`;
    }
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

  goBack(): void {
    this.router.navigate(['/buses']);
  }

  continueToPassengers(): void {
    if (this.selectedSeats().length === this.searchParams()?.passengers) {
      this.router.navigate(['/passengers']);
    }
  }
}
