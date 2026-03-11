import { Component, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { Bus, VehicleLayout, MOCK_BUSES } from '../../core/models/booking.models';

type SortFilter  = 'all' | 'cheapest' | 'fastest';
type TypeFilter  = 'all' | VehicleLayout;

@Component({
  selector: 'app-bus-list',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './bus-list.component.html',
  styleUrl: './bus-list.component.scss',
})
export class BusListComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);
  readonly i18n = inject(I18nService);

  readonly searchParams  = this.bookingService.searchParams;
  readonly sortFilter    = signal<SortFilter>('all');
  readonly typeFilter    = signal<TypeFilter>('all');
  readonly filteredBuses = signal<Bus[]>([]);

  get sortFilters(): { value: SortFilter; label: string }[] {
    const t = this.i18n.t().busList;
    return [
      { value: 'all',      label: t.filterAll      },
      { value: 'cheapest', label: t.filterCheapest },
      { value: 'fastest',  label: t.filterFastest  },
    ];
  }

  get typeFilters(): { value: TypeFilter; label: string; emoji: string }[] {
    const t = this.i18n.t().busList;
    return [
      { value: 'all',        label: t.filterAll,        emoji: '🚌🚐⭐' },
      { value: 'bus',        label: t.filterBus,        emoji: '🚌' },
      { value: 'minibus16',  label: t.filterMinibus16,  emoji: '🚐' },
      { value: 'minibus10',  label: t.filterMinibus10,  emoji: '⭐' },
    ];
  }

  ngOnInit(): void {
    if (!this.searchParams()) { this.router.navigate(['/']); return; }
    this.applyFilters();
  }

  setSortFilter(f: SortFilter): void { this.sortFilter.set(f); this.applyFilters(); }
  setTypeFilter(f: TypeFilter): void { this.typeFilter.set(f); this.applyFilters(); }

  goBack(): void { this.router.navigate(['/']); }

  selectBus(bus: Bus): void {
    this.bookingService.setSelectedBus(bus);
    this.router.navigate(['/seats']);
  }

  getLayoutEmoji(layout: VehicleLayout): string {
    return { bus: '🚌', minibus16: '🚐', minibus10: '⭐' }[layout];
  }

  getLayoutBadgeClass(layout: VehicleLayout): string {
    return {
      bus:       'bg-blue-50 text-blue-700 border-blue-200',
      minibus16: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      minibus10: 'bg-violet-50 text-violet-700 border-violet-200',
    }[layout];
  }

  getAmenityEmoji(amenity: string): string {
    const map: Record<string, string> = {
      wifi: '📶', ac: '❄️', recliner: '💺', charging: '🔌', entertainment: '🎬', blanket: '🛏️',
    };
    return map[amenity] ?? '✓';
  }

  private applyFilters(): void {
    let buses = [...MOCK_BUSES];

    // Type filter
    if (this.typeFilter() !== 'all')
      buses = buses.filter(b => b.vehicleLayout === this.typeFilter());

    // Sort
    if (this.sortFilter() === 'cheapest') buses.sort((a, b) => a.price - b.price);
    else if (this.sortFilter() === 'fastest')
      buses.sort((a, b) => this.parseDuration(a.duration) - this.parseDuration(b.duration));

    this.filteredBuses.set(buses);
  }

  private parseDuration(duration: string): number {
    const m = duration.match(/(\d+)h\s*(\d+)?m?/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2] ?? '0') : 0;
  }
}
