import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { AuthService } from '../../core/services/auth.service';
import { I18nService } from '../../core/services/i18n.service';
import { SeatLockService } from '../../core/services/seat-lock.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { Passenger } from '../../core/models/booking.models';
import { MoneyPipe } from '../../core/pipes/format.pipes';

@Component({
  selector: 'app-passenger-details',
  standalone: true,
  imports: [FormsModule, MoneyPipe],
  templateUrl: './passenger-details.component.html',
  styleUrl: './passenger-details.component.scss',
})
export class PassengerDetailsComponent implements OnInit {
  private bookingService = inject(BookingService);
  private authService    = inject(AuthService);
  private router         = inject(Router);
  private seats          = inject(SeatLockService);
  readonly i18n          = inject(I18nService);
  readonly cfg           = inject(AppConfigService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly searchParams  = this.bookingService.searchParams;
  readonly currentUser   = this.authService.currentUser;
  readonly isLoggedIn    = this.authService.isLoggedIn;
  readonly passengerData = signal<Passenger[]>([]);
  readonly prefilled     = signal(false);
  /** Adresse où envoyer le billet (facultative). */
  contactEmail = this.bookingService.contactEmail() || this.authService.currentUser()?.email || '';

  private readonly est = computed(() => this.cfg.estimate(this.selectedBus()?.price ?? 0, this.selectedSeats().length));
  readonly ticketTotal = computed(() => this.est().subtotal);
  readonly fee         = computed(() => this.est().fee);
  readonly total       = computed(() => this.est().total);
  /** Réserver sans compte peut être désactivé dans les paramètres de la société. */
  readonly mustLogin   = computed(() => !this.cfg.booking().allowGuestCheckout && !this.isLoggedIn());
  readonly remaining   = this.seats.remainingSeconds;
  readonly remainingLabel = computed(() => { const s = this.remaining(); return s && s > 0 ? `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` : null; });

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.searchParams()) { this.router.navigate(['/']); return; }
    this.seats.watch(this.selectedBus()!.tripId).then(async () => { if (!(await this.seats.ensureHold(this.selectedBus()!.tripId))) this.router.navigate(['/seats']); });
    const user = this.currentUser();
    const previous = this.bookingService.passengers();
    this.passengerData.set(this.selectedSeats().map((seat, index) => {
      const kept = previous.find(p => p.seatNumber === seat) ?? previous[index];
      if (kept) return { ...kept, seatNumber: seat };
      if (index === 0 && user) return { firstName: user.firstName, lastName: user.lastName, phone: user.phone || '', gender: user.gender === 'M' ? 'male' : user.gender === 'F' ? 'female' : '', seatNumber: seat };
      return { firstName: '', lastName: '', phone: '', gender: '', seatNumber: seat };
    }));
    if (user && !previous.length) this.prefilled.set(true);
  }
  updatePassenger(index: number, field: keyof Passenger, value: string): void {
    const updated = [...this.passengerData()];
    updated[index] = { ...updated[index], [field]: value };
    this.passengerData.set(updated);
  }
  isPhoneValid(phone: string): boolean { return this.cfg.phoneValid(phone); }
  isEmailValid(): boolean { return !this.contactEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(this.contactEmail.trim()); }
  isFormValid(): boolean {
    return !this.mustLogin() && this.isEmailValid() && this.passengerData().every(p =>
      p.firstName.trim() && p.lastName.trim() && p.phone.trim() && this.isPhoneValid(p.phone));
  }
  isProfileField(index: number): boolean { return index === 0 && this.isLoggedIn() && this.prefilled(); }
  goBack(): void { this.bookingService.setPassengers(this.passengerData()); this.router.navigate(['/seats']); }
  continueToPayment(): void {
    if (!this.isFormValid()) return;
    this.bookingService.setPassengers(this.passengerData());
    this.bookingService.contactEmail.set(this.contactEmail.trim());
    this.router.navigate(['/payment']);
  }
}
