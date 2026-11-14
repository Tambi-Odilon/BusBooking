import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AdminRoutesService } from '../../services/admin-routes.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { StatCardComponent } from '../../components/admin-shared.component';
import { AriaryPipe } from '../../pipes/admin.pipes';
import { AdminRoute, RoutePriceByLayout, RouteDurationByLayout } from '../../models/admin.models';

type ModalMode = 'add' | 'edit' | 'suspend' | 'delete' | null;

@Component({
  selector: 'app-routes',
  standalone: true,
  imports: [CommonModule, FormsModule, StatCardComponent, AriaryPipe],
  templateUrl: './routes.component.html',
})
export class RoutesComponent {
  readonly svc   = inject(AdminRoutesService);
  readonly auth  = inject(AdminAuthService);
  readonly audit = inject(AdminAuditService);
  readonly toast = inject(AdminToastService);

  private fleet  = inject(AdminFleetService);
  /** Véhicules réels de la flotte (hors véhicules retirés). */
  get buses() { return this.fleet.buses().filter(b => b.status !== 'retired'); }
  /** Villes déjà connues ; une nouvelle ville saisie est créée automatiquement par le serveur. */
  readonly cities = computed(() => this.svc.cities().map(c => c.name).sort((a, b) => a.localeCompare(b)));

  // ── Filtres ──────────────────────────────────────────────────────────────
  filterStatus = signal<'all' | 'active' | 'suspended' | 'deleted'>('all');
  search       = signal('');

  readonly filtered = computed(() => {
    const q  = this.search().toLowerCase();
    const st = this.filterStatus();
    return this.svc.routes().filter(r => {
      if (st !== 'all' && r.status !== st) return false;
      if (q && !`${r.from} ${r.to} ${r.notes ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  // ── Sélection ────────────────────────────────────────────────────────────
  selected = signal<AdminRoute | null>(null);

  select(r: AdminRoute): void {
    this.selected.set(this.selected()?.id === r.id ? null : r);
    this.modal.set(null);
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  modal     = signal<ModalMode>(null);
  modalRoute = signal<AdminRoute | null>(null);

  // Formulaire Add/Edit
  form = {
    from: '', to: '', distanceKm: 0, durationMin: 0,
    basePrice: 0,
    priceBus: 0, priceMinibus16: 0, priceMinibus10: 0,
    durationBus: 0, durationMinibus16: 0, durationMinibus10: 0,
    assignedBusIds: [] as string[], notes: '',
  };

  // Formulaire suspension
  suspendForm = { reason: '', until: '', indefinite: false };

  openAdd(): void {
    this.form = { from: '', to: '', distanceKm: 0, durationMin: 0, basePrice: 0, priceBus: 0, priceMinibus16: 0, priceMinibus10: 0, durationBus: 0, durationMinibus16: 0, durationMinibus10: 0, assignedBusIds: [], notes: '' };
    this.modalRoute.set(null);
    this.modal.set('add');
  }

  openEdit(r: AdminRoute, e: Event): void {
    e.stopPropagation();
    this.form = {
      from: r.from, to: r.to, distanceKm: r.distanceKm, durationMin: r.durationMin,
      basePrice: r.basePrice,
      priceBus:       r.priceByLayout?.bus       ?? r.basePrice,
      priceMinibus16: r.priceByLayout?.minibus16  ?? r.basePrice,
      priceMinibus10: r.priceByLayout?.minibus10  ?? r.basePrice,
      durationBus:        r.durationByLayout?.bus       ?? r.durationMin,
      durationMinibus16:  r.durationByLayout?.minibus16  ?? r.durationMin,
      durationMinibus10:  r.durationByLayout?.minibus10  ?? r.durationMin,
      assignedBusIds: [...r.assignedBusIds], notes: r.notes ?? '',
    };
    this.modalRoute.set(r);
    this.modal.set('edit');
  }

  openSuspend(r: AdminRoute, e: Event): void {
    e.stopPropagation();
    this.suspendForm = { reason: r.suspendReason ?? '', until: '', indefinite: false };
    this.modalRoute.set(r);
    this.modal.set('suspend');
  }

  openDelete(r: AdminRoute, e: Event): void {
    e.stopPropagation();
    this.modalRoute.set(r);
    this.modal.set('delete');
  }

  closeModal(): void { this.modal.set(null); this.modalRoute.set(null); }

  // ── Actions ───────────────────────────────────────────────────────────────

  submitForm(): void {
    const f = this.form;
    if (!f.from || !f.to) { this.toast.error('Ville de départ et d\'arrivée obligatoires'); return; }
    if (f.from === f.to)  { this.toast.error('Départ et arrivée ne peuvent pas être identiques'); return; }

    // Prix par véhicule
    const priceByLayout: RoutePriceByLayout = {};
    if (f.priceBus > 0)       priceByLayout.bus       = f.priceBus;
    if (f.priceMinibus16 > 0) priceByLayout.minibus16 = f.priceMinibus16;
    if (f.priceMinibus10 > 0) priceByLayout.minibus10 = f.priceMinibus10;

    const prices = [f.priceBus, f.priceMinibus16, f.priceMinibus10].filter(p => p > 0);
    const basePrice = prices.length > 0 ? Math.min(...prices) : f.basePrice;
    if (basePrice <= 0) { this.toast.error('Renseignez au moins un prix de véhicule'); return; }

    // Durée par véhicule
    const durationByLayout: RouteDurationByLayout = {};
    if (f.durationBus > 0)       durationByLayout.bus       = f.durationBus;
    if (f.durationMinibus16 > 0) durationByLayout.minibus16 = f.durationMinibus16;
    if (f.durationMinibus10 > 0) durationByLayout.minibus10 = f.durationMinibus10;

    // durationMin = durée de référence (bus ou minimum)
    const durations = [f.durationBus, f.durationMinibus16, f.durationMinibus10].filter(d => d > 0);
    const durationMin = durations.length > 0 ? Math.min(...durations) : f.durationMin;

    const payload = { from: f.from, to: f.to, distanceKm: f.distanceKm, durationMin,
                      basePrice, priceByLayout, durationByLayout, assignedBusIds: f.assignedBusIds, notes: f.notes };

    if (this.modal() === 'add') {
      this.svc.add({ ...payload, status: 'active' });
      this.toast.success(`Itinéraire ${f.from} → ${f.to} créé`);
      const nr = this.svc.routes().find(x=>x.from===f.from&&x.to===f.to);
      if(nr) this.audit.log(this.auth.currentAdmin()!.id,'routes','Itinéraire créé',{severity:'success',targetId:nr.id,targetName:f.from+' → '+f.to,details:`${f.distanceKm}km · ${f.basePrice} Ar`});
    } else {
      const r = this.modalRoute()!;
      this.svc.update(r.id, payload);
      this.toast.success('Itinéraire mis à jour');
      const routeLabels: Record<string,string> = {from:'Départ',to:'Arrivée',distanceKm:'Distance (km)',durationMin:'Durée (min)',basePrice:'Prix de base',notes:'Notes',assignedBusIds:'Véhicules assignés',priceByLayout:'Prix par véhicule',durationByLayout:'Durée par véhicule'};
      // Snapshot avant modification (avant svc.update)
      const routeBefore = { from:r.from, to:r.to, distanceKm:r.distanceKm, durationMin:r.durationMin, basePrice:r.basePrice, notes:r.notes, assignedBusIds:r.assignedBusIds, priceByLayout:r.priceByLayout, durationByLayout:r.durationByLayout };
      const routeAfter  = { from:payload.from, to:payload.to, distanceKm:payload.distanceKm, durationMin:payload.durationMin, basePrice:payload.basePrice, notes:payload.notes, assignedBusIds:payload.assignedBusIds, priceByLayout:payload.priceByLayout, durationByLayout:payload.durationByLayout };
      const routeDiff = this.audit.diffObjects(routeBefore, routeAfter, routeLabels);
      this.audit.log(this.auth.currentAdmin()!.id,'routes','Itinéraire modifié',{severity:'info',targetId:this.selected()!.id,targetName:this.selected()!.from+' → '+this.selected()!.to,diff:routeDiff,adminPublicId:this.auth.currentAdmin()!.publicId});
    }
    this.closeModal();
  }

  submitSuspend(): void {
    const r = this.modalRoute()!;
    const f = this.suspendForm;
    if (!f.reason.trim()) { this.toast.error('La raison est obligatoire'); return; }
    const until = f.indefinite ? undefined : f.until || undefined;
    this.svc.suspend(r.id, f.reason, until);
    this.toast.warn(`${r.from} → ${r.to} suspendu`);
    this.audit.log(this.auth.currentAdmin()!.id,'routes','Itinéraire suspendu',{severity:'danger',targetId:r.id,targetName:r.from+' → '+r.to,details:f.reason});
    if (this.selected()?.id === r.id) this.selected.update(s => s ? { ...s, status: 'suspended' } : null);
    this.closeModal();
  }

  reactivate(r: AdminRoute, e: Event): void {
    e.stopPropagation();
    this.svc.reactivate(r.id);
    this.toast.success(`${r.from} → ${r.to} réactivé`);
    this.audit.log(this.auth.currentAdmin()!.id,'routes','Itinéraire réactivé',{severity:'success',targetId:r.id,targetName:r.from+' → '+r.to});
    if (this.selected()?.id === r.id) this.selected.update(s => s ? { ...s, status: 'active', suspendReason: undefined } : null);
  }

  confirmDelete(): void {
    const r = this.modalRoute()!;
    if (r.status !== 'deleted') {
      this.svc.softDelete(r.id);
      this.toast.warn(`${r.from} → ${r.to} archivé`);
    } else {
      this.svc.hardDelete(r.id);
      this.toast.warn(`${r.from} → ${r.to} définitivement supprimé`);
    }
    if (this.selected()?.id === r.id) this.selected.set(null);
    this.closeModal();
  }

  restore(r: AdminRoute, e: Event): void {
    e.stopPropagation();
    this.svc.restore(r.id);
    this.toast.success(`${r.from} → ${r.to} restauré`);
  }

  // ── Helpers pour les bus assignés ─────────────────────────────────────────

  toggleBus(busId: string): void {
    const ids = this.form.assignedBusIds;
    const idx = ids.indexOf(busId);
    if (idx >= 0) ids.splice(idx, 1);
    else ids.push(busId);
  }

  busAssigned(busId: string): boolean {
    return this.form.assignedBusIds.includes(busId);
  }

  busName(id: string): string {
    return this.buses.find(b => b.id === id)?.name ?? id;
  }

  busIcon(layout: string): string {
    return layout === 'bus' ? '🚌' : layout === 'minibus16' ? '🚐' : '⭐';
  }

  routeOccPct(r: AdminRoute): number {
    const max = Math.max(...this.svc.routes().map(x => x.totalRevenue), 1);
    return Math.round(r.totalRevenue / max * 100);
  }

  statusLabel(s: string): string {
    return s === 'active' ? 'Actif' : s === 'suspended' ? 'Suspendu' : 'Archivé';
  }

  get minDate(): string {
    return new Date().toISOString().split('T')[0];
  }
  getBusLayout(busId: string): string {
    return this.buses.find(b => b.id === busId)?.vehicleLayout ?? 'bus';
  }

  formMinPrice(): number {
    const prices = [this.form.priceBus, this.form.priceMinibus16, this.form.priceMinibus10].filter(p => p > 0);
    return prices.length > 0 ? Math.min(...prices) : 0;
  }

  priceForLayout(r: AdminRoute, layout: string): number {
    if (!r.priceByLayout) return r.basePrice;
    const p = (r.priceByLayout as Record<string,number>)[layout];
    return p && p > 0 ? p : r.basePrice;
  }

  durationForLayout(r: AdminRoute, layout: string): string {
    const min = r.durationByLayout
      ? ((r.durationByLayout as Record<string,number>)[layout] || r.durationMin)
      : r.durationMin;
    return this.svc.formatDuration(min);
  }
}
