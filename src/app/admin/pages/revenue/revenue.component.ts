import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AdminDataService } from '../../services/admin-data.service';
import { StatCardComponent, BarChartComponent, ProgressComponent } from '../../components/admin-shared.component';
import { AriaryPipe, AdminDatePipe } from '../../pipes/admin.pipes';

@Component({
  selector: 'app-revenue',
  standalone: true,
  imports: [CommonModule, StatCardComponent, BarChartComponent, ProgressComponent, AriaryPipe, AdminDatePipe],
  templateUrl: './revenue.component.html',
})
export class RevenueComponent {
  readonly data   = inject(AdminDataService);
  readonly period = signal(30);

  readonly periodData = computed(() => this.data.getRevenueLast(this.period()));

  readonly total    = computed(() => this.periodData().reduce((s,r) => s + r.amount, 0));
  readonly totalBk  = computed(() => this.periodData().reduce((s,r) => s + r.bookings, 0));
  readonly avgDay   = computed(() => this.periodData().length ? Math.round(this.total() / this.periodData().length) : 0);
  readonly best     = computed(() => [...this.periodData()].sort((a,b) => b.amount - a.amount)[0]);
  readonly ticketAvg = computed(() => {
    const confirmed = this.data.bookings().filter(b => b.status !== 'cancelled');
    return confirmed.length ? Math.round(confirmed.reduce((s,b) => s + b.totalAmount, 0) / confirmed.length) : 0;
  });

  readonly chart = computed(() =>
    this.periodData().map(r => ({
      v: r.amount, label: r.date, tip: Math.round(r.amount/1000) + 'k Ar',
    }))
  );

  readonly pmMap = computed(() => {
    const m: Record<string, number> = { mvola:0, orangemoney:0, airtelmoney:0, cash:0 };
    this.data.bookings().filter(b => b.status !== 'cancelled').forEach(b => {
      if (m[b.paymentMethod] !== undefined) m[b.paymentMethod] += b.totalAmount;
    });
    const total = Object.values(m).reduce((s,v) => s+v, 0) || 1;
    return Object.entries(m).map(([k,v]) => ({ key:k, label:({mvola:'MVola',orangemoney:'Orange Money',airtelmoney:'Airtel Money',cash:'Espèces'})[k]??k, amount:v, pct:Math.round(v/total*100) }));
  });

  readonly topRoutes = computed(() => this.data.routeRevenues().slice(0, 6));

  readonly tableRows = computed(() => [...this.periodData()].reverse().slice(0, 30));

  pmColor(key: string): string {
    return ({ mvola:'var(--a-amber)', orangemoney:'#fb923c', airtelmoney:'var(--a-red)', cash:'var(--a-green)' })[key] ?? 'var(--a-cyan)';
  }

  setPeriod(p: number) { this.period.set(p); }
}
