import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BookingService } from '../../services/booking.service';
import { DecimalPipe } from '@angular/common';

type PaymentMethod = 'card' | 'upi' | 'netbanking' | 'mobilemoney';
type MobileProvider = 'mvola' | 'orangemoney' | 'airtelmoney';

@Component({
  selector: 'app-payment',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  template: `
    <div class="space-y-6">
      <button (click)="goBack()" [disabled]="isProcessing()"
        class="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors text-sm font-medium disabled:opacity-50">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        Retour aux passagers
      </button>

      <!-- Progress -->
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <div class="flex gap-2 mb-2">
          <div class="h-2 flex-1 bg-blue-600 rounded-full"></div>
          <div class="h-2 flex-1 bg-blue-600 rounded-full"></div>
          <div class="h-2 flex-1 bg-blue-600 rounded-full"></div>
        </div>
        <p class="text-sm text-slate-600">Étape 3 sur 3 : Paiement</p>
      </div>

      <div class="grid lg:grid-cols-3 gap-6">
        <!-- Payment Forms -->
        <div class="lg:col-span-2 space-y-4">
          <!-- Payment Method -->
          <div class="bg-white rounded-2xl border border-slate-200 p-6">
            <h3 class="font-bold text-slate-900 mb-4">Mode de paiement</h3>
            <div class="space-y-3">
              @for (method of paymentMethods; track method.value) {
                <label [class]="'flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition-all ' +
                  (paymentMethod() === method.value ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300')">
                  <input type="radio" [value]="method.value" [(ngModel)]="paymentMethodModel"
                    (ngModelChange)="paymentMethod.set($event)" class="accent-blue-600" />
                  <span class="text-2xl">{{ method.icon }}</span>
                  <span class="font-medium text-slate-800">{{ method.label }}</span>
                </label>
              }
            </div>
          </div>

          <!-- Card Details -->
          @if (paymentMethod() === 'card') {
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 class="font-bold text-slate-900 mb-4">Informations de carte</h3>
              <div class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Numéro de carte</label>
                  <input type="text" [(ngModel)]="cardNumber" (ngModelChange)="formatCard($event)"
                    placeholder="1234 5678 9012 3456" maxlength="19"
                    class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Nom du titulaire</label>
                  <input type="text" [(ngModel)]="cardName" placeholder="JEAN DUPONT"
                    class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
                </div>
                <div class="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label class="block text-sm font-medium text-slate-700 mb-1.5">Expiration</label>
                    <input type="text" [(ngModel)]="expiry" (ngModelChange)="formatExpiry($event)"
                      placeholder="MM/AA" maxlength="5"
                      class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                        focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-slate-700 mb-1.5">CVV</label>
                    <input type="password" [(ngModel)]="cvv" placeholder="123" maxlength="3"
                      class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                        focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
                  </div>
                </div>
                <div class="flex items-center gap-2 p-3 bg-green-50 rounded-xl text-sm text-green-800">
                  <span>🔒</span>
                  <span>Vos informations de paiement sont chiffrées et sécurisées</span>
                </div>
              </div>
            </div>
          }

          <!-- UPI -->
          @if (paymentMethod() === 'upi') {
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 class="font-bold text-slate-900 mb-4">Paiement UPI</h3>
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1.5">ID UPI</label>
                <input type="text" [(ngModel)]="upiId" placeholder="votreNom@upi"
                  class="w-full h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                    focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
              </div>
            </div>
          }

          <!-- Net Banking -->
          @if (paymentMethod() === 'netbanking') {
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 class="font-bold text-slate-900 mb-2">Virement bancaire</h3>
              <p class="text-sm text-slate-600">Vous serez redirigé vers votre banque pour confirmer le paiement.</p>
            </div>
          }

          <!-- Mobile Money -->
          @if (paymentMethod() === 'mobilemoney') {
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 class="font-bold text-slate-900 mb-4">Mobile Money — Madagascar</h3>
              <div class="space-y-4">
                <div class="space-y-3">
                  @for (provider of mobileProviders; track provider.value) {
                    <label [class]="'flex items-center gap-4 p-3 border rounded-xl cursor-pointer transition-all ' +
                      (mobileProvider() === provider.value ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300')">
                      <input type="radio" [value]="provider.value" [(ngModel)]="mobileProviderModel"
                        (ngModelChange)="mobileProvider.set($event)" class="accent-blue-600" />
                      <div [class]="'w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-xs ' + provider.color">
                        {{ provider.short }}
                      </div>
                      <div>
                        <p class="font-medium text-sm text-slate-900">{{ provider.label }}</p>
                        <p class="text-xs text-slate-500">{{ provider.subtitle }}</p>
                      </div>
                    </label>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Numéro de téléphone</label>
                  <div class="flex gap-2">
                    <span class="flex items-center px-3 bg-slate-100 border border-slate-200 rounded-xl text-sm text-slate-700 whitespace-nowrap">+261</span>
                    <input type="tel" [(ngModel)]="mobilePhone" placeholder="34 12 345 67"
                      class="flex-1 h-11 px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm
                        focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all" />
                  </div>
                </div>
                <div class="flex items-center gap-2 p-3 bg-blue-50 rounded-xl text-sm text-blue-800">
                  <span>📱</span>
                  <span>Vous recevrez un code USSD sur votre téléphone pour confirmer le paiement</span>
                </div>
              </div>
            </div>
          }
        </div>

        <!-- Summary -->
        <div class="lg:col-span-1">
          <div class="bg-white rounded-2xl border border-slate-200 p-6 sticky top-24">
            <h3 class="font-bold text-slate-900 mb-4">Récapitulatif</h3>

            <div class="space-y-3 text-sm mb-4">
              <div>
                <p class="text-slate-400 text-xs">Bus</p>
                <p class="font-semibold">{{ selectedBus()?.name }}</p>
              </div>
              <div>
                <p class="text-slate-400 text-xs">Trajet</p>
                <p class="font-semibold">{{ searchParams()?.from }} → {{ searchParams()?.to }}</p>
              </div>
              <div>
                <p class="text-slate-400 text-xs">Passagers</p>
                @for (p of passengers(); track p.seatNumber) {
                  <p class="font-semibold">{{ p.firstName }} {{ p.lastName }} — Siège {{ p.seatNumber }}</p>
                }
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
                <span class="font-bold">Total à payer</span>
                <span class="text-xl font-bold text-blue-600">{{ total() | number }} Ar</span>
              </div>
            </div>

            <button (click)="handlePayment()"
              [disabled]="!isFormValid() || isProcessing()"
              class="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:cursor-not-allowed
                text-white disabled:text-slate-400 font-semibold rounded-xl transition-all text-sm">
              @if (isProcessing()) {
                <span class="flex items-center justify-center gap-2">
                  <span class="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
                  Traitement en cours...
                </span>
              } @else {
                Payer {{ total() | number }} Ar
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class PaymentComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);

  readonly selectedBus = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly passengers = this.bookingService.passengers;
  readonly searchParams = this.bookingService.searchParams;

  readonly paymentMethod = signal<PaymentMethod>('card');
  paymentMethodModel: PaymentMethod = 'card';
  readonly mobileProvider = signal<MobileProvider>('mvola');
  mobileProviderModel: MobileProvider = 'mvola';
  readonly isProcessing = signal(false);

  cardNumber = '';
  cardName = '';
  expiry = '';
  cvv = '';
  upiId = '';
  mobilePhone = '';

  readonly paymentMethods = [
    { value: 'card' as PaymentMethod, label: 'Carte crédit/débit', icon: '💳' },
    { value: 'upi' as PaymentMethod, label: 'UPI / Portefeuille numérique', icon: '📲' },
    { value: 'netbanking' as PaymentMethod, label: 'Virement bancaire', icon: '🏦' },
    { value: 'mobilemoney' as PaymentMethod, label: 'Mobile Money', icon: '📱' },
  ];

  readonly mobileProviders = [
    { value: 'mvola' as MobileProvider, label: 'MVola', subtitle: 'Telma Mobile Money', short: 'M', color: 'bg-orange-500' },
    { value: 'orangemoney' as MobileProvider, label: 'Orange Money', subtitle: 'Orange Madagascar', short: 'OM', color: 'bg-orange-600' },
    { value: 'airtelmoney' as MobileProvider, label: 'Airtel Money', subtitle: 'Airtel Madagascar', short: 'AM', color: 'bg-red-600' },
  ];

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    const seats = this.selectedSeats();
    return bus ? bus.price * seats.length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.passengers().length) {
      this.router.navigate(['/']);
    }
  }

  formatCard(value: string): void {
    const nums = value.replace(/\D/g, '').slice(0, 16);
    this.cardNumber = nums.match(/.{1,4}/g)?.join(' ') ?? nums;
  }

  formatExpiry(value: string): void {
    const nums = value.replace(/\D/g, '');
    this.expiry = nums.length >= 2 ? `${nums.slice(0, 2)}/${nums.slice(2, 4)}` : nums;
  }

  isFormValid(): boolean {
    switch (this.paymentMethod()) {
      case 'card':
        return this.cardNumber.replace(/\s/g, '').length === 16 &&
          !!this.cardName.trim() && this.expiry.length === 5 && this.cvv.length === 3;
      case 'mobilemoney':
        return !!this.mobilePhone.trim();
      default:
        return true;
    }
  }

  goBack(): void {
    this.router.navigate(['/passengers']);
  }

  async handlePayment(): Promise<void> {
    if (!this.isFormValid()) return;
    this.isProcessing.set(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const ref = `ST${Date.now().toString().slice(-8)}`;
    this.bookingService.setBookingReference(ref);
    this.isProcessing.set(false);
    this.router.navigate(['/confirmation']);
  }
}
