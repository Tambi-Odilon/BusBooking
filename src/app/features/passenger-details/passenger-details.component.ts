import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { AuthService } from '../../core/services/auth.service';
import { I18nService } from '../../core/services/i18n.service';
import { Passenger } from '../../core/models/booking.models';

@Component({
  selector: 'app-passenger-details',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './passenger-details.component.html',
  styleUrl: './passenger-details.component.scss',
})
export class PassengerDetailsComponent implements OnInit {
  private bookingService = inject(BookingService);
  private authService    = inject(AuthService);
  private router         = inject(Router);
  readonly i18n          = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly searchParams  = this.bookingService.searchParams;
  readonly currentUser   = this.authService.currentUser;
  readonly isLoggedIn    = this.authService.isLoggedIn;
  readonly passengerData = signal<Passenger[]>([]);
  readonly prefilled     = signal(false);

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.searchParams()) {
      this.router.navigate(['/']); return;
    }
    const user = this.currentUser();
    this.passengerData.set(
      this.selectedSeats().map((seat, index) => {
        if (index === 0 && user) {
          return {
            firstName:  user.firstName,
            lastName:   user.lastName,
            phone:      user.phone || '',
            gender:     user.gender || '',
            seatNumber: seat,
          };
        }
        return { firstName: '', lastName: '', phone: '', gender: '', seatNumber: seat };
      })
    );
    if (user) this.prefilled.set(true);
  }

  updatePassenger(index: number, field: keyof Passenger, value: string): void {
    const updated = [...this.passengerData()];
    updated[index] = { ...updated[index], [field]: value };
    this.passengerData.set(updated);
  }

  isPhoneValid(phone: string): boolean {
    // Accepte formats internationaux et locaux Madagascar
    return /^(\+?261|0)[0-9]{8,10}$/.test(phone.replace(/[\s\-().]/g, ''));
  }

  isFormValid(): boolean {
    return this.passengerData().every(p =>
      p.firstName.trim() &&
      p.lastName.trim() &&
      p.phone.trim() &&
      this.isPhoneValid(p.phone)
    );
  }

  isProfileField(index: number): boolean {
    return index === 0 && this.isLoggedIn() && this.prefilled();
  }

  goBack(): void { this.router.navigate(['/seats']); }

  continueToPayment(): void {
    if (this.isFormValid()) {
      this.bookingService.setPassengers(this.passengerData());
      this.router.navigate(['/payment']);
    }
  }
}
