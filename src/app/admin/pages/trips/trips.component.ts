import { MoneyPipe, AppDatePipe } from '../../../core/pipes/format.pipes';
import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminTripsService }  from '../../services/admin-trips.service';
import { AdminRoutesService } from '../../services/admin-routes.service';
import { AdminFleetService }  from '../../services/admin-fleet.service';
import { AdminAuthService }   from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService }  from '../../services/admin-toast.service';
import { StatCardComponent }  from '../../components/admin-shared.component';
import { AriaryPipe }         from '../../pipes/admin.pipes';
import { AdminTrip, TripRecurrence } from '../../models/admin.models';

type ViewMode = 'calendar' | 'list';
type ModalMode = 'add' | 'edit' | 'cancel' | 'delete' | null;

function fmtDate(d: Date): string { return d.toISOString().split('T')[0]; }
function addMin(hhmm: string, min: number): string {
  const [h,m] = hhmm.split(':').map(Number);
  const t = h*60+m+min;
  return `${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
}

@Component({
  selector: 'app-trips',
  standalone: true,
  imports: [MoneyPipe, CommonModule, FormsModule, StatCardComponent, AriaryPipe],
  templateUrl: './trips.component.html',
})
export class TripsComponent implements OnInit {
  readonly tripsSvc  = inject(AdminTripsService);
  readonly routesSvc = inject(AdminRoutesService);
  readonly fleetSvc  = inject(AdminFleetService);
  readonly auth      = inject(AdminAuthService);
  readonly toast     = inject(AdminToastService);
  readonly audit = inject(AdminAuditService);

  viewMode   = signal<ViewMode>('calendar');
  modal      = signal<ModalMode>(null);
  modalTrip  = signal<AdminTrip | null>(null);
  selectedDate = signal(fmtDate(new Date()));
  weekOffset   = signal(0); // semaines depuis aujourd'hui

  // ── Semaine affichée ─────────────────────────────────────────────────────
  readonly weekDays = computed(() => {
    const base = new Date();
    base.setDate(base.getDate() + this.weekOffset() * 7);
    // Aller au lundi
    const day = base.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    base.setDate(base.getDate() + diff);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return {
        date: fmtDate(d),
        label: d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric' }),
        isToday: fmtDate(d) === fmtDate(new Date()),
        trips: this.tripsSvc.getTripsForDate(fmtDate(d)),
      };
    });
  });

  readonly selectedTrips = computed(() =>
    this.tripsSvc.getTripsForDate(this.selectedDate())
      .sort((a,b) => a.departure.localeCompare(b.departure))
  );

  // ── Filtres liste ─────────────────────────────────────────────────────────
  filterBus   = signal('all');
  filterRoute = signal('all');
  search      = signal('');

  readonly filteredTrips = computed(() => {
    const q  = this.search().toLowerCase();
    const fb = this.filterBus();
    const fr = this.filterRoute();
    return this.tripsSvc.trips().filter(t => {
      if (fb !== 'all' && t.busId !== fb) return false;
      if (fr !== 'all' && t.routeId !== fr) return false;
      if (q && !`${t.from} ${t.to} ${t.notes ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a,b) => a.departure.localeCompare(b.departure));
  });

  // ── Formulaire (champs réactifs via signals) ─────────────────────────────
  fRouteId    = signal('');
  fBusId      = signal('');
  fDeparture  = signal('07:00');
  fRecurrence = signal<TripRecurrence>('weekly');
  fDays       = signal<number[]>([]);
  fStartDate  = signal(fmtDate(new Date()));
  fEndDate    = signal('');
  fSpecificDate = signal(fmtDate((() => { const d=new Date(); d.setDate(d.getDate()+1); return d; })()));
  fPrice      = signal(0);
  fNotes      = signal('');

  cancelReason = '';

  resetForm(): void {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
    this.fRouteId.set('');
    this.fBusId.set('');
    this.fDeparture.set('07:00');
    this.fRecurrence.set('weekly');
    this.fDays.set([]);
    this.fStartDate.set(fmtDate(new Date()));
    this.fEndDate.set('');
    this.fSpecificDate.set(fmtDate(tomorrow));
    this.fPrice.set(0);
    this.fNotes.set('');
  }

  loadForm(t: AdminTrip): void {
    this.fRouteId.set(t.routeId);
    this.fBusId.set(t.busId);
    this.fDeparture.set(t.departure);
    this.fRecurrence.set(t.recurrence);
    this.fDays.set([...t.days]);
    this.fStartDate.set(t.startDate);
    this.fEndDate.set(t.endDate ?? '');
    this.fSpecificDate.set(t.specificDate ?? '');
    this.fPrice.set(t.price);
    this.fNotes.set(t.notes ?? '');
  }

  // Computed dérivés — réactifs car basés sur signals
  readonly formRoute   = computed(() => this.routesSvc.routes().find(r => r.id === this.fRouteId()));
  readonly formBus     = computed(() => this.fleetSvc.buses().find(b => b.id === this.fBusId()));
  readonly formArrival = computed(() => {
    const route = this.formRoute();
    if (!route || !this.fDeparture()) return '';
    const layout = this.formBus()?.vehicleLayout ?? 'bus';
    const dur = (route.durationByLayout as Record<string,number>)?.[layout] || route.durationMin;
    return addMin(this.fDeparture(), dur);
  });

  readonly conflictInfo = computed(() => {
    if (!this.fBusId() || !this.fDeparture() || !this.formArrival()) return null;
    const checkDate = this.fRecurrence() === 'once' ? this.fSpecificDate() : this.fStartDate();
    return this.tripsSvc.getConflictInfo(
      this.fBusId(), checkDate, this.fDeparture(), this.formArrival(),
      this.modalTrip()?.id
    );
  });

  readonly hasConflict = computed(() => this.conflictInfo() !== null);

  readonly availableBuses = computed(() => {
    const route = this.formRoute();
    if (!route) return this.fleetSvc.buses().filter(b => b.status === 'active');
    return this.fleetSvc.buses().filter(b =>
      b.status === 'active' && route.assignedBusIds.includes(b.id)
    );
  });

  readonly activeRoutes = computed(() =>
    this.routesSvc.routes().filter(r => r.status === 'active')
  );

  ngOnInit(): void {}

  // ── Actions ──────────────────────────────────────────────────────────────
  openAdd(prefillDate?: string): void {
    this.resetForm();
    if (prefillDate) this.fSpecificDate.set(prefillDate);
    this.modalTrip.set(null);
    this.modal.set('add');
  }

  openEdit(t: AdminTrip): void {
    this.loadForm(t);
    this.modalTrip.set(t); this.modal.set('edit');
  }

  openCancel(t: AdminTrip): void { this.cancelReason = ''; this.modalTrip.set(t); this.modal.set('cancel'); }
  openDelete(t: AdminTrip): void { this.modalTrip.set(t); this.modal.set('delete'); }
  closeModal(): void { this.modal.set(null); this.modalTrip.set(null); }

  submit(): void {
    if (!this.fRouteId()) { this.toast.error('Sélectionnez un itinéraire'); return; }
    if (!this.fBusId())   { this.toast.error('Sélectionnez un véhicule'); return; }
    if (!this.fDeparture()) { this.toast.error('Heure de départ obligatoire'); return; }
    const rec = this.fRecurrence();
    if (rec !== 'once' && rec !== 'daily' && rec !== 'weekdays' && rec !== 'weekends'
        && this.fDays().length === 0) {
      this.toast.error('Sélectionnez au moins un jour'); return;
    }
    const ci = this.conflictInfo();
    if (ci) { this.toast.error(ci.message); return; }

    const route = this.formRoute();
    if (!route) { this.toast.error('Itinéraire introuvable'); return; }

    const payload = {
      routeId: this.fRouteId(), busId: this.fBusId(),
      from: route.from, to: route.to,
      departure: this.fDeparture(), arrival: this.formArrival(),
      recurrence: rec,
      days: rec === 'daily'    ? [0,1,2,3,4,5,6]
          : rec === 'weekdays' ? [1,2,3,4,5]
          : rec === 'weekends' ? [0,6]
          : this.fDays(),
      startDate: this.fStartDate(),
      endDate: this.fEndDate() || undefined,
      specificDate: rec === 'once' ? this.fSpecificDate() : undefined,
      status: 'scheduled' as const,
      price: this.fPrice() || route.basePrice,
      notes: this.fNotes(),
    };

    if (this.modal() === 'add') {
      this.tripsSvc.add(payload);
      this.toast.success('Voyage créé');
      this.audit.log(this.auth.currentAdmin()!.id,'trips','Voyage créé',{severity:'success',details:this.fRouteId()+' · '+this.fDeparture()+' · '+this.tripsSvc.recurrenceLabel(this.fRecurrence())});
    } else {
      const tripBefore = this.modalTrip()!;
      const tripLabels: Record<string,string> = {departure:'Heure de départ',arrival:'Heure d\'arrivée',recurrence:'Récurrence',price:'Prix (Ar)',notes:'Notes',busId:'Véhicule (ID)',from:'Départ',to:'Destination',days:'Jours'};
      const tripAfter = { departure:payload.departure, arrival:payload.arrival, recurrence:payload.recurrence, price:payload.price, notes:payload.notes??'', busId:payload.busId, from:payload.from, to:payload.to, days:payload.days };
      const tripDiff = this.audit.diffObjects(tripBefore, tripAfter, tripLabels);
      this.tripsSvc.update(tripBefore.id, payload);
      this.toast.success('Voyage mis à jour');
      this.audit.log(this.auth.currentAdmin()!.id,'trips','Voyage modifié',{severity:'info',targetId:tripBefore.id,targetName:tripBefore.from+' → '+tripBefore.to+' '+tripBefore.departure,diff:tripDiff,adminPublicId:this.auth.currentAdmin()!.publicId});
    }
    this.closeModal();
  }

  confirmCancel(): void {
    this.tripsSvc.cancel(this.modalTrip()!.id, this.cancelReason);
    this.toast.warn('Voyage annulé');
    const ct = this.modalTrip()!;
    this.audit.log(this.auth.currentAdmin()!.id,'trips','Voyage annulé',{severity:'danger',targetId:ct.id,targetName:ct.from+' → '+ct.to+' '+ct.departure,details:this.cancelReason||'Pas de raison'});
    this.closeModal();
  }

  confirmDelete(): void {
    this.tripsSvc.delete(this.modalTrip()!.id);
    this.toast.warn('Voyage supprimé');
    const dt = this.modalTrip()!;
    this.audit.log(this.auth.currentAdmin()!.id,'trips','Voyage supprimé',{severity:'danger',targetId:dt.id,targetName:dt.from+' → '+dt.to+' '+dt.departure});
    this.closeModal();
  }

  toggleDay(d: number): void {
    const days = [...this.fDays()];
    const idx = days.indexOf(d);
    if (idx >= 0) days.splice(idx, 1);
    else days.push(d);
    this.fDays.set(days);
  }

  selectDate(date: string): void { this.selectedDate.set(date); }
  prevWeek(): void { this.weekOffset.update(w => w-1); }
  nextWeek(): void { this.weekOffset.update(w => w+1); }
  goToday(): void  { this.weekOffset.set(0); this.selectedDate.set(fmtDate(new Date())); }

  // ── Helpers template ─────────────────────────────────────────────────────
  busName(id: string): string  { return this.tripsSvc.getBus(id)?.name ?? id; }
  busIcon(id: string): string  {
    const l = this.tripsSvc.getBus(id)?.vehicleLayout;
    return l === 'minibus16' ? '🚐' : l === 'minibus10' ? '⭐' : '🚌';
  }
  routeLabel(id: string): string {
    const r = this.tripsSvc.getRoute(id);
    return r ? `${r.from} → ${r.to}` : id;
  }
  statusColor(s: string): string {
    return { scheduled:'var(--a-cyan)', cancelled:'var(--a-red)',
             completed:'var(--a-green)', in_progress:'var(--a-amber)' }[s] ?? 'var(--a-tx3)';
  }
  statusLabel(s: string): string {
    return { scheduled:'Prévu', cancelled:'Annulé',
             completed:'Terminé', in_progress:'En cours' }[s] ?? s;
  }
  readonly DAYS = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];

  fmtDay(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }

  // Détecte les conflits pour un trip donné
  // - avec date : vérifie uniquement ce jour (calendrier / emploi du temps)
  // - sans date : vérifie les jours communs entre trips récurrents (vue liste)
  tripConflictMsg(t: AdminTrip, date?: string): string | null {
    if (date) {
      // Vérification sur une date précise : le trip doit d'abord être actif ce jour-là
      const trips = this.tripsSvc.getTripsForDate(date) as AdminTrip[];
      const isActive = trips.some(x => x.id === t.id);
      if (!isActive) return null; // ce trip n'est pas actif ce jour-là
      const ci = this.tripsSvc.getConflictInfo(t.busId, date, t.departure, t.arrival, t.id);
      return ci ? ci.message : null;
    }
    // Vue liste : vérifier les jours communs entre récurrences
    const ci = this.tripsSvc.getConflictInfoForList(t);
    return ci ? ci.message : null;
  }
}
