import { Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BookingService } from '../../services/booking.service';
import { Bus, MOCK_BUSES } from '../../models/booking.models';
import { DecimalPipe } from '@angular/common';

type FilterType = 'all' | 'cheapest' | 'fastest';

@Component({
  selector: 'app-bus-list',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    <div class="space-y-6">
      <!-- Back -->
      <button (click)="goBack()" class="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors text-sm font-medium">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        Retour à la recherche
      </button>

      <!-- Search Summary -->
      @if (searchParams()) {
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div class="flex flex-wrap gap-6 items-center justify-between">
            <div class="flex items-center gap-6">
              <div>
                <p class="text-xs text-blue-600 font-medium uppercase tracking-wide">Trajet</p>
                <p class="font-bold text-slate-900">{{ searchParams()!.from }} → {{ searchParams()!.to }}</p>
              </div>
              <div>
                <p class="text-xs text-blue-600 font-medium uppercase tracking-wide">Date</p>
                <p class="font-bold text-slate-900">{{ searchParams()!.date }}</p>
              </div>
              <div>
                <p class="text-xs text-blue-600 font-medium uppercase tracking-wide">Passagers</p>
                <p class="font-bold text-slate-900">{{ searchParams()!.passengers }}</p>
              </div>
            </div>
            <button (click)="goBack()"
              class="px-4 py-2 border border-blue-300 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors">
              Modifier
            </button>
          </div>
        </div>
      }

      <!-- Filters -->
      <div class="flex gap-2">
        @for (f of filters; track f.value) {
          <button (click)="setFilter(f.value)"
            [class]="filter() === f.value
              ? 'px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium'
              : 'px-4 py-2 border border-slate-200 text-slate-700 bg-white rounded-lg text-sm font-medium hover:border-blue-300 transition-colors'">
            {{ f.label }}
          </button>
        }
      </div>

      <!-- Results count -->
      <p class="text-sm text-slate-500">{{ filteredBuses().length }} bus disponibles</p>

      <!-- Bus Cards -->
      <div class="space-y-4">
        @for (bus of filteredBuses(); track bus.id) {
          <div class="bg-white rounded-2xl border border-slate-200 hover:shadow-lg hover:border-blue-200 transition-all duration-300 overflow-hidden">
            <div class="p-6">
              <div class="flex flex-col lg:flex-row gap-6">
                <!-- Left: Bus Info -->
                <div class="flex-1 space-y-4">
                  <div class="flex items-start justify-between">
                    <div>
                      <h3 class="font-bold text-lg text-slate-900 font-display">{{ bus.name }}</h3>
                      <span class="inline-block px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-medium rounded-md mt-1">
                        {{ bus.type }}
                      </span>
                    </div>
                    <div class="flex items-center gap-1 bg-amber-50 px-2.5 py-1 rounded-lg">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                        fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                      <span class="font-semibold text-sm text-amber-700">{{ bus.rating }}</span>
                    </div>
                  </div>

                  <!-- Timing -->
                  <div class="flex items-center gap-4">
                    <div>
                      <p class="text-2xl font-bold text-slate-900">{{ bus.departure }}</p>
                      <p class="text-xs text-slate-500">{{ searchParams()?.from }}</p>
                    </div>
                    <div class="flex-1 flex items-center gap-2">
                      <div class="h-px bg-slate-200 flex-1"></div>
                      <div class="flex items-center gap-1 text-xs text-slate-500 bg-slate-50 px-2 py-1 rounded-full whitespace-nowrap">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {{ bus.duration }}
                      </div>
                      <div class="h-px bg-slate-200 flex-1"></div>
                    </div>
                    <div class="text-right">
                      <p class="text-2xl font-bold text-slate-900">{{ bus.arrival }}</p>
                      <p class="text-xs text-slate-500">{{ searchParams()?.to }}</p>
                    </div>
                  </div>

                  <!-- Amenities -->
                  <div class="flex flex-wrap gap-2">
                    @for (amenity of bus.amenities.slice(0, 4); track amenity) {
                      <span class="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium capitalize">
                        <span>{{ getAmenityEmoji(amenity) }}</span>
                        {{ amenity }}
                      </span>
                    }
                    @if (bus.amenities.length > 4) {
                      <span class="px-2.5 py-1 border border-slate-200 text-slate-500 rounded-full text-xs">
                        +{{ bus.amenities.length - 4 }} plus
                      </span>
                    }
                  </div>

                  <p class="text-xs text-slate-500">{{ bus.seatsAvailable }} places disponibles</p>
                </div>

                <!-- Right: Price -->
                <div class="lg:w-48 flex lg:flex-col items-center lg:items-end justify-between lg:justify-start gap-4">
                  <div class="text-right">
                    <p class="text-xs text-slate-500">À partir de</p>
                    <p class="text-3xl font-bold text-slate-900 font-display">{{ bus.price | number }} Ar</p>
                    <p class="text-xs text-slate-500">par personne</p>
                  </div>
                  <button (click)="selectBus(bus)"
                    class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-xl transition-all duration-200 text-sm whitespace-nowrap">
                    Choisir les sièges
                  </button>
                </div>
              </div>
            </div>
          </div>
        }
      </div>
    </div>
  `
})
export class BusListComponent implements OnInit {
  private bookingService = inject(BookingService);
  private router = inject(Router);

  readonly searchParams = this.bookingService.searchParams;
  readonly filter = signal<FilterType>('all');

  readonly filters = [
    { value: 'all' as FilterType, label: 'Tous les bus' },
    { value: 'cheapest' as FilterType, label: 'Moins cher' },
    { value: 'fastest' as FilterType, label: 'Plus rapide' },
  ];

  readonly filteredBuses = (() => {
    const buses = [...MOCK_BUSES];
    return signal<Bus[]>(buses);
  })();

  ngOnInit(): void {
    if (!this.searchParams()) {
      this.router.navigate(['/']);
      return;
    }
    this.updateFilteredBuses();
  }

  setFilter(f: FilterType): void {
    this.filter.set(f);
    this.updateFilteredBuses();
  }

  private updateFilteredBuses(): void {
    const buses = [...MOCK_BUSES];
    if (this.filter() === 'cheapest') {
      buses.sort((a, b) => a.price - b.price);
    } else if (this.filter() === 'fastest') {
      buses.sort((a, b) => this.parseDuration(a.duration) - this.parseDuration(b.duration));
    }
    this.filteredBuses.set(buses);
  }

  private parseDuration(duration: string): number {
    const match = duration.match(/(\d+)h\s*(\d+)?m?/);
    if (!match) return 0;
    return parseInt(match[1]) * 60 + (parseInt(match[2] || '0'));
  }

  getAmenityEmoji(amenity: string): string {
    const map: Record<string, string> = {
      wifi: '📶', ac: '❄️', recliner: '💺', charging: '🔌',
      entertainment: '🎬', blanket: '🛏️'
    };
    return map[amenity] || '✓';
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  selectBus(bus: Bus): void {
    this.bookingService.setSelectedBus(bus);
    this.router.navigate(['/seats']);
  }
}
