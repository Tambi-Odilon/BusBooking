import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { SeatLockService } from '../../core/services/seat-lock.service';
import { MVolaService, MVolaPaymentStatus, MVOLA_CONFIG } from '../../core/services/mvola.service';
import { OrangeMoneyService, OmPaymentStatus } from '../../core/services/orange-money.service';
import { AirtelMoneyService, AirtelPaymentStatus } from '../../core/services/airtel-money.service';

export type PaymentMethod  = 'card' | 'upi' | 'netbanking' | 'mobilemoney';
export type MobileProvider = 'mvola' | 'orangemoney' | 'airtelmoney';

@Component({
  selector: 'app-payment',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './payment.component.html',
  styleUrl: './payment.component.scss',
})
export class PaymentComponent implements OnInit, OnDestroy {
  private bookingService = inject(BookingService);
  private seatLockSvc    = inject(SeatLockService);
  private mvolaService   = inject(MVolaService);
  private omService      = inject(OrangeMoneyService);
  private airtelService  = inject(AirtelMoneyService);
  private router         = inject(Router);
  readonly i18n          = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly passengers    = this.bookingService.passengers;
  readonly searchParams  = this.bookingService.searchParams;

  readonly paymentMethod  = signal<PaymentMethod>('card');
  readonly mobileProvider = signal<MobileProvider>('mvola');
  readonly isProcessing   = signal(false);

  // ── Compte à rebours verrou siège ────────────────────────────────────────
  readonly remainingSec = signal<number | null>(null);
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
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  // ── MVola state ─────────────────────────────────────────────────────────
  readonly mvolaStatus    = this.mvolaService.paymentStatus;
  readonly mvolaError     = this.mvolaService.paymentError;
  readonly mvolaCorrelId  = this.mvolaService.serverCorrelationId;
  readonly mvolaStep      = signal<'form' | 'waiting'>('form');
  readonly merchantNumber = MVOLA_CONFIG.merchantNumber;

  // ── Orange Money state ───────────────────────────────────────────────────
  readonly omStatus     = this.omService.paymentStatus;
  readonly omError      = this.omService.paymentError;
  readonly omPaymentUrl = this.omService.paymentUrl;
  readonly omStep       = signal<'form' | 'waiting'>('form');

  // ── Airtel Money state ───────────────────────────────────────────────────
  readonly airtelStatus = this.airtelService.paymentStatus;
  readonly airtelError  = this.airtelService.paymentError;
  readonly airtelTxId   = this.airtelService.transactionId;
  readonly airtelStep   = signal<'form' | 'waiting'>('form');

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

  readonly mobileProviders: {
    value: MobileProvider; label: string; subtitle: string; short: string; color: string;
  }[] = [
    { value: 'mvola',       label: 'MVola',        subtitle: 'Telma (034, 038)',  short: 'M',  color: 'bg-orange-500' },
    { value: 'orangemoney', label: 'Orange Money', subtitle: 'Orange (032, 037)', short: 'OM', color: 'bg-orange-600' },
    { value: 'airtelmoney', label: 'Airtel Money', subtitle: 'Airtel (033)',      short: 'AM', color: 'bg-red-600'    },
  ];

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  // ── Labels de statut ─────────────────────────────────────────────────────
  readonly mvolaStatusLabel = computed((): string => {
    const map: Record<MVolaPaymentStatus, string> = {
      idle:           '',
      authenticating: '🔐 Connexion à MVola...',
      pending:        '📤 Envoi de la demande...',
      polling:        '⏳ En attente — Validez sur votre téléphone',
      success:        '✅ Paiement MVola confirmé !',
      failed:         '❌ Paiement échoué',
    };
    return map[this.mvolaStatus()];
  });

  readonly omStatusLabel = computed((): string => {
    const map: Record<OmPaymentStatus, string> = {
      idle:           '',
      authenticating: '🔐 Connexion à Orange Money...',
      pending:        '📤 Création du lien de paiement...',
      waiting_otp:    '📱 Validez votre OTP Orange Money',
      polling:        '⏳ Vérification du paiement...',
      success:        '✅ Paiement Orange Money confirmé !',
      failed:         '❌ Paiement échoué',
    };
    return map[this.omStatus()];
  });

  readonly airtelStatusLabel = computed((): string => {
    const map: Record<AirtelPaymentStatus, string> = {
      idle:           '',
      authenticating: '🔐 Connexion à Airtel Money...',
      pending:        '📤 Envoi de la demande USSD...',
      polling:        '⏳ En attente PIN — Validez sur votre téléphone',
      success:        '✅ Paiement Airtel Money confirmé !',
      failed:         '❌ Paiement échoué',
    };
    return map[this.airtelStatus()];
  });

  readonly currentStatusLabel = computed((): string => {
    switch (this.mobileProvider()) {
      case 'mvola':       return this.mvolaStatusLabel();
      case 'orangemoney': return this.omStatusLabel();
      case 'airtelmoney': return this.airtelStatusLabel();
      default:            return '';
    }
  });

  readonly currentStatusColor = computed((): string => {
    const p = this.mobileProvider();
    const s = p === 'mvola'       ? this.mvolaStatus()
            : p === 'orangemoney' ? this.omStatus()
            :                       this.airtelStatus();
    if (s === 'success') return 'bg-green-50 border-green-300 text-green-800';
    if (s === 'failed')  return 'bg-red-50 border-red-300 text-red-800';
    if (p === 'airtelmoney') return 'bg-red-50 border-red-300 text-red-900';
    if (p === 'orangemoney') return 'bg-amber-50 border-amber-300 text-amber-900';
    return 'bg-orange-50 border-orange-300 text-orange-900';
  });

  readonly currentStep = computed((): 'form' | 'waiting' => {
    switch (this.mobileProvider()) {
      case 'mvola':       return this.mvolaStep();
      case 'orangemoney': return this.omStep();
      case 'airtelmoney': return this.airtelStep();
      default:            return 'form';
    }
  });

  readonly currentError = computed((): string | null => {
    switch (this.mobileProvider()) {
      case 'mvola':       return this.mvolaError();
      case 'orangemoney': return this.omError();
      case 'airtelmoney': return this.airtelError();
      default:            return null;
    }
  });

  readonly currentIsPolling = computed((): boolean => {
    const p = this.mobileProvider();
    if (p === 'mvola')
      return ['authenticating', 'pending', 'polling'].includes(this.mvolaStatus());
    if (p === 'orangemoney')
      return ['authenticating', 'pending', 'waiting_otp', 'polling'].includes(this.omStatus());
    if (p === 'airtelmoney')
      return ['authenticating', 'pending', 'polling'].includes(this.airtelStatus());
    return false;
  });

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.passengers().length)
      this.router.navigate(['/']);
    // Démarre le countdown du verrou
    const p = this.searchParams();
    const b = this.selectedBus();
    if (p && b) {
      const busKey = this.seatLockSvc.buildKey(b.id, p.from, p.to, p.date);
      this.countdownTimer = setInterval(() => {
        const s = this.seatLockSvc.remainingSeconds(busKey);
        this.remainingSec.set(s);
      }, 1000);
    }
  }

  ngOnDestroy(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
  }

  // ── Form helpers ─────────────────────────────────────────────────────────
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
      case 'mobilemoney': {
        const phone = this.mobilePhone.replace(/[\s\-().+]/g, '');
        if (this.mobileProvider() === 'mvola')
          return /^(0(34|38)\d{7}|261(34|38)\d{7})$/.test(phone);
        if (this.mobileProvider() === 'orangemoney')
          return /^(0(32|37)\d{7}|261(32|37)\d{7})$/.test(phone);
        if (this.mobileProvider() === 'airtelmoney')
          return /^(033\d{7}|26133\d{7})$/.test(phone);
        return !!phone;
      }
      default: return true;
    }
  }

  isPhoneValid(): boolean {
    if (this.mobilePhone.length < 9) return true;
    return this.isFormValid();
  }

  getPhoneError(): string {
    if (this.mobileProvider() === 'mvola')       return 'Numéro MVola invalide (034 ou 038 requis)';
    if (this.mobileProvider() === 'orangemoney') return 'Numéro Orange invalide (032 ou 037 requis)';
    if (this.mobileProvider() === 'airtelmoney') return 'Numéro Airtel invalide (033 requis)';
    return '';
  }

  getPhonePlaceholder(): string {
    if (this.mobileProvider() === 'mvola')       return '034 12 345 67';
    if (this.mobileProvider() === 'orangemoney') return '032 12 345 67';
    if (this.mobileProvider() === 'airtelmoney') return '033 12 345 67';
    return '0XX XX XXX XX';
  }

  goBack(): void {
    // On libère les verrous si l'utilisateur abandonne le paiement
    this.seatLockSvc.releaseAll();
    this.router.navigate(['/passengers']);
  }

  onProviderChange(provider: MobileProvider): void {
    this.mobileProvider.set(provider);
    this.mobilePhone = '';
    this.mvolaStep.set('form');
    this.omStep.set('form');
    this.airtelStep.set('form');
    this.mvolaService.paymentStatus.set('idle');
    this.omService.reset();
    this.airtelService.reset();
  }

  // ── Dispatch paiement ────────────────────────────────────────────────────
  async handlePayment(): Promise<void> {
    if (!this.isFormValid() || this.isProcessing()) return;

    if (this.paymentMethod() === 'mobilemoney') {
      if (this.mobileProvider() === 'mvola')       { await this.handleMVolaPayment();   return; }
      if (this.mobileProvider() === 'orangemoney') { await this.handleOrangePayment();  return; }
      if (this.mobileProvider() === 'airtelmoney') { await this.handleAirtelPayment();  return; }
    }

    // Autres méthodes (simulation)
    this.isProcessing.set(true);
    await new Promise(r => setTimeout(r, 2000));
    this.finishBooking('ST' + Date.now().toString().slice(-8));
  }

  // ── MVola ─────────────────────────────────────────────────────────────────
  private async handleMVolaPayment(): Promise<void> {
    this.isProcessing.set(true);
    this.mvolaStep.set('waiting');
    const bus  = this.selectedBus();
    const desc = 'Soatrans ' + (bus?.name ?? '');
    const result = await this.mvolaService.processMVolaPayment(
      this.mobilePhone, this.total(), desc
    );
    this.isProcessing.set(false);
    if (result.success) {
      await new Promise(r => setTimeout(r, 1200));
      this.finishBooking(result.transactionId ?? ('MVOLA-' + Date.now().toString().slice(-8)));
    } else {
      this.mvolaStep.set('form');
    }
  }

  // ── Orange Money ──────────────────────────────────────────────────────────
  private async handleOrangePayment(): Promise<void> {
    this.isProcessing.set(true);
    this.omStep.set('waiting');
    const bus = this.selectedBus();
    const ref = 'Soatrans-' + (bus?.id ?? '') + '-' + Date.now();
    const result = await this.omService.processPayment(this.total(), ref);
    if (!result.success) {
      this.isProcessing.set(false);
      this.omStep.set('form');
      return;
    }
    if (result.payToken) {
      try {
        const final = await this.omService.pollPaymentStatus(result.payToken);
        this.isProcessing.set(false);
        if (final.success) {
          await new Promise(r => setTimeout(r, 1200));
          this.finishBooking(final.transactionId ?? ('OM-' + Date.now().toString().slice(-8)));
        }
      } catch {
        this.isProcessing.set(false);
        this.omStep.set('form');
      }
    }
  }

  // ── Airtel Money ──────────────────────────────────────────────────────────
  private async handleAirtelPayment(): Promise<void> {
    this.isProcessing.set(true);
    this.airtelStep.set('waiting');
    const bus = this.selectedBus();
    const ref = 'Soatrans ' + (bus?.name ?? '');
    const result = await this.airtelService.processPayment(
      this.mobilePhone, this.total(), ref
    );
    this.isProcessing.set(false);
    if (result.success) {
      await new Promise(r => setTimeout(r, 1200));
      this.finishBooking(result.transactionId ?? ('AM-' + Date.now().toString().slice(-8)));
    } else {
      this.airtelStep.set('form');
    }
  }

  // ── Retry ─────────────────────────────────────────────────────────────────
  retryPayment(): void {
    if (this.mobileProvider() === 'mvola') {
      this.mvolaStep.set('form');
      this.mvolaService.paymentStatus.set('idle');
      this.mvolaService.paymentError.set(null);
    }
    if (this.mobileProvider() === 'orangemoney') {
      this.omStep.set('form');
      this.omService.reset();
    }
    if (this.mobileProvider() === 'airtelmoney') {
      this.airtelStep.set('form');
      this.airtelService.reset();
    }
    this.isProcessing.set(false);
  }

  // ── Finalisation réservation ──────────────────────────────────────────────
  private finishBooking(ref: string): void {
    this.bookingService.setBookingReference(ref);
    this.isProcessing.set(false);
    this.router.navigate(['/confirmation']);
  }
}
