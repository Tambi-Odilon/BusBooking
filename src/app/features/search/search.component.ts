import { Component, DoCheck, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { BookingService }    from '../../core/services/booking.service';
import { I18nService }       from '../../core/services/i18n.service';
import { SharedDataService } from '../../core/services/shared-data.service';
import { AppConfigService }  from '../../core/config/app-config.service';
import { RouteAvailability } from '../../core/models/booking.models';
import { MoneyPipe, AppDatePipe } from '../../core/pipes/format.pipes';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [FormsModule, CommonModule, MoneyPipe, AppDatePipe],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent implements OnInit, DoCheck {
  private bookingService = inject(BookingService);
  private router         = inject(Router);
  readonly i18n          = inject(I18nService);
  readonly shared        = inject(SharedDataService);
  readonly cfg           = inject(AppConfigService);

  from       = this.bookingService.searchParams()?.from ?? '';
  to         = this.bookingService.searchParams()?.to ?? '';
  date       = '';
  passengers = this.bookingService.searchParams()?.passengers ?? 1;

  /** Bornes du calendrier : aujourd'hui (fuseau de la société) → fin de l'horizon de vente. */
  readonly today   = this.cfg.today();
  readonly maxDate = computed(() => this.cfg.today(this.cfg.booking().salesHorizonDays));
  readonly maxPassengers = computed(() => this.cfg.booking().maxPassengers);
  readonly passengerChoices = computed(() => Array.from({ length: this.maxPassengers() }, (_, i) => i + 1));

  showFromList = signal(false);
  showToList   = signal(false);
  private readonly typed = signal({ from: '', to: '' });

  /** Villes proposées : uniquement celles desservies par au moins un itinéraire actif. */
  readonly allCities = computed<string[]>(() => this.shared.availableCities());
  private filter(q: string, exclude: string): string[] {
    const query = q.toLowerCase().trim();
    const all = this.allCities().filter(c => c !== exclude);
    if (!query || all.includes(q)) return all;
    const starts = all.filter(c => c.toLowerCase().startsWith(query));
    return [...starts, ...all.filter(c => !c.toLowerCase().startsWith(query) && c.toLowerCase().includes(query))];
  }
  readonly fromFiltered = computed<string[]>(() => this.filter(this.typed().from, this.typed().to));
  readonly toFiltered   = computed<string[]>(() => this.filter(this.typed().to, this.typed().from));
  readonly activeCities = computed(() => new Set(this.shared.availableCities()));

  /** Aperçu de la disponibilité, demandé au serveur dès que le trajet et la date sont renseignés. */
  readonly previewAvail = signal<RouteAvailability | null>(null);
  readonly previewLoading = signal(false);
  private previewKey = '';
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  readonly popularRoutes = this.shared.popularRoutes;

  ngOnInit(): void { this.shared.loadCatalog(); }
  ngDoCheck(): void {
    const t = this.typed();
    if (t.from !== this.from || t.to !== this.to) this.typed.set({ from: this.from, to: this.to });
    const key = this.isFormValid() ? [this.from, this.to, this.date, this.passengers].join('|') : '';
    if (key === this.previewKey) return;
    this.previewKey = key;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (!key) { this.previewAvail.set(null); this.previewLoading.set(false); return; }
    this.previewLoading.set(true);
    this.previewTimer = setTimeout(async () => {
      const av = await this.shared.getAvailability(this.from, this.to, this.date, this.passengers);
      if (key === this.previewKey) { this.previewAvail.set(av); this.previewLoading.set(false); }
    }, 350);
  }
  isFormValid(): boolean { return !!(this.from && this.to && this.date && this.passengers > 0 && this.from !== this.to); }
  canSearch(): boolean { return this.isFormValid(); }
  noVehiclesMessage(av: RouteAvailability): string {
    if (av.status !== 'no_vehicles') return '';
    return av.reason === 'full' ? this.i18n.t().x.full : this.i18n.t().x.noTrips;
  }
  swapLocations(): void { [this.from, this.to] = [this.to, this.from]; }
  pickFrom(city: string): void {
    this.from = city; this.showFromList.set(false);
    if (!this.to) setTimeout(() => this.showToList.set(true), 50);
  }
  pickTo(city: string): void { this.to = city; this.showToList.set(false); }
  pickRoute(r: { from: string; to: string }): void { this.from = r.from; this.to = r.to; if (!this.date) this.date = this.cfg.today(1); }
  clearFrom(): void { this.from = ''; this.showFromList.set(true); }
  clearTo():   void { this.to   = ''; this.showToList.set(true); }
  handleSearch(): void {
    if (!this.canSearch()) return;
    this.bookingService.setSearchParams({ from: this.from, to: this.to, date: this.date, passengers: this.passengers });
    this.router.navigate(['/buses']);
  }
}
