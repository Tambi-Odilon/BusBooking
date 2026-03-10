import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';

export type PaymentMethod  = 'card' | 'upi' | 'netbanking' | 'mobilemoney';
export type MobileProvider = 'mvola' | 'orangemoney' | 'airtelmoney';

@Component({
  selector: 'app-payment',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './payment.component.html',
  styleUrl: './payment.component.scss',
})
export class PaymentComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);
  readonly i18n = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly passengers    = this.bookingService.passengers;
  readonly searchParams  = this.bookingService.searchParams;

  readonly paymentMethod  = signal<PaymentMethod>('card');
  readonly mobileProvider = signal<MobileProvider>('mvola');
  readonly isProcessing   = signal(false);

  paymentMethodModel: PaymentMethod   = 'card';
  mobileProviderModel: MobileProvider = 'mvola';

  cardNumber = ''; cardName = ''; expiry = ''; cvv = ''; upiId = ''; mobilePhone = '';

  get paymentMethods() {
    const t = this.i18n.t().payment;
    return [
      { value: 'card'        as PaymentMethod, label: t.methodCard,   icon: '💳' },
      { value: 'upi'         as PaymentMethod, label: t.methodUpi,    icon: '📲' },
      { value: 'netbanking'  as PaymentMethod, label: t.methodBank,   icon: '🏦' },
      { value: 'mobilemoney' as PaymentMethod, label: t.methodMobile, icon: '📱' },
    ];
  }

  readonly mobileProviders: { value: MobileProvider; label: string; subtitle: string; short: string; color: string }[] = [
    { value: 'mvola',       label: 'MVola',        subtitle: 'Telma Mobile Money', short: 'M',  color: 'bg-orange-500' },
    { value: 'orangemoney', label: 'Orange Money', subtitle: 'Orange Madagascar',  short: 'OM', color: 'bg-orange-600' },
    { value: 'airtelmoney', label: 'Airtel Money', subtitle: 'Airtel Madagascar',  short: 'AM', color: 'bg-red-600'    },
  ];

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.passengers().length)
      this.router.navigate(['/']);
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
        return this.cardNumber.replace(/\s/g, '').length === 16 && !!this.cardName.trim() && this.expiry.length === 5 && this.cvv.length === 3;
      case 'mobilemoney': return !!this.mobilePhone.trim();
      default: return true;
    }
  }

  goBack(): void { this.router.navigate(['/passengers']); }

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
