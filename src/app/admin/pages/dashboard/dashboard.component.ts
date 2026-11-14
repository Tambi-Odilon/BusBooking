import { Component, inject, computed, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AdminDataService }   from '../../services/admin-data.service';
import { AdminAuthService }   from '../../services/admin-auth.service';
import { AdminToastService }  from '../../services/admin-toast.service';
import { AdminRoutesService } from '../../services/admin-routes.service';
import { StatCardComponent, BarChartComponent, BadgeComponent, ProgressComponent } from '../../components/admin-shared.component';
import { AriaryPipe, AdminDatePipe } from '../../pipes/admin.pipes';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RealtimeService } from '../../../core/realtime/realtime.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink, StatCardComponent, BarChartComponent,
            BadgeComponent, ProgressComponent, AriaryPipe, AdminDatePipe],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit, OnDestroy {
  readonly data      = inject(AdminDataService);
  readonly auth      = inject(AdminAuthService);
  readonly routesSvc = inject(AdminRoutesService);
  readonly cfg       = inject(AppConfigService);
  private toast      = inject(AdminToastService);
  private realtime   = inject(RealtimeService);

  readonly today  = new Date().toISOString();
  readonly routes = this.data.routeRevenues;
  /** Indicateurs calculés par le serveur à partir des ventes réelles. */
  readonly stats = this.data.stats;
  readonly liveStats = computed(() => {
    const s = this.stats();
    return { today: s.todayBookings, total: s.totalBookings, pending: s['pendingBookings'] ?? 0, todayRevenue: s.todayRevenue, tripsToday: s['tripsToday'] ?? 0,
      needsAttention: s['needsAttention'] ?? 0, manualRefunds: s['manualRefunds'] ?? 0 };
  });
  readonly recentBookings = computed(() => this.data.recentBookings().slice(0, 15));
  readonly suspendedRoutes = computed(() => this.routesSvc.routes().filter(r => r.status === 'suspended'));

  readonly revChart = computed(() => this.data.getRevenueLast(14).map(r => ({ v: r.amount, label: r.date, tip: this.cfg.money(r.amount) + ' · ' + r.bookings + ' rés.' })));
  readonly bkChart = computed(() => this.data.getRevenueLast(14).map(r => ({ v: r.bookings, label: r.date, tip: r.bookings + ' réservations' })));
  readonly maxRouteRev = computed(() => Math.max(...this.routes().map(r => r.revenue), 1));
  readonly online = computed(() => this.data.onlineActivity());
  pct(rev: number): number { return Math.round(rev / this.maxRouteRev() * 100); }

  /** Signal visuel quand une réservation arrive (événement temps réel du serveur). */
  readonly newBookingFlash = signal(false);
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;

  ngOnInit(): void {
    void this.data.load();
    this.off = this.realtime.on('booking.created', () => {
      this.newBookingFlash.set(true);
      this.toast.show('🎫 Nouvelle réservation reçue', 'success');
      if (this.flashTimer) clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => this.newBookingFlash.set(false), 3000);
    });
  }
  ngOnDestroy(): void { this.off?.(); if (this.flashTimer) clearTimeout(this.flashTimer); }

  async refresh(): Promise<void> { await this.data.load(); this.toast.show(this.data.loadError() ?? 'Données actualisées', this.data.loadError() ? 'error' : 'info'); }
}
