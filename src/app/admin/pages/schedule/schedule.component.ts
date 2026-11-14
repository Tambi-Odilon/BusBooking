import { Component, inject, signal, computed, OnInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminTripsService } from '../../services/admin-trips.service';
import { AdminRoutesService } from '../../services/admin-routes.service';
import { AdminFleetService }  from '../../services/admin-fleet.service';
import { AdminAuthService }   from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService }  from '../../services/admin-toast.service';
import { AdminTrip }          from '../../models/admin.models';

function fmtDate(d: Date): string { return d.toISOString().split('T')[0]; }
function parseMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

const TIMELINE_START = 5 * 60;
const TIMELINE_END   = 23 * 60;
const TIMELINE_SPAN  = TIMELINE_END - TIMELINE_START;
const SNAP_MINUTES   = 30; // accrochage toutes les 30 min

export interface DayCell {
  date: string; label: string; dayNum: string; dow: string;
  isToday: boolean; trips: AdminTrip[];
}
export interface RouteSlot {
  routeId: string; routeLabel: string; trips: AdminTrip[];
}
// Snapshot immuable utilisé pendant le drag
interface TripSnap { id: string; departure: string; arrival: string; rank: number; }

@Component({
  selector: 'app-schedule',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './schedule.component.html',
  styleUrl:    './schedule.component.scss',
})
export class ScheduleComponent implements OnInit {
  readonly tripsSvc  = inject(AdminTripsService);
  readonly routesSvc = inject(AdminRoutesService);
  readonly fleetSvc  = inject(AdminFleetService);
  readonly auth      = inject(AdminAuthService);
  readonly toast     = inject(AdminToastService);
  readonly audit = inject(AdminAuditService);

  selectedDate    = signal(fmtDate(new Date()));
  weekOffset      = signal(0);
  selectedRoute   = signal<string>('all');
  expandedRoutes  = signal<Set<string>>(new Set()); // first slot auto-expanded in template

  // ── Drag liste ──────────────────────────────────────────────────────────
  listDragId     = signal<string | null>(null);
  listDragOver   = signal<number>(-1);
  listRouteId    = signal<string>('');     // itinéraire en cours de drag

  // ── Drag timeline ────────────────────────────────────────────────────────
  timelineDragId      = signal<string | null>(null);
  timelineGhostMin    = signal<number>(-1);  // heure cible (minutes) pendant le survol
  timelineRouteId     = signal<string>('');

  // Edition rapide
  editingTrip   = signal<AdminTrip | null>(null);
  editDeparture = '';
  editNotes     = '';
  editConflictMsg = signal<string | null>(null);

  // ── Calendrier semaine ────────────────────────────────────────────────
  readonly weekDays = computed<DayCell[]>(() => {
    const base = new Date();
    base.setDate(base.getDate() + this.weekOffset() * 7);
    const dow = base.getDay();
    base.setDate(base.getDate() + (dow === 0 ? -6 : 1 - dow));
    const todayStr = fmtDate(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base); d.setDate(base.getDate() + i);
      const ds = fmtDate(d);
      return {
        date: ds,
        label: d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' }),
        dayNum: String(d.getDate()),
        dow: d.toLocaleDateString('fr-FR', { weekday:'short' }).slice(0,3),
        isToday: ds === todayStr,
        trips: (this.tripsSvc.getTripsForDate(ds) as AdminTrip[])
          .filter((t: AdminTrip) => t.status !== 'cancelled'),
      };
    });
  });

  // ── Slots par itinéraire ────────────────────────────────────────────────
  readonly dayRouteSlots = computed<RouteSlot[]>(() => {
    const date = this.selectedDate();
    const routeFilter = this.selectedRoute();
    const allTrips = (this.tripsSvc.getTripsForDate(date) as AdminTrip[])
      .filter((t: AdminTrip) => t.status !== 'cancelled');

    const map = new Map<string, AdminTrip[]>();
    allTrips.forEach((t: AdminTrip) => {
      if (!map.has(t.routeId)) map.set(t.routeId, []);
      map.get(t.routeId)!.push(t);
    });

    let slots: RouteSlot[] = [];
    map.forEach((trips, routeId) => {
      const route = this.routesSvc.routes().find(r => r.id === routeId);
      slots.push({
        routeId,
        routeLabel: route ? `${route.from} → ${route.to}` : routeId,
        trips: [...trips].sort((a: AdminTrip, b: AdminTrip) => {
          const ra = a.rank ?? 999, rb = b.rank ?? 999;
          if (ra !== rb) return ra - rb;
          return a.departure.localeCompare(b.departure);
        }),
      });
    });

    if (routeFilter !== 'all') slots = slots.filter(s => s.routeId === routeFilter);
    return slots.sort((a, b) => a.routeLabel.localeCompare(b.routeLabel));
  });

  // ── Timeline helpers ──────────────────────────────────────────────────
  readonly timelineHours = Array.from({ length: 19 }, (_, i) => i + 5);

  tripLeft(dep: string): number {
    return Math.max(0, Math.min(98, (parseMin(dep) - TIMELINE_START) / TIMELINE_SPAN * 100));
  }
  tripWidth(dep: string, arr: string): number {
    let a = parseMin(arr); const d = parseMin(dep);
    if (a <= d) a += 24 * 60;
    return Math.max(1.5, Math.min(a - d, TIMELINE_SPAN) / TIMELINE_SPAN * 100);
  }
  ghostLeft(): number {
    const g = this.timelineGhostMin();
    return g < 0 ? -1 : Math.max(0, (g - TIMELINE_START) / TIMELINE_SPAN * 100);
  }
  tripColor(layout: string): string {
    return layout === 'minibus16' ? '#10b981' : layout === 'minibus10' ? '#8b5cf6' : '#0891b2';
  }
  busLayout(id: string): string { return this.fleetSvc.buses().find(b => b.id === id)?.vehicleLayout ?? 'bus'; }
  busName(id: string): string   { return this.fleetSvc.buses().find(b => b.id === id)?.name ?? id; }
  busPlate(id: string): string  { return this.fleetSvc.buses().find(b => b.id === id)?.plateNumber ?? ''; }
  busIcon(id: string): string   { const l = this.busLayout(id); return l==='minibus16'?'🚐':l==='minibus10'?'⭐':'🚌'; }

  ngOnInit(): void {}

  prevWeek(): void { this.weekOffset.update(w => w-1); }
  nextWeek(): void { this.weekOffset.update(w => w+1); }
  goToday():  void { this.weekOffset.set(0); this.selectedDate.set(fmtDate(new Date())); }
  selectDay(d: string): void { this.selectedDate.set(d); this.expandedRoutes.set(new Set()); }

  // ════════════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════════════
  // DRAG & DROP LISTE — réordonnement par rang + permutation des heures
  // ════════════════════════════════════════════════════════════════════

  onListDragStart(e: DragEvent, tripId: string, routeId: string): void {
    // Empêche la zone timeline de réagir au même drag
    e.stopPropagation();
    this.listDragId.set(tripId);
    this.listRouteId.set(routeId);
    this.listDragOver.set(-1);
    // Marquer le dataTransfer pour distinguer les deux systèmes de drag
    e.dataTransfer?.setData('drag-type', 'list');
  }
  onListDragOver(e: DragEvent, idx: number): void {
    e.preventDefault();
    e.stopPropagation();
    this.listDragOver.set(idx);
  }
  onListDragEnd(): void {
    this.listDragId.set(null);
    this.listDragOver.set(-1);
    this.listRouteId.set('');
  }

  onListDrop(slot: RouteSlot, dropIdx: number): void {
    const dragId = this.listDragId();
    if (!dragId) return;

    // Snapshot immuable — capture TOUT avant toute modification réactive
    const snaps: TripSnap[] = (slot.trips as AdminTrip[]).map((t: AdminTrip, i: number) => ({
      id:        t.id,
      departure: t.departure,
      arrival:   t.arrival,
      rank:      i + 1,
    }));

    const n        = snaps.length;
    const fromIdx  = snaps.findIndex(s => s.id === dragId);
    // Clamp dropIdx entre 0 et n-1 (pas hors tableau)
    const targetIdx = Math.min(Math.max(0, dropIdx), n - 1);

    if (fromIdx === -1 || fromIdx === targetIdx) { this.onListDragEnd(); return; }

    // Réordonner les IDs (ordre des véhicules)
    const orderedIds = snaps.map(s => s.id);
    orderedIds.splice(fromIdx, 1);
    orderedIds.splice(targetIdx, 0, dragId);

    // Les HEURES restent liées aux POSITIONS : chaque position garde son heure
    // Construire le mapping final: vehicleId → heure de sa nouvelle position
    const updates: { id: string; departure: string; arrival: string; rank: number }[] = [];
    orderedIds.forEach((id, newPos) => {
      updates.push({
        id,
        departure: snaps[newPos].departure,  // heure qui était à cette position
        arrival:   snaps[newPos].arrival,
        rank:      newPos + 1,
      });
    });

    // Appliquer tous les updates en une seule passe (évite les re-calculs intermédiaires)
    updates.forEach(u => {
      this.tripsSvc.update(u.id, { departure: u.departure, arrival: u.arrival, rank: u.rank });
    });

    this.toast.show(`Rang réorganisé`);
    this.onListDragEnd();
  }

  moveUp(slot: RouteSlot, idx: number): void {
    if (idx === 0) return;
    this.listDragId.set((slot.trips as AdminTrip[])[idx].id);
    this.listRouteId.set(slot.routeId);
    this.onListDrop(slot, idx - 1);
  }

  moveDown(slot: RouteSlot, idx: number): void {
    if (idx === (slot.trips as AdminTrip[]).length - 1) return;
    this.listDragId.set((slot.trips as AdminTrip[])[idx].id);
    this.listRouteId.set(slot.routeId);
    this.onListDrop(slot, idx + 1);
  }

  // ════════════════════════════════════════════════════════════════════
  // DRAG TIMELINE — glisser une barre vers une heure cible
  // ════════════════════════════════════════════════════════════════════

  onTimelineDragStart(e: DragEvent, tripId: string, routeId: string): void {
    e.dataTransfer?.setData('drag-type', 'timeline');
    this.timelineDragId.set(tripId);
    this.timelineRouteId.set(routeId);
    this.timelineGhostMin.set(-1);
  }

  onTimelineDragOver(e: DragEvent, containerEl: HTMLElement): void {
    // Ignore si un drag de liste est en cours
    if (this.listDragId()) return;
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const rawMin = TIMELINE_START + pct * TIMELINE_SPAN;
    // Accrocher aux 30 min
    const snapped = Math.round(rawMin / SNAP_MINUTES) * SNAP_MINUTES;
    this.timelineGhostMin.set(Math.max(TIMELINE_START, Math.min(TIMELINE_END - 60, snapped)));
  }

  onTimelineDragLeave(): void { if (!this.listDragId()) this.timelineGhostMin.set(-1); }

  onTimelineDrop(e: DragEvent, slot: RouteSlot, containerEl: HTMLElement): void {
    e.preventDefault();
    // Ignore si c'est un drop de la liste
    if (this.listDragId()) return;
    const dragId = this.timelineDragId();
    if (!dragId) return;

    const rect = containerEl.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const rawMin = TIMELINE_START + pct * TIMELINE_SPAN;
    const newDepMin = Math.round(rawMin / SNAP_MINUTES) * SNAP_MINUTES;
    const newDep = minToHHMM(Math.max(TIMELINE_START, Math.min(TIMELINE_END - 30, newDepMin)));

    const trip = (slot.trips as AdminTrip[]).find((t: AdminTrip) => t.id === dragId);
    if (!trip) { this.onTimelineDragEnd(); return; }

    const route = this.routesSvc.routes().find(r => r.id === slot.routeId);
    let newArr = trip.arrival;
    if (route) {
      const layout = this.busLayout(trip.busId);
      const dur = (route.durationByLayout as Record<string,number>)?.[layout] || route.durationMin;
      newArr = minToHHMM(newDepMin + dur);
    }

    // ── Vérification conflit avant d'appliquer ─────────────────────────────
    const ci = this.tripsSvc.getConflictInfo(
      trip.busId, this.selectedDate(), newDep, newArr, dragId
    );
    if (ci) {
      this.toast.error(ci.message);
      this.onTimelineDragEnd();
      return;
    }

    const allTrips   = slot.trips as AdminTrip[];
    const newRank    = (allTrips as AdminTrip[])
      .filter((t: AdminTrip) => t.id !== dragId && parseMin(t.departure) <= newDepMin).length + 1;

    const tlLabels: Record<string,string> = {departure:'Heure de départ',arrival:'Heure d\'arrivée',rank:'Rang'};
    const tlDiff = this.audit.diffObjects(
      {departure:trip.departure, arrival:trip.arrival, rank:trip.rank},
      {departure:newDep, arrival:newArr, rank:newRank},
      tlLabels
    );
    this.tripsSvc.update(dragId, { departure: newDep, arrival: newArr, rank: newRank });
    const withUpdated = allTrips.map((t: AdminTrip) =>
      t.id === dragId ? { ...t, departure: newDep } : t
    ).sort((a: AdminTrip, b: AdminTrip) => a.departure.localeCompare(b.departure));
    this.tripsSvc.reassignRanks(withUpdated.map((t: AdminTrip) => t.id));

    this.toast.success(`Départ déplacé → ${newDep} (rang ${newRank})`);
    this.audit.log(this.auth.currentAdmin()!.id,'schedule','Heure de départ modifiée (timeline)',{severity:'info',targetId:dragId,targetName:trip.from+' → '+trip.to,diff:tlDiff,adminPublicId:this.auth.currentAdmin()!.publicId});
    this.onTimelineDragEnd();
  }

  onTimelineDragEnd(): void {
    this.timelineDragId.set(null);
    this.timelineGhostMin.set(-1);
    this.timelineRouteId.set('');
  }

  // ── Edition rapide ────────────────────────────────────────────────────
  openEdit(t: AdminTrip): void {
    this.editingTrip.set(t);
    this.editDeparture = t.departure;
    this.editNotes = t.notes ?? '';
    this.editConflictMsg.set(null);
  }
  closeEdit(): void { this.editingTrip.set(null); this.editConflictMsg.set(null); }

  saveEdit(): void {
    const t = this.editingTrip();
    if (!t) return;
    const route = this.routesSvc.routes().find(r => r.id === t.routeId);
    let arrival = t.arrival;
    if (route) {
      const layout = this.busLayout(t.busId);
      const dur = (route.durationByLayout as Record<string,number>)?.[layout] || route.durationMin;
      arrival = minToHHMM(parseMin(this.editDeparture) + dur);
    }

    // ── Vérification conflit ──────────────────────────────────────────────
    const ci = this.tripsSvc.getConflictInfo(
      t.busId, this.selectedDate(), this.editDeparture, arrival, t.id
    );
    if (ci) {
      this.toast.error(ci.message);
      return;
    }

    const schedLabels: Record<string,string> = {departure:'Heure de départ',arrival:'Heure d\'arrivée',notes:'Notes'};
    const schedDiff = this.audit.diffObjects(
      {departure:t.departure, arrival:t.arrival, notes:t.notes??''},
      {departure:this.editDeparture, arrival, notes:this.editNotes},
      schedLabels
    );
    this.tripsSvc.update(t.id, { departure: this.editDeparture, arrival, notes: this.editNotes });
    this.toast.success('Voyage mis à jour');
    this.audit.log(this.auth.currentAdmin()!.id,'schedule','Horaire modifié (édition rapide)',{severity:'info',targetId:t.id,targetName:t.from+' → '+t.to,diff:schedDiff,adminPublicId:this.auth.currentAdmin()!.publicId});
    this.closeEdit();
  }

  // ── Stats ─────────────────────────────────────────────────────────────
  readonly dayStats = computed(() => {
    const trips = (this.tripsSvc.getTripsForDate(this.selectedDate()) as AdminTrip[])
      .filter((t: AdminTrip) => t.status !== 'cancelled');
    return {
      total:    trips.length,
      routes:   new Set(trips.map((t: AdminTrip) => t.routeId)).size,
      buses:    new Set(trips.map((t: AdminTrip) => t.busId)).size,
      earliest: trips.length ? [...trips].sort((a: AdminTrip,b: AdminTrip) => a.departure.localeCompare(b.departure))[0].departure : '—',
      latest:   trips.length ? [...trips].sort((a: AdminTrip,b: AdminTrip) => b.departure.localeCompare(a.departure))[0].departure : '—',
    };
  });

  readonly activeRoutes = computed(() => this.routesSvc.routes().filter(r => r.status === 'active'));

  fmtDow(date: string): string {
    return new Date(date).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }

  nowLeftPct(): number {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    return this.tripLeft(hhmm);
  }

  ghostTimeLabel(): string {
    const g = this.timelineGhostMin();
    if (g < 0) return '';
    return `${String(Math.floor(g/60)).padStart(2,'0')}:${String(g%60).padStart(2,'0')}`;
  }

  isToday(): boolean {
    return this.selectedDate() === fmtDate(new Date());
  }

  checkEditConflict(): void {
    const t = this.editingTrip();
    if (!t || !this.editDeparture) { this.editConflictMsg.set(null); return; }
    const route = this.routesSvc.routes().find(r => r.id === t.routeId);
    if (!route) return;
    const layout = this.busLayout(t.busId);
    const dur    = (route.durationByLayout as Record<string,number>)?.[layout] || route.durationMin;
    const arrival = minToHHMM(parseMin(this.editDeparture) + dur);
    const ci = this.tripsSvc.getConflictInfo(t.busId, this.selectedDate(), this.editDeparture, arrival, t.id);
    this.editConflictMsg.set(ci ? ci.message : null);
  }

  // ── Détection visuelle des conflits (schedule) ───────────────────────────
  // Utilise selectedDate() — trips déjà filtrés par getTripsForDate donc date correcte
  tripConflictMsg(trip: AdminTrip): string | null {
    const ci = this.tripsSvc.getConflictInfo(
      trip.busId, this.selectedDate(), trip.departure, trip.arrival, trip.id
    );
    return ci ? ci.message : null;
  }

  // ── Expand / Collapse itinéraires ─────────────────────────────────────────
  isExpanded(routeId: string, idx: number): boolean {
    const s = this.expandedRoutes();
    // Si le Set est vide (init), le premier itinéraire est expanded par défaut
    if (s.size === 0) return idx === 0;
    return s.has(routeId);
  }

  toggleRoute(routeId: string, idx: number): void {
    const s = new Set(this.expandedRoutes());
    // Si init (vide), construire l'état initial (premier expanded, reste collapsed)
    if (s.size === 0) {
      this.dayRouteSlots().forEach((slot, i) => {
        if (i !== 0) s.add('__collapsed__' + slot.routeId);
      });
    }
    if (s.has(routeId)) {
      s.delete(routeId);
    } else {
      s.add(routeId);
    }
    this.expandedRoutes.set(s);
  }
}
