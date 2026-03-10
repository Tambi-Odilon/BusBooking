import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BookingService } from '../../services/booking.service';
import { Passenger } from '../../models/booking.models';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'app-passenger-details',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  template: `
    <div class="space-y-6">
      <button (click)="goBack()" class="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors text-sm font-medium">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        Retour aux sièges
      </button>

      <!-- Progress -->
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <div class="flex gap-2 mb-2">
          <div class="h-2 flex-1 bg-blue-600 rounded-full"></div>
          <div class="h-2 flex-1 bg-blue-600 rounded-full"></div>
          <div class="h-2 flex-1 bg-slate-200 rounded-full"></div>
        </div>
        <p class="text-sm text-slate-600">Étape 2 sur 3 : Informations passagers</p>
      </div>

      <div class="grid lg:grid-cols-3 gap-6">
        <!-- Passenger Forms -->
        <div class="lg:col-span-2 space-y-4">
          @for (passenger of passengerData(); track passenger.seatNumber; let i = $index) {
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 class="font-bold text-slate-900 flex items-center gap-2 mb-5">
                <span class="w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">
                  {{ i + 1 }}
                </span>
                Passager {{ i + 1 }} — Siège {{ passenger.seatNumber }}
              </h3>

              <div class="grid sm:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Prénom</label>
                  <input type="text" [ngModel]="passenger.firstName"
                    (ngModelChange)="updatePassenger(i, 'firstName', $event)"
                    placeholder="Entrez le prénom"
                    class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Nom</label>
                  <input type="text" [ngModel]="passenger.lastName"
                    (ngModelChange)="updatePassenger(i, 'lastName', $event)"
                    placeholder="Entrez le nom"
                    class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Âge</label>
                  <input type="number" min="1" max="120" [ngModel]="passenger.age || null"
                    (ngModelChange)="updatePassenger(i, 'age', +$event || 0)"
                    placeholder="Âge"
                    class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Genre</label>
                  <select [ngModel]="passenger.gender"
                    (ngModelChange)="updatePassenger(i, 'gender', $event)"
                    class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all">
                    <option value="">Sélectionner</option>
                    <option value="male">Masculin</option>
                    <option value="female">Féminin</option>
                    <option value="other">Autre</option>
                  </select>
                </div>
              </div>
            </div>
          }
        </div>

        <!-- Summary -->
        <div class="lg:col-span-1">
          <div class="bg-white rounded-2xl border border-slate-200 p-6 sticky top-24">
            <h3 class="font-bold text-slate-900 mb-4">Résumé du voyage</h3>

            <div class="space-y-3 text-sm mb-4">
              <div>
                <p class="text-slate-500 text-xs">Bus</p>
                <p class="font-semibold text-slate-900">{{ selectedBus()?.name }}</p>
              </div>
              <div>
                <p class="text-slate-500 text-xs">Trajet</p>
                <p class="font-semibold text-slate-900">{{ searchParams()?.from }} → {{ searchParams()?.to }}</p>
              </div>
              <div>
                <p class="text-slate-500 text-xs">Date & Heure</p>
                <p class="font-semibold text-slate-900">{{ searchParams()?.date }} · {{ selectedBus()?.departure }}</p>
              </div>
              <div>
                <p class="text-slate-500 text-xs">Sièges</p>
                <p class="font-semibold text-slate-900">{{ selectedSeats().join(', ') }}</p>
              </div>
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

            <button (click)="continueToPayment()"
              [disabled]="!isFormValid()"
              class="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:cursor-not-allowed
                text-white disabled:text-slate-400 font-semibold rounded-xl transition-all text-sm">
              Continuer vers le paiement
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class PassengerDetailsComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);

  readonly selectedBus = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly searchParams = this.bookingService.searchParams;
  readonly passengerData = signal<Passenger[]>([]);

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    const seats = this.selectedSeats();
    return bus ? bus.price * seats.length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.searchParams()) {
      this.router.navigate(['/']);
      return;
    }
    const initial: Passenger[] = this.selectedSeats().map(seat => ({
      firstName: '', lastName: '', age: 0, gender: '', seatNumber: seat,
    }));
    this.passengerData.set(initial);
  }

  updatePassenger(index: number, field: keyof Passenger, value: string | number): void {
    const updated = [...this.passengerData()];
    updated[index] = { ...updated[index], [field]: value };
    this.passengerData.set(updated);
  }

  isFormValid(): boolean {
    return this.passengerData().every(
      p => p.firstName.trim() && p.lastName.trim() && p.age > 0 && p.age < 120 && p.gender
    );
  }

  goBack(): void {
    this.router.navigate(['/seats']);
  }

  continueToPayment(): void {
    if (this.isFormValid()) {
      this.bookingService.setPassengers(this.passengerData());
      this.router.navigate(['/payment']);
    }
  }
}
