import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AdminRoutesService } from '../../services/admin-routes.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminTripsService } from '../../services/admin-trips.service';
import { StatCardComponent, ProgressComponent } from '../../components/admin-shared.component';
import { AriaryPipe } from '../../pipes/admin.pipes';
import { AdminBus, AdminTrip, VehicleLayout } from '../../models/admin.models';
import { AdminDriversService } from '../../services/admin-drivers.service';
import { AdminLiveService } from '../../services/admin-live.service';
import { AppConfigService } from '../../../core/config/app-config.service';

/** Une ligne du manifeste : un passager, son siège, le départ concerné. */
export interface ManifestRow { id: string; seats: string[]; passengerName: string; passengerPhone: string; reference: string; departure: string }

type ModalMode = 'add' | 'edit' | 'status' | 'routes' | null;
type SortKey   = 'name' | 'occ-desc' | 'trips-desc' | 'rev-desc' | 'cap';

/** Appellations proposées pour les plans fournis ; un plan personnalisé propose son propre nom. */
const VEHICLE_TYPES: Record<string, string[]> = {
  bus: ['Bus Climatisé', 'Bus Express', 'Bus Standard', 'Bus de Nuit'],
  minibus16: ['Minibus 16 pl.'],
  minibus10: ['Minibus VIP 10'],
};
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

@Component({
  selector: 'app-fleet',
  standalone: true,
  imports: [CommonModule, FormsModule, StatCardComponent, ProgressComponent, AriaryPipe],
  templateUrl: './fleet.component.html',
})
export class FleetComponent {

  readonly fleet     = inject(AdminFleetService);
  readonly routes    = inject(AdminRoutesService);
  readonly tripsSvc  = inject(AdminTripsService);
  readonly auth   = inject(AdminAuthService);
  readonly toast  = inject(AdminToastService);
  readonly driversSvc = inject(AdminDriversService);
  private live       = inject(AdminLiveService);
  readonly cfg       = inject(AppConfigService);
  readonly audit  = inject(AdminAuditService);

  // ── Filtres & tri ─────────────────────────────────────────────────────────
  filterStatus  = signal<'all'|'active'|'maintenance'|'retired'>('all');
  filterRoute   = signal<string>('all');  // route id ou 'all' ou 'unassigned'
  filterLayout  = signal<string>('all');
  sortBy        = signal<SortKey>('name');
  search        = signal('');
  viewMode      = signal<'cards'|'table'>('cards');

  readonly filtered = computed(() => {
    const st  = this.filterStatus();
    const rid = this.filterRoute();
    const ly  = this.filterLayout();
    const q   = this.search().toLowerCase();
    const srt = this.sortBy();

    let list = this.fleet.buses().filter(b => {
      if (st !== 'all' && b.status !== st) return false;
      if (ly !== 'all' && b.vehicleLayout !== ly) return false;
      if (q && !`${b.name} ${b.plateNumber} ${b.ref} ${b.driver}`.toLowerCase().includes(q)) return false;
      if (rid === 'unassigned') return this.fleet.routesForBus(b.id).length === 0;
      if (rid !== 'all') return this.fleet.routesForBus(b.id).some(r => r.id === rid);
      return true;
    });

    list = [...list].sort((a, b) => {
      if (srt === 'occ-desc')   return b.avgOccupancy - a.avgOccupancy;
      if (srt === 'trips-desc') return b.totalTrips - a.totalTrips;
      if (srt === 'rev-desc')   return b.totalRevenue - a.totalRevenue;
      if (srt === 'cap')        return b.capacity - a.capacity;
      return a.name.localeCompare(b.name);
    });
    return list;
  });

  // ── Sélection pour détail ─────────────────────────────────────────────────
  selected      = signal<AdminBus | null>(null);
  scheduleTab   = signal<'week'|'list'>('week');
  manifesteDate = signal(this.cfg.today());
  showManifeste = signal(false);
  mailManifeste = signal(false);
  manifesteMailTo = '';
  scheduleOffset = signal(0); // semaines

  readonly scheduleDays = computed(() => {
    const bus = this.selected();
    if (!bus) return [];
    const base = new Date();
    base.setDate(base.getDate() + this.scheduleOffset() * 7);
    const day = base.getDay();
    base.setDate(base.getDate() + (day === 0 ? -6 : 1 - day)); // lundi
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const ds = d.toISOString().split('T')[0];
      return {
        date: ds,
        label: d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' }),
        isToday: ds === new Date().toISOString().split('T')[0],
        trips: (this.tripsSvc.getTripsForDate(ds) as AdminTrip[]).filter((t: AdminTrip) => t.busId === bus.id),
      };
    });
  });


  select(b: AdminBus): void {
    this.selected.set(this.selected()?.id === b.id ? null : b);
    this.modal.set(null);
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  modal      = signal<ModalMode>(null);
  modalBus   = signal<AdminBus | null>(null);

  // Formulaire ajout/modif
  form = {
    name: '', vehicleLayout: 'bus' as VehicleLayout, type: '',
    plateNumber: '', driverId: '', yearBuilt: new Date().getFullYear(),
    maintenanceNote: '',
  };

  // Formulaire statut
  statusForm = { status: 'active' as AdminBus['status'], note: '' };

  // Formulaire itinéraires
  selectedRouteIds: string[] = [];

  // Helpers pour le formulaire
  /** Plans de sièges disponibles (fournis par le serveur, plans personnalisés compris). */
  get layouts(): VehicleLayout[] { return this.fleet.layouts().map(l => l.code); }
  get layoutLabels(): Record<VehicleLayout, string> {
    return Object.fromEntries(this.fleet.layouts().map(l => [l.code, `${l.code === 'minibus10' ? '⭐' : l.capacity <= 20 ? '🚐' : '🚌'} ${l.name} (${l.capacity} pl.)`]));
  }
  get currentTypeOptions(): { label: string; capacity: number }[] {
    const layout = this.fleet.layoutByCode(this.form.vehicleLayout);
    const names = VEHICLE_TYPES[this.form.vehicleLayout] ?? (layout ? [layout.name] : []);
    return names.map(label => ({ label, capacity: layout?.capacity ?? 0 }));
  }
  onLayoutChange(): void { this.form.type = this.currentTypeOptions[0]?.label ?? ''; }

  // ── Ouverture des modales ─────────────────────────────────────────────────
  openAdd(): void {
    this.form = {
      name: '', vehicleLayout: this.layouts[0] ?? 'bus', type: '',
      plateNumber: '', driverId: '', yearBuilt: new Date().getFullYear(),
      maintenanceNote: '',
    };
    this.onLayoutChange();
    this.modalBus.set(null);
    this.modal.set('add');
  }

  openEdit(b: AdminBus, e: Event): void {
    e.stopPropagation();
    this.form = {
      name: b.name, vehicleLayout: b.vehicleLayout,
      type: b.type, plateNumber: b.plateNumber,
      driverId: this.driversSvc.driverOfBus(b.id)?.id ?? '', yearBuilt: b.yearBuilt ?? 2020,
      maintenanceNote: b.maintenanceNote ?? '',
    };
    this.modalBus.set(b);
    this.modal.set('edit');
  }

  openStatus(b: AdminBus, e: Event): void {
    e.stopPropagation();
    this.statusForm = { status: b.status, note: b.maintenanceNote ?? '' };
    this.modalBus.set(b);
    this.modal.set('status');
  }

  openRoutes(b: AdminBus, e: Event): void {
    e.stopPropagation();
    this.selectedRouteIds = this.fleet.routesForBus(b.id).map(r => r.id);
    this.modalBus.set(b);
    this.modal.set('routes');
  }

  closeModal(): void { this.modal.set(null); this.modalBus.set(null); }

  // ── Soumissions ───────────────────────────────────────────────────────────
  submitForm(): void {
    const f = this.form;
    if (!f.name.trim())        { this.toast.error('Le nom est obligatoire'); return; }
    if (!f.plateNumber.trim()) { this.toast.error('Le matricule est obligatoire'); return; }

    const patch = {
      name: f.name.trim(),
      vehicleLayout: f.vehicleLayout,
      type: f.type,
      capacity: this.fleet.layoutByCode(f.vehicleLayout)?.capacity ?? 0,
      plateNumber: f.plateNumber.toUpperCase(),
      driver: this.driversSvc.drivers().find(d => d.id === f.driverId) ? this.driversSvc.fullName(this.driversSvc.drivers().find(d => d.id === f.driverId)!) : '—',
      yearBuilt: f.yearBuilt,
      maintenanceNote: f.maintenanceNote || undefined,
      status: 'active' as const,
    };

    if (this.modal() === 'add') {
      const bus = this.fleet.add(patch);
      this.toast.success(`${bus.name} (${bus.ref}) ajouté à la flotte`);
      this.audit.log(this.auth.currentAdmin()!.id,'fleet','Véhicule ajouté',{severity:'success',targetId:bus.id,targetName:bus.name,details:bus.type+' · '+bus.plateNumber});
    } else {
      const b = this.modalBus()!;
      const busBefore = this.modalBus()!;
      const busLabels: Record<string,string> = {name:'Nom',type:'Type',plateNumber:'Immatriculation',driver:'Chauffeur',status:'Statut',capacity:'Capacité'};
      const busDiff = this.audit.diffObjects(busBefore, patch, busLabels);
      this.fleet.update(b.id, patch);
      // chauffeur habituel : géré côté chauffeurs (un véhicule n'a qu'un chauffeur attitré)
      const before = this.driversSvc.driverOfBus(b.id)?.id ?? '';
      if (f.driverId !== before) { if (f.driverId) this.driversSvc.assignBus(f.driverId, b.id); else if (before) this.driversSvc.assignBus(before, null); }
      this.toast.success('Véhicule mis à jour');
      this.audit.log(this.auth.currentAdmin()!.id,'fleet','Véhicule modifié',{severity:'info',targetId:busBefore.id,targetName:busBefore.name,diff:busDiff,adminPublicId:this.auth.currentAdmin()!.publicId});
      // Sync selected panel
      this.selected.update(s => s?.id === b.id
        ? { ...s, ...patch, ref: this.fleet.buses().find(x => x.id === b.id)!.ref }
        : s);
    }
    this.closeModal();
  }

  submitStatus(): void {
    const b = this.modalBus()!;
    this.fleet.setStatus(b.id, this.statusForm.status, this.statusForm.note || undefined);
    const labels: Record<string, string> = { active: 'En service', maintenance: 'En maintenance', retired: 'Hors service' };
    this.toast.success(`${b.name} → ${labels[this.statusForm.status]}`);
    const statusDiff = this.audit.diffObjects({status:b.status},{status:this.statusForm.status},{status:'Statut'});
    this.audit.log(this.auth.currentAdmin()!.id,'fleet','Statut véhicule modifié',{severity:'warning',targetId:b.id,targetName:b.name,diff:statusDiff,adminPublicId:this.auth.currentAdmin()!.publicId});
    this.selected.update(s => s?.id === b.id ? { ...s, status: this.statusForm.status } : s);
    this.closeModal();
  }

  submitRoutes(): void {
    const b = this.modalBus()!;
    this.fleet.assignRoutes(b.id, this.selectedRouteIds);
    this.toast.success(`Itinéraires mis à jour pour ${b.name}`);
    this.audit.log(this.auth.currentAdmin()!.id,'fleet','Itinéraires du véhicule mis à jour',{severity:'info',targetId:b.id,targetName:b.name});
    this.closeModal();
  }

  toggleRoute(id: string): void {
    const idx = this.selectedRouteIds.indexOf(id);
    if (idx >= 0) this.selectedRouteIds.splice(idx, 1);
    else this.selectedRouteIds.push(id);
  }

  routeSelected(id: string): boolean { return this.selectedRouteIds.includes(id); }

  // ── Helpers d'affichage ───────────────────────────────────────────────────
  busIcon(l: string): string { return l === 'bus' ? '🚌' : l === 'minibus16' ? '🚐' : '⭐'; }

  occColor(pct: number): string {
    return pct >= 85 ? 'var(--a-green)' : pct >= 60 ? 'var(--a-cyan)' : 'var(--a-amber)';
  }

  statusBg(s: string): string {
    return s === 'active' ? 'rgba(16,185,129,.1)' : s === 'maintenance' ? 'rgba(245,158,11,.1)' : 'rgba(239,68,68,.1)';
  }
  statusColor(s: string): string {
    return s === 'active' ? 'var(--a-green)' : s === 'maintenance' ? 'var(--a-amber)' : 'var(--a-red)';
  }
  statusLabel(s: string): string {
    return s === 'active' ? 'En service' : s === 'maintenance' ? 'Maintenance' : 'Hors service';
  }
  statusBarColor(s: string): string {
    return s === 'active' ? 'var(--a-green)' : s === 'maintenance' ? 'var(--a-amber)' : 'var(--a-red)';
  }

  clearFilters(): void {
    this.filterStatus.set('all'); this.filterRoute.set('all');
    this.filterLayout.set('all'); this.search.set('');
    this.sortBy.set('name'); this.selected.set(null);
  }

  hasFilters(): boolean {
    return this.filterStatus() !== 'all' || this.filterRoute() !== 'all' ||
           this.filterLayout() !== 'all' || this.search() !== '';
  }

  readonly currentYear = new Date().getFullYear();

  schedPrevWeek(): void { this.scheduleOffset.update(w => w-1); }
  schedNextWeek(): void { this.scheduleOffset.update(w => w+1); }
  schedToday():    void { this.scheduleOffset.set(0); }

  tripStatusColor(s: string): string {
    return { scheduled:'var(--a-cyan)', cancelled:'var(--a-red)',
             completed:'var(--a-green)', in_progress:'var(--a-amber)' }[s] ?? 'var(--a-tx3)';
  }

  busActiveTrips(busId: string): AdminTrip[] {
    return (this.tripsSvc.trips() as AdminTrip[])
      .filter((t: AdminTrip) => t.busId === busId && t.status !== 'cancelled');
  }

  busActiveTripsCount(busId: string): number {
    return this.busActiveTrips(busId).length;
  }

  // ── Manifeste de voyage (chargé depuis le serveur, par véhicule et par date) ─────────────
  private manifestCache = signal<Record<string, { rows: ManifestRow[]; seats: string[] }>>({});
  private manifestLoading = new Set<string>();
  private manifestFor(busId: string): { rows: ManifestRow[]; seats: string[] } {
    const key = busId + '|' + this.manifesteDate();
    const hit = this.manifestCache()[key];
    if (!hit && !this.manifestLoading.has(key) && !busId.startsWith('tmp-')) {
      this.manifestLoading.add(key);
      // chargement différé : on ne modifie pas l'état pendant l'affichage
      queueMicrotask(() => void this.loadManifest(busId, this.manifesteDate(), key));
    }
    return hit ?? { rows: [], seats: [] };
  }
  private async loadManifest(busId: string, date: string, key: string): Promise<void> {
    try {
      const trips = (await this.live.trips(date, date, { vehicleId: busId })).filter(t => t.status !== 'cancelled');
      const rows: ManifestRow[] = []; let seats: string[] = [];
      for (const t of trips) {
        const m = await this.live.manifest(t.id);
        seats = m.layout.rows.flatMap(r => r.seats.filter(Boolean) as string[]);
        for (const p of m.passengers.filter(x => x.status !== 'cancelled'))
          rows.push({ id: p.id, seats: [p.seatNo], passengerName: `${p.firstName} ${p.lastName}`.trim(), passengerPhone: p.phone || p.contactPhone || '', reference: p.reference, departure: t.departure });
      }
      rows.sort((a, b) => a.departure.localeCompare(b.departure) || a.seats[0].localeCompare(b.seats[0], undefined, { numeric: true }));
      this.manifestCache.update(c => ({ ...c, [key]: { rows, seats } }));
    } catch { this.manifestCache.update(c => ({ ...c, [key]: { rows: [], seats: [] } })); this.toast.error('Manifeste indisponible pour le moment'); }
    finally { this.manifestLoading.delete(key); }
  }
  refreshManifeste(busId: string): void { const key = busId + '|' + this.manifesteDate(); this.manifestCache.update(c => { const n = { ...c }; delete n[key]; return n; }); }
  manifesteBookings(busId: string): ManifestRow[] { return this.manifestFor(busId).rows; }

  printManifeste(b: AdminBus): void {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(this.buildManifestHtml(b));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  downloadManifeste(b: AdminBus): void {
    const html = this.buildManifestHtml(b);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], {type:'text/html'}));
    a.download = 'manifeste-' + esc(b.plateNumber) + '-' + this.manifesteDate() + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    this.toast.success('Manifeste téléchargé');
  }

  sendManifeste(b: AdminBus): void {
    if (!this.manifesteMailTo.includes('@')) { this.toast.error('Email invalide'); return; }
    const bookings = this.manifesteBookings(b.id);
    const subject  = encodeURIComponent('[' + this.cfg.name() + '] Manifeste ' + esc(b.name) + ' — ' + this.manifesteDate());
    const lines    = bookings.flatMap(bk => bk.seats.map((s: string) => s + ': ' + bk.passengerName + ' (' + bk.passengerPhone + ') Réf: ' + bk.reference));
    const body     = encodeURIComponent(
      'Manifeste de voyage — ' + esc(b.name) + ' (' + esc(b.plateNumber) + ')\n'
      + 'Date : ' + this.manifesteDate() + '\n'
      + 'Passagers confirmés : ' + bookings.length + ' / ' + b.capacity + ' places\n\n'
      + (lines.length ? lines.join('\n') : 'Aucune réservation')
      + '\n\n— ' + this.cfg.name()
    );
    window.open('mailto:' + this.manifesteMailTo + '?subject=' + subject + '&body=' + body);
    this.toast.success('Client email ouvert');
    this.mailManifeste.set(false);
  }

  private buildManifestHtml(b: AdminBus): string {
    const date     = this.manifesteDate();
    const { rows: bookings, seats: allSeats } = this.manifestFor(b.id);
    const taken = new Set(bookings.flatMap(bk => bk.seats));
    const bookedCount = bookings.length;

    let rows = '';
    bookings.forEach((bk, i) => {
      rows += '<tr style="background:' + (i%2===0?'#fff':'#f8fafc') + '">'
        + '<td style="padding:7px 12px;font-family:monospace;font-weight:700;color:#0891b2">' + esc(bk.seats.join(', ')) + '</td>'
        + '<td style="padding:7px 12px;font-weight:600">' + esc(bk.passengerName) + '</td>'
        + '<td style="padding:7px 12px;color:#475569">' + esc(bk.passengerPhone) + '</td>'
        + '<td style="padding:7px 12px;font-family:monospace;font-size:11px;color:#64748b">' + esc(bk.reference) + ' · ' + esc(bk.departure) + '</td>'
        + '<td style="padding:7px 12px"><span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">Confirmé</span></td>'
        + '</tr>';
    });
    allSeats.filter(s => !taken.has(s)).forEach(seat => {
      rows += '<tr style="background:#f8fafc">'
        + '<td style="padding:7px 12px;font-family:monospace;color:#94a3b8">' + esc(seat) + '</td>'
        + '<td style="padding:7px 12px;color:#94a3b8;font-style:italic">— Libre —</td>'
        + '<td></td><td></td>'
        + '<td style="padding:7px 12px"><span style="background:#f1f5f9;color:#94a3b8;padding:2px 8px;border-radius:4px;font-size:11px">Disponible</span></td>'
        + '</tr>';
    });

    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<title>Manifeste — ' + esc(b.name) + ' — ' + esc(date) + '</title>'
      + '<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:32px auto;color:#1e293b}'
      + '.header{background:#0891b2;color:#fff;padding:24px;border-radius:12px;margin-bottom:24px}'
      + '.stats{display:flex;gap:16px;margin-bottom:24px}'
      + '.stat{background:#f1f5f9;padding:14px 20px;border-radius:8px;text-align:center;flex:1}'
      + '.stat .val{font-size:24px;font-weight:800;color:#0891b2}'
      + '.stat .lbl{font-size:11px;color:#64748b;margin-top:4px}'
      + 'table{width:100%;border-collapse:collapse}th{background:#f8fafc;padding:9px 12px;text-align:left;font-size:12px;font-weight:700;color:#64748b;border-bottom:2px solid #e2e8f0}'
      + '@media print{body{margin:0}}'
      + '</style></head><body>'
      + '<div class="header"><div style="font-size:22px;font-weight:800">' + esc(b.name) + ' · ' + esc(b.plateNumber) + '</div>'
      + '<div style="opacity:.85;font-size:13px;margin-top:6px">Manifeste de voyage · ' + esc(date) + ' · ' + esc(b.type) + '</div></div>'
      + '<div class="stats">'
      + '<div class="stat"><div class="val">' + b.capacity + '</div><div class="lbl">Places totales</div></div>'
      + '<div class="stat"><div class="val" style="color:#10b981">' + bookedCount + '</div><div class="lbl">Réservées</div></div>'
      + '<div class="stat"><div class="val" style="color:#f59e0b">' + (b.capacity - bookedCount) + '</div><div class="lbl">Disponibles</div></div>'
      + '<div class="stat"><div class="val">' + (b.capacity ? Math.round(bookedCount/b.capacity*100) : 0) + '%</div><div class="lbl">Occupation</div></div>'
      + '</div>'
      + '<table><thead><tr><th>Siège</th><th>Passager</th><th>Téléphone</th><th>Référence</th><th>Statut</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<div style="margin-top:24px;font-size:11px;color:#94a3b8;text-align:center">' + esc(this.cfg.name()) + ' — Manifeste généré le ' + new Date().toLocaleString('fr-FR') + '</div>'
      + '</body></html>';
  }
}
