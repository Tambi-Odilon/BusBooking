import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { SeatLockService } from '../../core/services/seat-lock.service';
import { PaymentService } from '../../core/services/payment.service';
import { AuthService } from '../../core/services/auth.service';
import { AppConfigService, PaymentMethodInfo } from '../../core/config/app-config.service';
import { ApiError, ApiService } from '../../core/api/api.service';
import { ApiPayment } from '../../core/models/booking.models';
import { MoneyPipe } from '../../core/pipes/format.pipes';

type Step = 'preparing' | 'form' | 'waiting' | 'failed' | 'timeout' | 'refunded' | 'expired' | 'error';
const STYLE: Record<string, { short: string; color: string }> = {
  mvola: { short: 'M', color: 'bg-yellow-500' }, orange_money: { short: 'OM', color: 'bg-orange-500' }, airtel_money: { short: 'AM', color: 'bg-red-600' },
};

/**
 * Paiement. La réservation est créée sur le serveur (montant calculé par lui), puis le paiement mobile est lancé par le serveur :
 * le client valide sur son téléphone et cet écran attend la confirmation de l'opérateur.
 */
@Component({
  selector: 'app-payment',
  standalone: true,
  imports: [FormsModule, MoneyPipe],
  templateUrl: './payment.component.html',
  styleUrl: './payment.component.scss',
})
export class PaymentComponent implements OnInit, OnDestroy {
  private flow    = inject(BookingService);
  private seats   = inject(SeatLockService);
  private pay     = inject(PaymentService);
  private auth    = inject(AuthService);
  private router  = inject(Router);
  private api     = inject(ApiService);
  readonly i18n   = inject(I18nService);
  readonly cfg    = inject(AppConfigService);

  readonly selectedBus   = this.flow.selectedBus;
  readonly selectedSeats = this.flow.selectedSeats;
  readonly passengers    = this.flow.passengers;
  readonly searchParams  = this.flow.searchParams;
  readonly booking       = this.flow.booking;
  readonly online        = this.api.online;

  readonly step     = signal<Step>('preparing');
  readonly message  = signal<string | null>(null);
  readonly payment  = signal<ApiPayment | null>(null);
  readonly methods  = this.cfg.onlinePayments;
  readonly method   = signal<string>('');
  readonly isProcessing = computed(() => this.step() === 'preparing' || this.step() === 'waiting');
  mobilePhone = '';
  private cancelled = false;

  // Montants : ceux du serveur dès que la réservation existe, une estimation sinon.
  private readonly est   = computed(() => this.cfg.estimate(this.selectedBus()?.price ?? 0, this.selectedSeats().length));
  readonly ticketTotal   = computed(() => this.booking()?.subtotal ?? this.est().subtotal);
  readonly fee           = computed(() => this.booking()?.serviceFee ?? this.est().fee);
  readonly tax           = computed(() => this.booking()?.taxAmount ?? 0);
  readonly total         = computed(() => this.booking()?.total ?? this.est().total);

  /** Temps restant : échéance de la réservation en attente (le serveur la prolonge pendant le paiement). */
  private readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly remainingSec = computed<number | null>(() => {
    const b = this.booking();
    if (b?.expiresAt) return Math.max(0, Math.ceil((new Date(b.expiresAt).getTime() - this.now()) / 1000));
    return this.seats.remainingSeconds();
  });
  readonly remainingLabel = computed(() => { const s = this.remainingSec(); return s && s > 0 ? `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` : null; });
  readonly isExpiringSoon = computed(() => { const s = this.remainingSec(); return s !== null && s <= 120 && s > 0; });

  readonly currentMethod = computed<PaymentMethodInfo | undefined>(() => this.methods().find(m => m.code === this.method()));
  styleOf(code: string) { return STYLE[code] ?? { short: code.slice(0, 2).toUpperCase(), color: 'bg-slate-600' }; }

  async ngOnInit(): Promise<void> {
    const bus = this.selectedBus();
    if (!bus || !this.selectedSeats().length || !this.passengers().length) { this.router.navigate(['/']); return; }
    this.timer = setInterval(() => this.now.set(Date.now()), 1000);
    this.method.set(this.methods()[0]?.code ?? '');
    this.mobilePhone = this.passengers()[0]?.phone ?? '';
    await this.prepare();
  }
  ngOnDestroy(): void { this.cancelled = true; if (this.timer) clearInterval(this.timer); }

  /** Crée (ou retrouve) la réservation en attente. Rejouable : même clé d'idempotence tant que la sélection ne change pas. */
  async prepare(): Promise<void> {
    this.step.set('preparing'); this.message.set(null);
    const bus = this.selectedBus()!;
    try {
      const existing = this.booking();
      if (existing) {
        const fresh = await this.pay.refreshBooking();
        if (fresh?.status === 'confirmed') { this.router.navigate(['/confirmation']); return; }
        if (fresh && fresh.status !== 'pending_payment') { this.flow.setBooking(null); }
      }
      if (!this.booking()) {
        if (!(await this.seats.ensureHold(bus.tripId)) || !this.flow.hold()) { this.step.set('expired'); return; }
        await this.seats.extend();
        const first = this.passengers()[0];
        const user = this.auth.currentUser();
        await this.pay.createBooking(bus.tripId, this.flow.hold()!.token, this.passengers(),
          { name: `${first.firstName} ${first.lastName}`.trim(), phone: first.phone, email: this.flow.contactEmail() || user?.email || '' }, this.i18n.lang());
      }
      // un paiement était déjà en attente (page rafraîchie pendant la validation sur le téléphone) : on reprend l'attente
      const b = this.booking()!;
      if (b.payment.lastPaymentId && b.payment.lastPaymentStatus === 'pending') { this.payment.set({ id: b.payment.lastPaymentId } as ApiPayment); this.wait(); return; }
      this.step.set('form');
    } catch (e) {
      const err = e as ApiError;
      if (['HOLD_EXPIRED', 'SEAT_TAKEN', 'HOLD_NOT_FOUND', 'SEATS_MISMATCH'].includes(err.code)) { this.flow.hold.set(null); this.step.set('expired'); return; }
      if (err.code === 'GUEST_CHECKOUT_DISABLED' || err.status === 401) this.message.set(this.i18n.t().x.loginRequired);
      else this.message.set(err.status === 0 ? this.i18n.t().x.offline : (err.message || this.i18n.t().x.payBookingError));
      this.step.set('error');
    }
  }

  isFormValid(): boolean { return !!this.method() && this.cfg.phoneValid(this.mobilePhone) && this.step() === 'form'; }
  onMethodChange(code: string): void { if (!this.isProcessing()) this.method.set(code); }

  async handlePayment(): Promise<void> {
    if (!this.isFormValid()) return;
    this.step.set('waiting'); this.message.set(null);
    try {
      const p = await this.pay.start(this.method(), this.mobilePhone);
      this.payment.set(p);
      if (p.clientAction?.type === 'redirect' && p.clientAction.url) { window.location.href = p.clientAction.url; return; }
      await this.wait();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'BOOKING_EXPIRED' || err.code === 'BOOKING_NOT_PAYABLE') { this.step.set('expired'); return; }
      this.message.set(err.status === 0 ? this.i18n.t().x.offline : (err.message || this.i18n.t().x.payFailed));
      this.step.set('failed');
    }
  }
  /** Attend le résultat (temps réel + relecture régulière). */
  async wait(): Promise<void> {
    const p = this.payment();
    if (!p) { this.step.set('form'); return; }
    this.step.set('waiting');
    const timeoutMs = (this.cfg.booking().paymentTimeoutMinutes + 1) * 60000;
    const out = await this.pay.waitForResult(p, timeoutMs, () => this.cancelled);
    if (this.cancelled) return;
    if (out.result === 'confirmed') { this.flow.hold.set(null); this.router.navigate(['/confirmation']); }
    else if (out.result === 'refunded') this.step.set('refunded');
    else if (out.result === 'timeout') this.step.set('timeout');
    else if (out.reason === 'expired' || out.reason === 'cancelled') this.step.set('expired');
    else { this.message.set(null); this.step.set('failed'); }
  }
  retryPayment(): void { this.payment.set(null); this.message.set(null); this.step.set('form'); }

  /** Retour : la réservation en attente est conservée (on peut modifier les passagers puis revenir payer). */
  goBack(): void { if (this.step() !== 'waiting') this.router.navigate(['/passengers']); }
  /** Les sièges ne sont plus retenus : retour au choix des sièges. */
  async restart(): Promise<void> { await this.pay.abandon(); this.flow.setSelectedSeats([]); this.flow.setBooking(null); this.router.navigate(['/seats']); }
  newSearch(): void { this.flow.reset(); this.router.navigate(['/']); }
}
