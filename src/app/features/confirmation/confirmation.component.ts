import { Component, inject, OnInit, computed } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';

@Component({
  selector: 'app-confirmation',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './confirmation.component.html',
  styleUrl: './confirmation.component.scss',
})
export class ConfirmationComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);

  readonly selectedBus      = this.bookingService.selectedBus;
  readonly selectedSeats    = this.bookingService.selectedSeats;
  readonly passengers       = this.bookingService.passengers;
  readonly searchParams     = this.bookingService.searchParams;
  readonly bookingReference = this.bookingService.bookingReference;

  readonly ticketTotal = computed(() => {
    const bus = this.selectedBus();
    return bus ? bus.price * this.selectedSeats().length : 0;
  });
  readonly total = computed(() => this.ticketTotal() + 2000);

  ngOnInit(): void {
    if (!this.selectedBus() || !this.bookingReference())
      this.router.navigate(['/']);
  }

  downloadTicket(): void  { alert('Le téléchargement sera disponible en production.'); }
  emailTicket(): void     { alert('Le billet sera envoyé à votre adresse email enregistrée.'); }

  newBooking(): void {
    this.bookingService.reset();
    this.router.navigate(['/']);
  }
}
