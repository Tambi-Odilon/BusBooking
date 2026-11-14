import { Injectable, inject, signal } from '@angular/core';
import { ApiError, ApiService } from '../api/api.service';
import { PopularRoute, RouteAvailability, TripSlot } from '../models/booking.models';
export type { TripSlot, RouteAvailability } from '../models/booking.models';

const toSlot = (s: any): TripSlot => ({
  tripId: s.tripId, routeId: s.routeId, busId: s.vehicleId, busName: s.vehicleName, busType: s.vehicleType || '', vehicleLayout: s.vehicleLayout, capacity: s.capacity,
  departure: s.departure, arrival: s.arrival, arrivalDate: s.arrivalDate, duration: s.duration, durationMin: s.durationMin, departureAt: s.departureAt, arrivalAt: s.arrivalAt,
  serviceDate: s.serviceDate, price: s.price, seatsAvailable: s.seatsAvailable, amenities: s.amenities || [], fromStation: s.fromStation, toStation: s.toStation,
});

/** Données publiques du site client : villes desservies, itinéraires populaires, recherche de départs. Tout vient de l'API. */
@Injectable({ providedIn: 'root' })
export class SharedDataService {
  private api = inject(ApiService);
  readonly availableCities = signal<string[]>([]);
  readonly popularRoutes = signal<PopularRoute[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  private loaded = false;

  /** Villes et itinéraires populaires (appelé par l'écran de recherche ; rechargé à la demande). */
  async loadCatalog(force = false): Promise<void> {
    if (this.loaded && !force) return;
    this.loading.set(true);
    try {
      const [cities, popular] = await Promise.all([
        this.api.get<string[]>('/cities', { scope: 'none' }),
        this.api.get<any[]>('/routes/popular', { scope: 'none' }),
      ]);
      this.availableCities.set(cities);
      this.popularRoutes.set(popular.map(r => ({ from: r.fromCity, to: r.toCity, price: r.price })));
      this.loaded = true; this.loadError.set(false);
    } catch { this.loadError.set(true); }
    finally { this.loading.set(false); }
  }

  /** Départs réellement programmés et encore en vente pour ce trajet et cette date. */
  async getAvailability(from: string, to: string, date: string, passengers: number): Promise<RouteAvailability> {
    try {
      const r = await this.api.get<any>('/search', { query: { from, to, date, passengers }, scope: 'none' });
      switch (r.status) {
        case 'available': return { status: 'available', slots: (r.slots as any[]).map(toSlot) };
        case 'suspended': return { status: 'suspended', reason: r.reason ?? undefined, until: r.until ?? undefined };
        case 'not_found': return { status: 'not_found' };
        case 'full':      return { status: 'no_vehicles', reason: 'full', message: '' };
        default:          return { status: 'no_vehicles', reason: 'no_trips', message: '' };
      }
    } catch (e) {
      return { status: 'error', message: e instanceof ApiError ? e.message : '' };
    }
  }
}
