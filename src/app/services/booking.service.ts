import { Injectable, signal, computed } from '@angular/core';
import { BookingState, SearchParams, Bus, Passenger } from '../models/booking.models';

@Injectable({
  providedIn: 'root'
})
export class BookingService {
  private readonly _state = signal<BookingState>({
    searchParams: null,
    selectedBus: null,
    selectedSeats: [],
    passengers: [],
    bookingReference: '',
  });

  // Public read-only signals
  readonly searchParams = computed(() => this._state().searchParams);
  readonly selectedBus = computed(() => this._state().selectedBus);
  readonly selectedSeats = computed(() => this._state().selectedSeats);
  readonly passengers = computed(() => this._state().passengers);
  readonly bookingReference = computed(() => this._state().bookingReference);
  readonly totalAmount = computed(() => {
    const bus = this._state().selectedBus;
    const seats = this._state().selectedSeats;
    if (!bus || !seats.length) return 0;
    return bus.price * seats.length + 2000;
  });

  setSearchParams(params: SearchParams): void {
    this._state.update(state => ({
      ...state,
      searchParams: params,
      selectedBus: null,
      selectedSeats: [],
      passengers: [],
      bookingReference: '',
    }));
  }

  setSelectedBus(bus: Bus): void {
    this._state.update(state => ({
      ...state,
      selectedBus: bus,
      selectedSeats: [],
      passengers: [],
    }));
  }

  setSelectedSeats(seats: string[]): void {
    this._state.update(state => ({ ...state, selectedSeats: seats }));
  }

  setPassengers(passengers: Passenger[]): void {
    this._state.update(state => ({ ...state, passengers }));
  }

  setBookingReference(ref: string): void {
    this._state.update(state => ({ ...state, bookingReference: ref }));
  }

  reset(): void {
    this._state.set({
      searchParams: null,
      selectedBus: null,
      selectedSeats: [],
      passengers: [],
      bookingReference: '',
    });
  }
}
