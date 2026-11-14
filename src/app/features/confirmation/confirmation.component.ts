import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BookingService }  from '../../core/services/booking.service';
import { AuthService }     from '../../core/services/auth.service';
import { I18nService }     from '../../core/services/i18n.service';
import { TicketService }   from '../../core/services/ticket.service';
import { PaymentService }  from '../../core/services/payment.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { TicketQr } from '../../core/models/booking.models';
import { MoneyPipe, AppDatePipe } from '../../core/pipes/format.pipes';

/** Confirmation : tout ce qui est affiché vient de la réservation enregistrée sur le serveur (montants, billets, QR codes). */
@Component({
  selector: 'app-confirmation',
  standalone: true,
  imports: [CommonModule, FormsModule, MoneyPipe, AppDatePipe],
  templateUrl: './confirmation.component.html',
  styleUrl: './confirmation.component.scss',
})
export class ConfirmationComponent implements OnInit {
  private flow        = inject(BookingService);
  private authService = inject(AuthService);
  private router      = inject(Router);
  private ticketSvc   = inject(TicketService);
  private pay         = inject(PaymentService);
  readonly i18n       = inject(I18nService);
  readonly cfg        = inject(AppConfigService);

  readonly booking          = this.flow.booking;
  readonly bookingReference = computed(() => this.booking()?.reference ?? this.flow.bookingReference());
  readonly isLoggedIn       = this.authService.isLoggedIn;
  // Mêmes noms que dans le gabarit d'origine, alimentés par la réservation du serveur.
  readonly selectedBus = computed(() => { const t = this.booking()?.trip; return t ? { name: t.vehicleName, type: t.vehicleType, departure: t.departure, arrival: t.arrival, duration: t.duration, price: t.price } : null; });
  readonly searchParams = computed(() => { const t = this.booking()?.trip; return t ? { from: t.fromCity, to: t.toCity, date: t.serviceDate } : null; });
  readonly selectedSeats = computed(() => this.booking()?.seats ?? []);
  readonly passengers = computed(() => (this.booking()?.passengers ?? []).filter(p => p.status !== 'cancelled')
    .map(p => ({ firstName: p.firstName, lastName: p.lastName, phone: p.phone ?? '', gender: p.gender, seatNumber: p.seatNo, ticketNumber: p.ticketNumber })));
  readonly ticketTotal = computed(() => this.booking()?.subtotal ?? 0);
  readonly fee         = computed(() => this.booking()?.serviceFee ?? 0);
  readonly tax         = computed(() => this.booking()?.taxAmount ?? 0);
  readonly total       = computed(() => this.booking()?.total ?? 0);

  /** QR codes signés générés par le serveur (un par passager). */
  readonly qrs   = signal<TicketQr[]>([]);
  readonly qrUrl = computed(() => this.qrs()[0]?.qrDataUrl ?? '');
  readonly qrIndex = signal(0);

  isDownloading  = signal(false);
  showEmailModal = signal(false);
  emailAddress   = '';
  emailSending   = signal(false);
  emailSent      = signal(false);
  readonly actionError = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    if (!this.booking()) { this.router.navigate(['/']); return; }
    try {
      const b = await this.pay.refreshBooking();
      if (b?.status !== 'confirmed') { this.router.navigate([b?.status === 'pending_payment' ? '/payment' : '/']); return; }
      this.emailAddress = b.contact.email || this.authService.currentUser()?.email || '';
      this.qrs.set(await this.ticketSvc.qrCodes(b.reference, b.accessToken));
    } catch { /* hors ligne : on affiche la réservation déjà connue, les QR codes seront rechargés à la reconnexion */ }
  }
  async downloadTicket(): Promise<void> {
    const b = this.booking();
    if (!b) return;
    this.isDownloading.set(true); this.actionError.set(null);
    try { await this.ticketSvc.downloadTicketPdf(b.reference, b.accessToken); }
    catch { this.actionError.set(this.i18n.t().x.ticketError); }
    finally { this.isDownloading.set(false); }
  }
  openEmailModal(): void { this.emailSent.set(false); this.actionError.set(null); this.showEmailModal.set(true); }
  closeEmailModal(): void { this.showEmailModal.set(false); }
  async sendEmail(): Promise<void> {
    const b = this.booking();
    if (!b || !this.emailAddress.trim()) return;
    this.emailSending.set(true); this.actionError.set(null);
    try { await this.ticketSvc.sendTicketByEmail(b.reference, this.emailAddress.trim(), b.accessToken); this.emailSent.set(true); }
    catch { this.actionError.set(this.i18n.t().x.ticketError); }
    finally { this.emailSending.set(false); }
  }
  viewMyBookings(): void { this.router.navigate(['/profile'], { queryParams: { tab: 'bookings' } }); }
  newBooking(): void { this.flow.reset(); this.router.navigate(['/']); }
}
