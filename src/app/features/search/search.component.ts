import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { POPULAR_ROUTES } from '../../core/models/booking.models';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent {
  private bookingService = inject(BookingService);
  private router = inject(Router);

  from = '';
  to = '';
  date = '';
  passengers = 1;

  readonly today = new Date().toISOString().split('T')[0];
  readonly popularRoutes = POPULAR_ROUTES;

  isFormValid(): boolean {
    return !!(this.from && this.to && this.date && this.passengers > 0);
  }

  swapLocations(): void {
    [this.from, this.to] = [this.to, this.from];
  }

  selectRoute(route: { from: string; to: string }): void {
    this.from = route.from;
    this.to = route.to;
  }

  handleSearch(): void {
    if (!this.isFormValid()) return;
    this.bookingService.setSearchParams({
      from: this.from,
      to: this.to,
      date: this.date,
      passengers: this.passengers,
    });
    this.router.navigate(['/buses']);
  }
}
