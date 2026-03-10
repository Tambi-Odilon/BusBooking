import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
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
  private router = inject(Router);
  readonly i18n = inject(I18nService);

  readonly selectedBus   = this.bookingService.selectedBus;
  readonly selectedSeats = this.bookingService.selectedSeats;
  readonly searchParams  = this.bookingService.searchParams;
  readonly passengerData = signal<Passenger[]>([]);

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  ngOnInit(): void {
    if (!this.selectedBus() || !this.selectedSeats().length || !this.searchParams()) {
      this.router.navigate(['/']); return;
    }
    this.passengerData.set(
      this.selectedSeats().map(seat => ({ firstName: '', lastName: '', age: 0, gender: '', seatNumber: seat }))
    );
  }

  updatePassenger(index: number, field: keyof Passenger, value: string | number): void {
    const updated = [...this.passengerData()];
    updated[index] = { ...updated[index], [field]: value };
    this.passengerData.set(updated);
  }

  isFormValid(): boolean {
    return this.passengerData().every(p => p.firstName.trim() && p.lastName.trim() && p.age > 0 && p.age < 120 && p.gender);
  }

  goBack(): void { this.router.navigate(['/seats']); }

  continueToPayment(): void {
    if (this.isFormValid()) {
      this.bookingService.setPassengers(this.passengerData());
      this.router.navigate(['/payment']);
    }
  }
}
