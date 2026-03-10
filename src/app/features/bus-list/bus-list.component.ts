import { Component, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService } from '../../core/services/booking.service';
import { I18nService } from '../../core/services/i18n.service';
import { Bus, MOCK_BUSES } from '../../core/models/booking.models';

type FilterType = 'all' | 'cheapest' | 'fastest';

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
  readonly filter        = signal<FilterType>('all');
  readonly filteredBuses = signal<Bus[]>([]);

  get filters() {
    const t = this.i18n.t().busList;
    return [
      { value: 'all'      as FilterType, label: t.filterAll      },
      { value: 'cheapest' as FilterType, label: t.filterCheapest },
      { value: 'fastest'  as FilterType, label: t.filterFastest  },
    ];
  }

  ngOnInit(): void {
    if (!this.searchParams()) { this.router.navigate(['/']); return; }
    this.updateFilteredBuses();
  }

  setFilter(f: FilterType): void {
    this.filter.set(f);
    this.updateFilteredBuses();
  }

  goBack(): void { this.router.navigate(['/']); }

  selectBus(bus: Bus): void {
    this.bookingService.setSelectedBus(bus);
    this.router.navigate(['/seats']);
  }

  getAmenityEmoji(amenity: string): string {
    const map: Record<string, string> = {
      wifi: '📶', ac: '❄️', recliner: '💺', charging: '🔌', entertainment: '🎬', blanket: '🛏️',
    };
    return map[amenity] ?? '✓';
  }

  private updateFilteredBuses(): void {
    const buses = [...MOCK_BUSES];
    if (this.filter() === 'cheapest') buses.sort((a, b) => a.price - b.price);
    else if (this.filter() === 'fastest')
      buses.sort((a, b) => this.parseDuration(a.duration) - this.parseDuration(b.duration));
    this.filteredBuses.set(buses);
  }

  private parseDuration(duration: string): number {
    const m = duration.match(/(\d+)h\s*(\d+)?m?/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2] ?? '0') : 0;
  }
}
