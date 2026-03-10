import { Injectable, signal } from '@angular/core';
import { Bus, Passenger, SearchParams } from '../models/booking.models';

@Injectable({ providedIn: 'root' })
export class BookingService {
  readonly searchParams   = signal<SearchParams | null>(null);
  readonly selectedBus    = signal<Bus | null>(null);
  readonly selectedSeats  = signal<string[]>([]);
  readonly passengers     = signal<Passenger[]>([]);
  readonly bookingReference = signal<string | null>(null);

  setSearchParams(params: SearchParams): void {
    this.searchParams.set(params);
    this.selectedBus.set(null);
    this.selectedSeats.set([]);
    this.passengers.set([]);
    this.bookingReference.set(null);
  }

  setSelectedBus(bus: Bus): void {
    this.selectedBus.set(bus);
    this.selectedSeats.set([]);
  }

  setSelectedSeats(seats: string[]): void {
    this.selectedSeats.set(seats);
  }

  setPassengers(passengers: Passenger[]): void {
    this.passengers.set(passengers);
  }

  setBookingReference(ref: string): void {
    this.bookingReference.set(ref);
  }

  reset(): void {
    this.searchParams.set(null);
    this.selectedBus.set(null);
    this.selectedSeats.set([]);
    this.passengers.set([]);
    this.bookingReference.set(null);
  }
}
