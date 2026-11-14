import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService }    from '../../core/services/booking.service';
import { I18nService }       from '../../core/services/i18n.service';
import { SharedDataService } from '../../core/services/shared-data.service';
import { AppConfigService }  from '../../core/config/app-config.service';
import { Bus, RouteAvailability, TripSlot, VehicleLayout } from '../../core/models/booking.models';
import { MoneyPipe, AppDatePipe } from '../../core/pipes/format.pipes';

type SortFilter = 'all' | 'cheapest' | 'fastest';
type TypeFilter = 'all' | VehicleLayout;

@Component({
  selector: 'app-bus-list',
  standalone: true,
  imports: [CommonModule, MoneyPipe, AppDatePipe],
  templateUrl: './bus-list.component.html',
  styleUrl:    './bus-list.component.scss',
})
export class BusListComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router         = inject(Router);
  readonly i18n          = inject(I18nService);
  readonly shared        = inject(SharedDataService);
  readonly cfg           = inject(AppConfigService);

  readonly searchParams = this.bookingService.searchParams;
  readonly sortFilter   = signal<SortFilter>('all');
  readonly typeFilter   = signal<TypeFilter>('all');
  readonly loading      = signal(true);
  availability = signal<RouteAvailability | null>(null);

  readonly allSlots = computed<TripSlot[]>(() => { const av = this.availability(); return av?.status === 'available' ? av.slots : []; });
  readonly filteredSlots = computed<TripSlot[]>(() => {
    const slots = this.typeFilter() !== 'all' ? this.allSlots().filter(s => s.vehicleLayout === this.typeFilter()) : [...this.allSlots()];
    if (this.sortFilter() === 'cheapest') slots.sort((a, b) => a.price - b.price);
    else if (this.sortFilter() === 'fastest') slots.sort((a, b) => a.durationMin - b.durationMin);
    else slots.sort((a, b) => a.departureAt.localeCompare(b.departureAt));
    return slots;
  });
  get sortFilters(): { value: SortFilter; label: string }[] {
    const t = this.i18n.t().busList;
    return [{ value: 'all', label: t.filterAll }, { value: 'cheapest', label: t.filterCheapest }, { value: 'fastest', label: t.filterFastest }];
  }
  /** Filtres par type de véhicule : seulement ceux présents dans les résultats. */
  get typeFilters(): { value: TypeFilter; label: string; emoji: string }[] {
    const t = this.i18n.t().busList;
    const known: Record<string, { label: string; emoji: string }> = {
      bus: { label: t.filterBus, emoji: '🚌' }, minibus16: { label: t.filterMinibus16, emoji: '🚐' }, minibus10: { label: t.filterMinibus10, emoji: '⭐' } };
    const present = [...new Set(this.allSlots().map(s => s.vehicleLayout))];
    if (present.length < 2) return [];
    return [{ value: 'all', label: t.filterAll, emoji: '' }, ...present.map(l => ({ value: l, label: known[l]?.label ?? l, emoji: known[l]?.emoji ?? '🚌' }))];
  }
  ngOnInit(): void {
    if (!this.searchParams()) { this.router.navigate(['/']); return; }
    this.load();
  }
  async load(): Promise<void> {
    const sp = this.searchParams()!;
    this.loading.set(true);
    this.availability.set(await this.shared.getAvailability(sp.from, sp.to, sp.date, sp.passengers));
    this.loading.set(false);
  }
  noVehiclesMessage(av: RouteAvailability): string { return av.status === 'no_vehicles' && av.reason === 'full' ? this.i18n.t().x.full : this.i18n.t().x.noTrips; }
  setSortFilter(f: SortFilter): void { this.sortFilter.set(f); }
  setTypeFilter(f: TypeFilter): void { this.typeFilter.set(f); }
  goBack(): void { this.router.navigate(['/']); }
  selectSlot(slot: TripSlot): void {
    const bus: Bus = { id: slot.busId, tripId: slot.tripId, name: slot.busName, type: slot.busType, vehicleLayout: slot.vehicleLayout, capacity: slot.capacity,
      departure: slot.departure, arrival: slot.arrival, duration: slot.duration, price: slot.price, seatsAvailable: slot.seatsAvailable, amenities: slot.amenities, departureAt: slot.departureAt };
    this.bookingService.setSelectedBus(bus);
    this.router.navigate(['/seats']);
  }
  occupancyPct(slot: TripSlot): number { return Math.round((slot.capacity - slot.seatsAvailable) / slot.capacity * 100); }
  occupancyColor(slot: TripSlot): string { const p = this.occupancyPct(slot); return p >= 90 ? 'bg-red-400' : p >= 70 ? 'bg-amber-400' : 'bg-emerald-400'; }
  occupancyText(slot: TripSlot): string { const p = this.occupancyPct(slot); return p >= 90 ? 'text-red-600' : p >= 70 ? 'text-amber-600' : 'text-emerald-600'; }
  getLayoutEmoji(layout: VehicleLayout): string { return ({ bus: '🚌', minibus16: '🚐', minibus10: '⭐' } as Record<string, string>)[layout] ?? '🚌'; }
  getLayoutBadge(layout: VehicleLayout): string {
    return ({ bus: 'bg-blue-50 text-blue-700 border-blue-200', minibus16: 'bg-emerald-50 text-emerald-700 border-emerald-200', minibus10: 'bg-violet-50 text-violet-700 border-violet-200' } as Record<string, string>)[layout]
      ?? 'bg-slate-50 text-slate-700 border-slate-200';
  }
  getAmenityEmoji(a: string): string { return ({ wifi: '📶', ac: '❄️', recliner: '💺', charging: '🔌', entertainment: '🎬', blanket: '🛏️' } as Record<string, string>)[a] ?? '✓'; }
}
