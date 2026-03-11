import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { MVolaService, MVolaPaymentStatus, MVOLA_CONFIG } from '../../core/services/mvola.service';

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
  private mvolaService   = inject(MVolaService);
  private router         = inject(Router);
  readonly i18n          = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly passengers    = this.bookingService.passengers;
  readonly searchParams  = this.bookingService.searchParams;

  readonly paymentMethod  = signal<PaymentMethod>('card');
  readonly mobileProvider = signal<MobileProvider>('mvola');
  readonly isProcessing   = signal(false);

  // ── MVola state ──────────────────────────────────────────────────────────
  readonly mvolaStatus      = this.mvolaService.paymentStatus;
  readonly mvolaError       = this.mvolaService.paymentError;
  readonly mvolaCorrelId    = this.mvolaService.serverCorrelationId;
  readonly mvolaStep        = signal<'form' | 'waiting' | 'done'>('form');

  // Numéro MVola merchant (affiché à l'utilisateur)
  readonly merchantNumber   = MVOLA_CONFIG.merchantNumber;

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

  readonly mobileProviders: { value: MobileProvider; label: string; subtitle: string; short: string; color: string; logo: string }[] = [
    { value: 'mvola',       label: 'MVola',        subtitle: 'Telma (034, 038)',    short: 'M',  color: 'bg-orange-500', logo: '🟠' },
    { value: 'orangemoney', label: 'Orange Money', subtitle: 'Orange (032, 037)',   short: 'OM', color: 'bg-orange-600', logo: '🔶' },
    { value: 'airtelmoney', label: 'Airtel Money', subtitle: 'Airtel (033)',        short: 'AM', color: 'bg-red-600',    logo: '🔴' },
  ];

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  // Libellé de statut MVola dynamique
  readonly mvolaStatusLabel = computed(() => {
    const map: Record<MVolaPaymentStatus, string> = {
      idle:          '',
      authenticating: '🔐 Connexion à MVola...',
      pending:        '📤 Envoi de la demande...',
      polling:        '⏳ En attente de confirmation — Veuillez valider sur votre téléphone',
      success:        '✅ Paiement confirmé !',
      failed:         '❌ Paiement échoué',
    };
    return map[this.mvolaStatus()];
  });

  readonly mvolaStatusColor = computed(() => {
    const s = this.mvolaStatus();
    if (s === 'success') return 'bg-green-50 border-green-300 text-green-800';
    if (s === 'failed')  return 'bg-red-50 border-red-300 text-red-800';
    return 'bg-orange-50 border-orange-300 text-orange-800';
  });

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
        return (
          this.cardNumber.replace(/\s/g, '').length === 16 &&
          !!this.cardName.trim() &&
          this.expiry.length === 5 &&
          this.cvv.length === 3
        );
      case 'mobilemoney':
        if (this.mobileProvider() === 'mvola') {
          const phone = this.mobilePhone.replace(/[\s\-().+]/g, '');
          // Numéros MVola : 034xxx ou 038xxx (ou avec indicatif +261)
          return /^(0(34|38)\d{7}|261(34|38)\d{7})$/.test(phone);
        }
        return !!this.mobilePhone.trim();
      default: return true;
    }
  }

  goBack(): void { this.router.navigate(['/passengers']); }

  async handlePayment(): Promise<void> {
    if (!this.isFormValid() || this.isProcessing()) return;

    // ── Paiement MVola ──────────────────────────────────────────────────────
    if (this.paymentMethod() === 'mobilemoney' && this.mobileProvider() === 'mvola') {
      await this.handleMVolaPayment();
      return;
    }

    // ── Autres méthodes (simulation) ────────────────────────────────────────
    this.isProcessing.set(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.completeBooking(`ST${Date.now().toString().slice(-8)}`);
  }

  // ── Flux MVola complet ────────────────────────────────────────────────────
  async handleMVolaPayment(): Promise<void> {
    this.isProcessing.set(true);
    this.mvolaStep.set('waiting');

    const bus    = this.selectedBus();
    const seats  = this.selectedSeats();
    const desc   = `Soatrans ${bus?.name ?? ''} x${seats.length}`;

    const result = await this.mvolaService.processMVolaPayment(
      this.mobilePhone,
      this.total(),
      desc,
    );

    this.isProcessing.set(false);

    if (result.success) {
      this.mvolaStep.set('done');
      const ref = result.transactionId ?? `MVOLA-${Date.now().toString().slice(-8)}`;
      // Courte pause pour montrer le succès
      await new Promise(r => setTimeout(r, 1200));
      this.completeBooking(ref);
    } else {
      this.mvolaStep.set('form');
    }
  }

  retryMVola(): void {
    this.mvolaStep.set('form');
    this.mvolaService.paymentStatus.set('idle');
    this.mvolaService.paymentError.set(null);
    this.isProcessing.set(false);
  }

  private completeBooking(ref: string): void {
    this.bookingService.setBookingReference(ref);
    this.isProcessing.set(false);
    this.router.navigate(['/confirmation']);
  }
}
