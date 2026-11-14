import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/services/i18n.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { PaymentService } from '../../core/services/payment.service';
import { TicketService } from '../../core/services/ticket.service';
import { BookingService } from '../../core/services/booking.service';
import { ApiBooking, TicketQr } from '../../core/models/booking.models';
import { errorMessage } from '../../core/api/api.service';
import { MoneyPipe, AppDatePipe } from '../../core/pipes/format.pipes';
import { ChangeBookingComponent } from './change-booking.component';

/** « Retrouver mon billet » : par référence + téléphone (sans compte), ou par le lien reçu par e-mail. */
@Component({
  selector: 'app-my-ticket',
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, AppDatePipe, ChangeBookingComponent],
  template: `
  <div class="max-w-2xl mx-auto">
    @if (!booking()) {
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
        <h1 class="text-2xl font-bold font-display text-slate-900">{{ t().x.findTitle }}</h1>
        <p class="text-sm text-slate-500 mt-1 mb-6">{{ t().x.findHint }}</p>
        <form (ngSubmit)="find()" class="space-y-4">
          <div>
            <label for="ref" class="block text-sm font-medium text-slate-700 mb-1.5">{{ t().x.findRef }}</label>
            <input id="ref" name="ref" [(ngModel)]="reference" autocomplete="off" autocapitalize="characters" [placeholder]="cfg.identity().referencePrefix + '-XXXXXXX'"
                   class="w-full h-12 px-4 rounded-xl border border-slate-200 bg-slate-50 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label for="phone" class="block text-sm font-medium text-slate-700 mb-1.5">{{ t().x.findPhone }}</label>
            <input id="phone" name="phone" type="tel" inputmode="tel" [(ngModel)]="phone" autocomplete="tel"
                   class="w-full h-12 px-4 rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          @if (error()) { <p role="alert" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{{ error() }}</p> }
          <button type="submit" [disabled]="loading() || !reference.trim() || !phone.trim()"
                  class="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-colors">
            {{ loading() ? t().x.loading : t().x.findBtn }}
          </button>
        </form>
      </div>
    } @else {
      @let b = booking()!;
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="p-5 sm:p-6 text-white" [style.background]="'var(--brand)'">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-wider opacity-80">{{ t().x.findRef }}</p>
              <p class="text-2xl font-bold font-mono tracking-wide">{{ b.reference }}</p>
            </div>
            <span class="px-3 py-1 rounded-full text-xs font-semibold bg-white/20">{{ statusLabel() }}</span>
          </div>
          <p class="mt-4 text-lg font-semibold">{{ b.trip.fromCity }} → {{ b.trip.toCity }}</p>
          <p class="text-sm opacity-90">{{ b.trip.serviceDate | appDate:'long' }} · {{ cfg.time(b.trip.departure) }} → {{ cfg.time(b.trip.arrival) }}</p>
          <p class="text-sm opacity-80">{{ b.trip.vehicleName }}@if (b.trip.fromStation) { · {{ b.trip.fromStation }} }</p>
        </div>

        <div class="p-5 sm:p-6 space-y-5">
          @if (b.tripStatus === 'cancelled') { <p role="alert" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{{ t().x.tripCancelled }}</p> }
          @if (b.payment.refundPendingAmount > 0) { <p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">{{ t().x.stRefundPending }} : {{ b.payment.refundPendingAmount | money }}</p> }
          @if (b.payment.refundedAmount > 0) { <p class="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">{{ t().x.stRefunded }} : {{ b.payment.refundedAmount | money }}</p> }

          @if (b.status === 'confirmed' && qrs().length) {
            <div class="text-center">
              <img [src]="qrs()[qrIndex()].qrDataUrl" [alt]="'QR ' + qrs()[qrIndex()].ticketNumber" width="200" height="200" class="mx-auto rounded-xl border-4 border-slate-900" />
              <p class="text-xs text-slate-500 mt-2">{{ t().x.showQr }}</p>
              <p class="font-semibold text-slate-900">{{ qrs()[qrIndex()].name }} · {{ qrs()[qrIndex()].seatNo }}</p>
              <p class="text-xs font-mono text-slate-500">{{ t().x.ticketNumber }} {{ qrs()[qrIndex()].ticketNumber }}</p>
              @if (qrs().length > 1) {
                <div class="flex justify-center gap-2 mt-3">
                  @for (q of qrs(); track q.passengerId; let i = $index) {
                    <button type="button" (click)="qrIndex.set(i)" [attr.aria-label]="q.name" [attr.aria-pressed]="qrIndex() === i"
                            class="min-w-11 h-11 px-3 rounded-lg border text-sm font-semibold" [class]="qrIndex() === i ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-200'">{{ q.seatNo }}</button>
                  }
                </div>
              }
            </div>
          }

          <ul class="divide-y divide-slate-100 border border-slate-200 rounded-xl">
            @for (p of b.passengers; track p.id) {
              <li class="flex items-center justify-between gap-3 px-4 py-3 text-sm" [class.opacity-50]="p.status === 'cancelled'">
                <span class="font-medium text-slate-900">{{ p.firstName }} {{ p.lastName }}</span>
                <span class="px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 font-semibold text-xs">{{ p.seatNo }}</span>
              </li>
            }
          </ul>
          <div class="flex items-center justify-between text-sm">
            <span class="text-slate-500">{{ b.status === 'pending_payment' ? t().x.payTotal : t().confirmation.totalPaid }}</span><span class="text-lg font-bold text-slate-900">{{ b.total | money }}</span>
          </div>

          @if (message()) { <p role="status" class="text-sm text-green-800 bg-green-50 border border-green-200 rounded-xl px-4 py-3">{{ message() }}</p> }
          @if (error()) { <p role="alert" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{{ error() }}</p> }

          @if (changing()) {
            <div class="border border-slate-200 rounded-xl p-4">
              <app-change-booking [booking]="b" (changed)="onChanged($event)" (closed)="changing.set(false)" />
            </div>
          }
          <div class="grid sm:grid-cols-2 gap-3" [class.hidden]="changing()">
            @if (b.status === 'confirmed') {
              <button type="button" (click)="download()" [disabled]="busy()" class="h-12 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold">{{ t().x.ticketDownload }}</button>
            }
            @if (b.status === 'pending_payment') {
              <button type="button" (click)="payNow()" class="h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold">{{ t().x.payNow }}</button>
            }
            @if (b.canChange) {
              <button type="button" (click)="changing.set(true); message.set(null)" class="h-12 rounded-xl border border-slate-300 text-slate-800 hover:bg-slate-50 font-semibold">{{ t().x.changeBtn }}</button>
            }
            @if (b.canCancel) {
              @if (!confirming()) {
                <button type="button" (click)="confirming.set(true)" class="h-12 rounded-xl border border-red-200 text-red-700 hover:bg-red-50 font-semibold">{{ t().x.cancelBtn }}</button>
              } @else {
                <button type="button" (click)="cancel()" [disabled]="busy()" class="h-12 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold">{{ t().x.cancelAsk }}</button>
              }
            }
          </div>
          @if (b.canCancel) { <p class="text-xs text-slate-500">{{ t().x.cancelUntil }} {{ b.cancelDeadline | appDate:'time' }} · {{ t().x.refundPct }} {{ b.refundPercent }} %</p> }
          @else if (b.status === 'confirmed') { <p class="text-xs text-slate-500">{{ t().x.cancelNo }}</p> }
          <a routerLink="/" class="block text-center text-sm text-blue-700 font-semibold hover:underline">{{ t().x.home }}</a>
        </div>
      </div>
    }
  </div>`,
})
export class MyTicketComponent implements OnInit {
  readonly i18n = inject(I18nService);
  readonly cfg = inject(AppConfigService);
  private pay = inject(PaymentService);
  private tickets = inject(TicketService);
  private flow = inject(BookingService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly t = this.i18n.t;

  reference = ''; phone = '';
  readonly booking = signal<ApiBooking | null>(null);
  readonly qrs = signal<TicketQr[]>([]);
  readonly qrIndex = signal(0);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly confirming = signal(false);
  readonly changing = signal(false);
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly statusLabel = computed(() => {
    const b = this.booking(), x = this.t().x;
    if (!b) return '';
    return ({ pending_payment: x.stPending, confirmed: x.stConfirmed, cancelled: x.stCancelled, expired: x.stExpired, completed: x.stCompleted, no_show: x.stCompleted } as Record<string, string>)[b.status] ?? b.status;
  });

  async ngOnInit(): Promise<void> {
    const ref = this.route.snapshot.paramMap.get('reference'), token = this.route.snapshot.queryParamMap.get('t');
    if (!ref) return;
    this.reference = ref;
    if (!token) return;
    this.loading.set(true);
    try { await this.show({ ...(await this.pay.byLink(ref, token)), accessToken: token }); }
    catch (e) { this.error.set(errorMessage(e, this.t().x.findNone)); }
    finally { this.loading.set(false); }
  }
  async find(): Promise<void> {
    this.loading.set(true); this.error.set(null);
    try { await this.show(await this.pay.lookup(this.reference.toUpperCase(), this.phone)); }
    catch (e) { this.error.set(errorMessage(e, this.t().x.findNone)); }
    finally { this.loading.set(false); }
  }
  private async show(b: ApiBooking): Promise<void> {
    this.booking.set(b); this.qrIndex.set(0); this.qrs.set([]);
    if (b.status === 'confirmed') { try { this.qrs.set(await this.tickets.qrCodes(b.reference, b.accessToken)); } catch { /* le billet PDF reste téléchargeable */ } }
  }
  async download(): Promise<void> {
    const b = this.booking(); if (!b) return;
    this.busy.set(true); this.error.set(null);
    try { await this.tickets.downloadTicketPdf(b.reference, b.accessToken); } catch { this.error.set(this.t().x.ticketError); } finally { this.busy.set(false); }
  }
  async cancel(): Promise<void> {
    const b = this.booking(); if (!b) return;
    this.busy.set(true); this.error.set(null);
    try { const fresh = await this.pay.cancel(b); await this.show({ ...fresh, accessToken: b.accessToken }); this.message.set(this.t().x.cancelDone); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); this.confirming.set(false); }
  }
  async onChanged(fresh: ApiBooking): Promise<void> {
    const token = this.booking()?.accessToken;
    this.changing.set(false);
    await this.show({ ...fresh, accessToken: fresh.accessToken ?? token });
    this.message.set(this.t().x.changeDone);
  }
  payNow(): void { const b = this.booking(); if (!b) return; this.flow.setBooking(b); this.router.navigate(['/payment']); }
}
