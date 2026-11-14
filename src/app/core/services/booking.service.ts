import { Injectable, effect, signal } from '@angular/core';
import { ApiBooking, Bus, HoldInfo, Passenger, SearchParams } from '../models/booking.models';
import { store } from '../storage';

interface FlowState {
  searchParams: SearchParams | null; selectedBus: Bus | null; selectedSeats: string[]; passengers: Passenger[];
  hold: HoldInfo | null; booking: ApiBooking | null; contactEmail: string; bookingReference: string | null; idempotencyKey: string | null; paymentKey: string | null;
}
const EMPTY: FlowState = { searchParams: null, selectedBus: null, selectedSeats: [], passengers: [], hold: null, booking: null, contactEmail: '', bookingReference: null, idempotencyKey: null, paymentKey: null };

/**
 * État du parcours de réservation en cours (recherche → siège → passagers → paiement → billet).
 * Il est conservé dans la session du navigateur pour survivre à un rafraîchissement de page ou à une coupure réseau ;
 * la réservation elle-même vit sur le serveur.
 */
@Injectable({ providedIn: 'root' })
export class BookingService {
  private readonly initial: FlowState = { ...EMPTY, ...store.get<Partial<FlowState>>('flow', {}, true) };

  readonly searchParams     = signal<SearchParams | null>(this.initial.searchParams);
  readonly selectedBus      = signal<Bus | null>(this.initial.selectedBus);
  readonly selectedSeats    = signal<string[]>(this.initial.selectedSeats);
  readonly passengers       = signal<Passenger[]>(this.initial.passengers);
  /** Verrou temporaire des sièges accordé par le serveur. */
  readonly hold             = signal<HoldInfo | null>(this.initial.hold);
  /** Réservation créée sur le serveur (en attente de paiement, puis confirmée). */
  readonly booking          = signal<ApiBooking | null>(this.initial.booking);
  readonly bookingReference = signal<string | null>(this.initial.bookingReference);
  /** Adresse où envoyer le billet (facultative pour un invité). */
  readonly contactEmail     = signal<string>(this.initial.contactEmail);
  /** Clés d'idempotence du parcours : un double clic ou un rafraîchissement rejoue la même requête au lieu d'en créer une autre. */
  idempotencyKey: string | null = this.initial.idempotencyKey;
  paymentKey: string | null = this.initial.paymentKey;

  constructor() {
    effect(() => store.set('flow', { searchParams: this.searchParams(), selectedBus: this.selectedBus(), selectedSeats: this.selectedSeats(), passengers: this.passengers(),
      hold: this.hold(), booking: this.booking(), contactEmail: this.contactEmail(), bookingReference: this.bookingReference(), idempotencyKey: this.idempotencyKey, paymentKey: this.paymentKey } satisfies FlowState, true));
  }
  setSearchParams(params: SearchParams): void {
    this.searchParams.set(params);
    this.selectedBus.set(null); this.selectedSeats.set([]); this.passengers.set([]);
    this.hold.set(null); this.booking.set(null); this.bookingReference.set(null);
    this.idempotencyKey = null; this.paymentKey = null;
  }
  setSelectedBus(bus: Bus): void {
    this.selectedBus.set(bus); this.selectedSeats.set([]); this.passengers.set([]);
    this.hold.set(null); this.booking.set(null); this.bookingReference.set(null);
    this.idempotencyKey = null; this.paymentKey = null;
  }
  setSelectedSeats(seats: string[]): void { this.selectedSeats.set(seats); }
  setPassengers(passengers: Passenger[]): void { this.passengers.set(passengers); }
  setBookingReference(ref: string): void { this.bookingReference.set(ref); }
  setBooking(b: ApiBooking | null): void {
    // le jeton d'accès de l'invité n'est renvoyé qu'à la création : on le conserve lors des relectures
    const token = b?.accessToken ?? this.booking()?.accessToken;
    this.booking.set(b ? { ...b, accessToken: token } : null);
    if (b) this.bookingReference.set(b.reference);
  }
  reset(): void {
    this.searchParams.set(null); this.selectedBus.set(null); this.selectedSeats.set([]); this.passengers.set([]);
    this.hold.set(null); this.booking.set(null); this.bookingReference.set(null);
    this.idempotencyKey = null; this.paymentKey = null;
    store.remove('flow', true);
  }
}
