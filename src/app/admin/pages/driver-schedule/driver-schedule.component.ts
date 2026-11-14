import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminLiveService, LiveTrip, Manifest } from '../../services/admin-live.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminDriversService } from '../../services/admin-drivers.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { errorMessage } from '../../../core/api/api.service';
import { AdminDatePipe } from '../../pipes/admin.pipes';

/** Planning d'un chauffeur : ses départs des 14 prochains jours et la liste des passagers de chacun. */
@Component({
  selector: 'app-driver-schedule',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminDatePipe],
  template: `
<div class="a-fade" style="max-width:820px">
  <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
    <div>
      <div style="font-size:18px;font-weight:700;letter-spacing:-.4px">{{ auth.can('canViewDrivers') ? 'Planning chauffeur' : 'Mon planning' }}</div>
      @if (driver(); as d) { <div style="font-size:12px;color:var(--a-tx3)">{{ d.firstName }} {{ d.lastName }}</div> }
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      @if (auth.can('canViewDrivers')) {
        <select class="a-select" style="height:34px;font-size:12px" [ngModel]="driverId()" (ngModelChange)="driverId.set($event); load()" aria-label="Chauffeur">
          <option value="">Mon planning</option>
          @for (d of drivers.drivers(); track d.id) { <option [value]="d.id">{{ d.firstName }} {{ d.lastName }}</option> }
        </select>
      }
      @if (auth.can('canCheckTickets')) { <a class="a-btn primary sm" routerLink="/admin/check">Contrôler les billets</a> }
    </div>
  </div>
  @if (loading()) { <div class="a-card" style="color:var(--a-tx3)">Chargement…</div> }
  @if (error()) { <div class="a-card" role="alert" style="color:var(--a-red)">{{ error() }} <button class="a-btn ghost sm" (click)="load()">Réessayer</button></div> }
  @if (!loading() && !error() && !driver()) {
    <div class="a-card" style="text-align:center;padding:32px"><div style="font-weight:600">Aucune fiche chauffeur n'est reliée à ce compte</div>
      <div style="font-size:12px;color:var(--a-tx3);margin-top:6px">Un administrateur doit relier votre compte à votre fiche chauffeur (menu Chauffeurs).</div></div>
  }
  @if (driver() && !loading() && !trips().length) { <div class="a-card" style="text-align:center;padding:32px;color:var(--a-tx3)">Aucun départ prévu dans les 14 prochains jours.</div> }
  @for (g of groups(); track g.date) {
    <div class="a-mono" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--a-tx3);margin:16px 0 8px">{{ g.date | adminDate:'long' }}</div>
    @for (t of g.trips; track t.id) {
      <div class="a-card" style="margin-bottom:8px;padding:14px">
        <button type="button" (click)="toggle(t)" [attr.aria-expanded]="open() === t.id" style="all:unset;cursor:pointer;display:flex;justify-content:space-between;gap:10px;width:100%;align-items:center">
          <span><span class="a-mono" style="font-size:18px;font-weight:700;color:var(--a-cyan)">{{ cfg.time(t.departure) }}</span>
            <span style="font-weight:600;margin-left:10px">{{ t.fromCity }} → {{ t.toCity }}</span>
            <span style="display:block;font-size:11px;color:var(--a-tx3)">{{ t.vehicleName }} · {{ t.plateNumber }} · arrivée {{ cfg.time(t.arrival) }}</span></span>
          <span class="a-badge a-mono">{{ t.seatsBooked }} / {{ t.capacity }}</span>
        </button>
        @if (open() === t.id) {
          @if (manifest(); as m) {
            <div class="a-table-wrap" style="margin-top:10px"><table class="a-table">
              <thead><tr><th>Siège</th><th>Passager</th><th>Téléphone</th><th>Embarqué</th></tr></thead>
              <tbody>@for (p of m.passengers; track p.id) { <tr><td class="a-mono" style="font-weight:700">{{ p.seatNo }}</td><td>{{ p.firstName }} {{ p.lastName }}</td><td class="a-mono">{{ p.phone || p.contactPhone }}</td><td>{{ p.boardedAt ? '✔' : '' }}</td></tr> }
                @if (!m.passengers.length) { <tr><td colspan="4" style="color:var(--a-tx3)">Aucun passager pour le moment.</td></tr> }</tbody>
            </table></div>
          } @else { <div style="font-size:12px;color:var(--a-tx3);margin-top:8px">Chargement des passagers…</div> }
        }
      </div>
    }
  }
</div>`,
})
export class DriverScheduleComponent implements OnInit {
  private live = inject(AdminLiveService);
  readonly auth = inject(AdminAuthService);
  readonly drivers = inject(AdminDriversService);
  readonly cfg = inject(AppConfigService);
  readonly driver = signal<any | null>(null);
  readonly driverId = signal('');
  readonly trips = signal<LiveTrip[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly open = signal<string | null>(null);
  readonly manifest = signal<Manifest | null>(null);
  readonly groups = computed(() => {
    const map = new Map<string, LiveTrip[]>();
    for (const t of this.trips()) map.set(t.serviceDate, [...(map.get(t.serviceDate) ?? []), t]);
    return [...map.entries()].map(([date, trips]) => ({ date, trips }));
  });
  ngOnInit(): void { void this.load(); }
  async load(): Promise<void> {
    this.loading.set(true); this.open.set(null);
    try { const r = await this.live.mySchedule(undefined, undefined, this.driverId() || undefined); this.driver.set(r.driver); this.trips.set(r.trips); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e, 'Chargement impossible')); }
    finally { this.loading.set(false); }
  }
  async toggle(t: LiveTrip): Promise<void> {
    if (this.open() === t.id) { this.open.set(null); return; }
    this.open.set(t.id); this.manifest.set(null);
    try { this.manifest.set(await this.live.manifest(t.id)); } catch { this.open.set(null); }
  }
}
