import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { StatCardComponent, SeatMapComponent } from '../../components/admin-shared.component';
import { AdminLiveService, LiveTrip, Manifest } from '../../services/admin-live.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RealtimeService } from '../../../core/realtime/realtime.service';
import { errorMessage } from '../../../core/api/api.service';
import { AriaryPipe, AdminDatePipe } from '../../pipes/admin.pipes';

const STATUS: Record<string, string> = { scheduled: 'Programmé', boarding: 'Embarquement', in_progress: 'En route', completed: 'Terminé', cancelled: 'Annulé' };

/** Sièges disponibles : les départs réels d'une journée, leur plan de sièges en direct et le manifeste des passagers. */
@Component({
  selector: 'app-seats',
  standalone: true,
  imports: [FormsModule, RouterLink, StatCardComponent, SeatMapComponent, AriaryPipe, AdminDatePipe],
  template: `
<div class="a-fade">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">
    <div>
      <div style="font-size:18px;font-weight:700;letter-spacing:-.4px">Disponibilité des sièges</div>
      <div class="a-mono" style="font-size:11px;color:var(--a-tx3);margin-top:3px">{{ date() | adminDate:'long' }} · {{ trips().length }} départ(s) · mis à jour en temps réel</div>
    </div>
    <button class="a-btn ghost sm" (click)="load()" [disabled]="loading()">↻ Actualiser</button>
  </div>

  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
    @for (d of days; track d.date) { <button [class]="'a-btn sm ' + (date() === d.date ? 'primary' : 'ghost')" (click)="setDate(d.date)">{{ d.label }}</button> }
    <input type="date" [ngModel]="date()" (ngModelChange)="setDate($event)" class="a-input" style="height:32px;width:150px;font-size:12px" aria-label="Autre date" />
    <select class="a-select" style="height:32px;font-size:12px;max-width:240px" [ngModel]="route()" (ngModelChange)="route.set($event)" aria-label="Itinéraire">
      <option value="">Tous les itinéraires</option>
      @for (r of routeNames(); track r) { <option [value]="r">{{ r }}</option> }
    </select>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px">
    <adm-stat label="Départs" [value]="stats().trips" color="a-cyan" [small]="true" />
    <adm-stat label="Places" [value]="stats().capacity" color="a-blue" [small]="true" />
    <adm-stat label="Vendues" [value]="stats().booked" color="a-red" [small]="true" />
    <adm-stat label="En cours" [value]="stats().held" color="a-amber" [small]="true" />
    <adm-stat label="Libres" [value]="stats().free" color="a-green" [small]="true" />
    <adm-stat label="Remplissage" [value]="stats().occ + ' %'" color="a-violet" [small]="true" />
  </div>

  @if (error()) { <div class="a-card" role="alert" style="border-color:var(--a-red);color:var(--a-red);margin-bottom:12px">{{ error() }} <button class="a-btn ghost sm" (click)="load()">Réessayer</button></div> }
  @if (loading() && !trips().length) { <div class="a-card" style="text-align:center;color:var(--a-tx3)">Chargement…</div> }
  @if (!loading() && !filtered().length && !error()) {
    <div class="a-card" style="text-align:center;padding:36px">
      <div style="font-size:14px;font-weight:600">Aucun départ ce jour-là</div>
      <div style="font-size:12px;color:var(--a-tx3);margin-top:6px">Les départs sont créés à partir des voyages programmés.</div>
      @if (auth.can('canViewRoutes')) { <a routerLink="/admin/trips" class="a-btn primary sm" style="margin-top:12px;display:inline-flex">Programmer un voyage</a> }
    </div>
  }

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;align-items:start">
    <div style="display:flex;flex-direction:column;gap:8px">
      @for (t of filtered(); track t.id) {
        <button type="button" class="a-card" (click)="select(t)" [attr.aria-pressed]="selected()?.id === t.id"
                [style]="'text-align:left;cursor:pointer;padding:14px;width:100%;color:inherit;font:inherit;' + (selected()?.id === t.id ? 'border-color:var(--a-cyan)' : '') + (t.status === 'cancelled' ? ';opacity:.55' : '')">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
            <span style="font-weight:700;font-size:13px">{{ t.fromCity }} → {{ t.toCity }}</span>
            <span class="a-mono" style="font-size:15px;font-weight:700;color:var(--a-cyan)">{{ cfg.time(t.departure) }}</span>
          </div>
          <div style="font-size:11px;color:var(--a-tx3);margin-top:3px">{{ t.vehicleName }} · {{ t.plateNumber }} · {{ t.driverName || 'sans chauffeur' }} · {{ t.price | ariary }}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <div class="a-progress-wrap" style="flex:1"><div class="a-progress-bar" [style.width.%]="occ(t)" [style.background]="occColor(occ(t))"></div></div>
            <span class="a-mono" style="font-size:11px;white-space:nowrap">{{ t.capacity - t.seatsTaken }} libre(s) / {{ t.capacity }}</span>
            @if (t.status !== 'scheduled') { <span class="a-badge" [style.color]="t.status === 'cancelled' ? 'var(--a-red)' : 'var(--a-amber)'">{{ statusLabel(t.status) }}</span> }
          </div>
        </button>
      }
    </div>

    @if (selected(); as t) {
      <div class="a-card" style="position:sticky;top:0" id="zone-impression">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <div>
            <div style="font-weight:700">{{ t.fromCity }} → {{ t.toCity }} · {{ cfg.time(t.departure) }}</div>
            <div style="font-size:11px;color:var(--a-tx3)">{{ t.serviceDate | adminDate:'long' }} · {{ t.vehicleName }} ({{ t.plateNumber }}) · {{ t.driverName || 'sans chauffeur' }}</div>
          </div>
          <div class="no-print" style="display:flex;gap:6px;flex-wrap:wrap">
            @if (auth.can('canSellWalkin') && t.status === 'scheduled') { <a class="a-btn primary sm" routerLink="/admin/walkin" [queryParams]="{ trip: t.id, date: t.serviceDate }">Vendre</a> }
            <button class="a-btn ghost sm" (click)="print()">Imprimer</button>
            <button class="a-btn ghost sm" (click)="csv()">CSV</button>
          </div>
        </div>
        @if (manifest(); as m) {
          <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
            <adm-seat-map [layout]="m.layout.code" [rows]="m.layout.rows" [booked]="booked()" [pending]="held()" [names]="names()" [size]="26" />
            <div style="flex:1;min-width:220px">
              <div class="a-card-title">Passagers ({{ m.passengers.length }})</div>
              @if (!m.passengers.length) { <div style="font-size:12px;color:var(--a-tx3)">Aucun billet vendu pour ce départ.</div> }
              <div class="a-table-wrap" style="max-height:420px;overflow:auto">
                <table class="a-table">
                  <thead><tr><th>Siège</th><th>Passager</th><th>Téléphone</th><th>Référence</th><th></th></tr></thead>
                  <tbody>
                    @for (p of m.passengers; track p.id) {
                      <tr>
                        <td class="a-mono" style="font-weight:700;color:var(--a-cyan)">{{ p.seatNo }}</td>
                        <td>{{ p.firstName }} {{ p.lastName }}</td>
                        <td class="a-mono">{{ p.phone || p.contactPhone }}</td>
                        <td class="a-mono" style="font-size:10px">{{ p.reference }}</td>
                        <td>@if (p.status === 'boarded') { <span style="color:var(--a-green)" title="Embarqué">✔</span> } @if (p.needsAttention) { <span style="color:var(--a-amber)" title="Réservation à traiter">⚠</span> }</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          @if (auth.can('canManageRoutes') && t.status === 'scheduled') {
            <details class="no-print" style="margin-top:14px;border-top:1px solid var(--a-border);padding-top:10px">
              <summary style="cursor:pointer;font-size:12px;font-weight:600">Incident sur ce départ (annulation, changement de véhicule)</summary>
              <div style="display:grid;gap:10px;margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
                <div>
                  <label class="a-form-label" for="veh">Remplacer le véhicule</label>
                  <select id="veh" class="a-select" [(ngModel)]="newVehicle">
                    <option value="">Choisir…</option>
                    @for (b of otherVehicles(); track b.id) { <option [value]="b.id">{{ b.name }} · {{ b.plateNumber }} ({{ b.capacity }} pl.)</option> }
                  </select>
                  <div style="font-size:10px;color:var(--a-tx3);margin:4px 0">Les passagers gardent leur siège s'il existe dans le nouveau plan ; sinon ils sont replacés et prévenus.</div>
                  <button class="a-btn ghost sm" [disabled]="!newVehicle || busy()" (click)="replace(t)">Remplacer</button>
                </div>
                <div>
                  <label class="a-form-label" for="why">Annuler ce départ</label>
                  <input id="why" class="a-input" [(ngModel)]="cancelReason" placeholder="Motif communiqué aux passagers" maxlength="300" />
                  <div style="font-size:10px;color:var(--a-tx3);margin:4px 0">Tous les billets sont annulés, remboursés intégralement et les passagers sont prévenus.</div>
                  <button class="a-btn danger sm" [disabled]="cancelReason.trim().length < 3 || busy()" (click)="cancel(t)">Annuler le départ</button>
                </div>
              </div>
            </details>
          }
        } @else { <div style="color:var(--a-tx3);font-size:12px">Chargement du plan…</div> }
      </div>
    }
  </div>
</div>`,
})
export class SeatsComponent implements OnInit, OnDestroy {
  private live = inject(AdminLiveService);
  private toast = inject(AdminToastService);
  private realtime = inject(RealtimeService);
  private fleet = inject(AdminFleetService);
  readonly auth = inject(AdminAuthService);
  readonly cfg = inject(AppConfigService);

  readonly date = signal(this.cfg.today());
  readonly route = signal('');
  readonly trips = signal<LiveTrip[]>([]);
  readonly selected = signal<LiveTrip | null>(null);
  readonly manifest = signal<Manifest | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  newVehicle = ''; cancelReason = '';
  private offs: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly days = [-1, 0, 1, 2, 3, 4, 5, 6].map(n => { const d = this.cfg.today(n); return { date: d, label: n === 0 ? "Aujourd'hui" : n === 1 ? 'Demain' : n === -1 ? 'Hier' : this.cfg.date(d).slice(0, 5) }; });
  readonly routeNames = computed(() => [...new Set(this.trips().map(t => `${t.fromCity} → ${t.toCity}`))].sort());
  readonly filtered = computed(() => this.trips().filter(t => !this.route() || `${t.fromCity} → ${t.toCity}` === this.route()));
  readonly stats = computed(() => {
    const ts = this.filtered().filter(t => t.status !== 'cancelled');
    const capacity = ts.reduce((s, t) => s + t.capacity, 0), booked = ts.reduce((s, t) => s + t.seatsBooked, 0), taken = ts.reduce((s, t) => s + t.seatsTaken, 0);
    return { trips: ts.length, capacity, booked, held: taken - booked, free: capacity - taken, occ: capacity ? Math.round(100 * taken / capacity) : 0 };
  });
  readonly booked = computed(() => (this.manifest()?.seats ?? []).filter(s => s.status === 'booked').map(s => s.seat));
  readonly held = computed(() => (this.manifest()?.seats ?? []).filter(s => s.status === 'held').map(s => s.seat));
  readonly names = computed(() => Object.fromEntries((this.manifest()?.passengers ?? []).map(p => [p.seatNo, `${p.firstName} ${p.lastName}`])));
  readonly otherVehicles = computed(() => this.fleet.active().filter(b => b.id !== this.selected()?.vehicleId));

  ngOnInit(): void {
    void this.load();
    const refresh = (p: any) => { if (this.trips().some(t => t.id === p?.tripId)) this.soon(); };
    this.offs = ['seat.held', 'seat.released', 'seat.booked', 'trip.updated', 'trip.cancelled', 'trip.vehicle_changed'].map(ev => this.realtime.on(ev, refresh));
    this.offs.push(this.realtime.on('booking.created', () => this.soon()), this.realtime.onReconnect(() => this.soon()));
  }
  ngOnDestroy(): void { this.offs.forEach(off => off()); const s = this.selected(); if (s) this.realtime.leaveTrip(s.id); if (this.timer) clearTimeout(this.timer); }
  private soon(): void { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.load(true), 400); }

  setDate(d: string): void { if (!d) return; this.date.set(d); this.select(null); void this.load(); }
  async load(quiet = false): Promise<void> {
    if (!quiet) this.loading.set(true);
    try {
      const ts = (await this.live.trips(this.date(), this.date())).sort((a, b) => a.departureAt.localeCompare(b.departureAt));
      this.trips.set(ts); this.error.set(null);
      const sel = this.selected();
      if (sel) { const fresh = ts.find(t => t.id === sel.id) ?? null; this.selected.set(fresh); if (fresh) this.manifest.set(await this.live.manifest(fresh.id)); }
    } catch (e) { if (!quiet) this.error.set(errorMessage(e, 'Chargement impossible')); }
    finally { this.loading.set(false); }
  }
  async select(t: LiveTrip | null): Promise<void> {
    const prev = this.selected();
    if (prev) this.realtime.leaveTrip(prev.id);
    this.manifest.set(null); this.newVehicle = ''; this.cancelReason = '';
    this.selected.set(t && prev?.id === t.id ? null : t);
    const cur = this.selected();
    if (!cur) return;
    this.realtime.joinTrip(cur.id);
    try { this.manifest.set(await this.live.manifest(cur.id)); } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async replace(t: LiveTrip): Promise<void> {
    this.busy.set(true);
    try { const r: any = await this.live.replaceVehicle(t.id, this.newVehicle); this.toast.success(`Véhicule remplacé${r?.moved ? ` · ${r.moved} passager(s) replacé(s)` : ''}${r?.unseated ? ` · ${r.unseated} à traiter` : ''}`); await this.load(); }
    catch (e) { this.toast.error(errorMessage(e)); } finally { this.busy.set(false); }
  }
  async cancel(t: LiveTrip): Promise<void> {
    this.busy.set(true);
    try { await this.live.cancelTrip(t.id, this.cancelReason.trim()); this.toast.success('Départ annulé : passagers prévenus et remboursements créés'); await this.load(); }
    catch (e) { this.toast.error(errorMessage(e)); } finally { this.busy.set(false); }
  }
  occ(t: LiveTrip): number { return t.capacity ? Math.round(100 * t.seatsTaken / t.capacity) : 0; }
  occColor(pct: number): string { return pct >= 80 ? 'var(--a-red)' : pct >= 50 ? 'var(--a-amber)' : 'var(--a-green)'; }
  statusLabel(s: string): string { return STATUS[s] ?? s; }
  print(): void { window.print(); }
  csv(): void {
    const t = this.selected(), m = this.manifest();
    if (!t || !m) return;
    const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['Siège', 'Prénom', 'Nom', 'Téléphone', 'Référence', 'Billet', 'Embarqué'].map(esc).join(';'),
      ...m.passengers.map(p => [p.seatNo, p.firstName, p.lastName, p.phone || p.contactPhone, p.reference, p.ticketNumber, p.boardedAt ? 'oui' : ''].map(esc).join(';'))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `manifeste-${t.serviceDate}-${t.departure.replace(':', 'h')}-${t.plateNumber}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
}
