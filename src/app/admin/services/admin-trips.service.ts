import { Injectable, signal, computed, inject } from '@angular/core';
import { AdminPermissions, AdminTrip } from '../models/admin.models';
import { AdminRoutesService } from './admin-routes.service';
import { AdminFleetService  } from './admin-fleet.service';
import { RemoteStore, clean } from './admin-store';

function iso(): string { return new Date().toISOString(); }
function fmtDate(d: Date): string { return d.toISOString().split('T')[0]; }
function addMin(hhmm: string, min: number): string {
  const [h,m] = hhmm.split(':').map(Number);
  const t = h*60 + m + min;
  return `${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
}
/** Voyage programmé (récurrence) renvoyé par l'API → modèle des écrans. L'heure d'arrivée est déduite de la durée de l'itinéraire. */
const toTrip = (t: any): AdminTrip => ({
  id: t.id, routeId: t.routeId, busId: t.vehicleId, from: t.fromCity, to: t.toCity, departure: t.departureTime, arrival: addMin(t.departureTime, t.durationMin || 0),
  recurrence: t.recurrence, days: t.days || [], startDate: t.startDate, endDate: t.endDate || undefined, specificDate: t.specificDate || undefined,
  status: t.status, cancelReason: t.cancelReason || undefined, notes: t.notes || undefined, rank: t.rank ?? undefined, price: t.effectivePrice ?? t.price ?? 0,
  driverId: t.driverId || undefined, conflictWith: t.conflictWith ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt,
});
const toBody = (p: Partial<AdminTrip>) => clean({ routeId: p.routeId, vehicleId: p.busId, driverId: p.driverId, departureTime: p.departure, recurrence: p.recurrence, days: p.days,
  startDate: p.startDate, endDate: p.endDate, specificDate: p.specificDate, price: p.price, rank: p.rank, notes: p.notes }, ['driverId', 'endDate', 'specificDate', 'notes']);

@Injectable({ providedIn: 'root' })
export class AdminTripsService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewRoutes'];
  private routesSvc = inject(AdminRoutesService);
  private fleetSvc  = inject(AdminFleetService);

  private readonly _trips = signal<AdminTrip[]>([]);

  protected async fetch(): Promise<void> { this._trips.set((await this.api.get<{ items: any[] }>('/admin/trip-templates', { query: { limit: 200 } })).items.map(toTrip)); }
  protected reset(): void { this._trips.set([]); }
  readonly trips = this._trips.asReadonly();

  readonly stats = computed(() => {
    const ts = this._trips();
    return {
      total:     ts.length,
      scheduled: ts.filter(t => t.status === 'scheduled').length,
      cancelled: ts.filter(t => t.status === 'cancelled').length,
      completed: ts.filter(t => t.status === 'completed').length,
      daily:     ts.filter(t => t.recurrence === 'daily').length,
      weekly:    ts.filter(t => ['weekly','weekdays','weekends','custom'].includes(t.recurrence)).length,
      once:      ts.filter(t => t.recurrence === 'once').length,
    };
  });

  // ── Récupérer les voyages actifs pour une date donnée ─────────────────────
  getTripsForDate(dateStr: string): AdminTrip[] {
    const date = new Date(dateStr);
    const dow  = date.getDay(); // 0=dim..6=sam
    const today = dateStr;

    return this._trips().filter(t => {
      if (t.status === 'cancelled') return false;
      if (t.startDate > dateStr) return false;
      if (t.endDate && t.endDate < dateStr) return false;

      switch (t.recurrence) {
        case 'once':     return t.specificDate === dateStr;
        case 'daily':    return true;
        case 'weekdays': return dow >= 1 && dow <= 5;
        case 'weekends': return dow === 0 || dow === 6;
        case 'weekly':
        case 'custom':   return t.days.includes(dow);
        default:         return false;
      }
    });
  }

  // ── Voyages d'un véhicule pour une plage de dates (emploi du temps) ───────
  getTripsByBus(busId: string, fromDate: string, toDate: string): { date: string; trip: AdminTrip }[] {
    const result: { date: string; trip: AdminTrip }[] = [];
    const start = new Date(fromDate);
    const end   = new Date(toDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
      const ds = fmtDate(d);
      const trips = this.getTripsForDate(ds).filter(t => t.busId === busId);
      trips.forEach(t => result.push({ date: ds, trip: t }));
    }
    return result;
  }

  // ── Détection conflits (même bus, même plage horaire) ────────────────────
  // Convertit HH:mm en minutes (gère le passage minuit via offset)
  private toMin(hhmm: string, dayOffset = 0): number {
    const [h, m] = hhmm.split(':').map(Number);
    return (h + dayOffset * 24) * 60 + m;
  }

  // Normalise un créneau pour que l'arrivée soit toujours > départ
  private normalizeSlot(dep: string, arr: string): { depMin: number; arrMin: number } {
    let depMin = this.toMin(dep);
    let arrMin = this.toMin(arr);
    if (arrMin <= depMin) arrMin += 24 * 60; // passage minuit
    return { depMin, arrMin };
  }

  // Vérifie si deux créneaux se chevauchent (en tenant compte du passage minuit)
  private slotsOverlap(dep1: string, arr1: string, dep2: string, arr2: string): boolean {
    const s1 = this.normalizeSlot(dep1, arr1);
    const s2 = this.normalizeSlot(dep2, arr2);
    // Chevauchement : l'un commence avant que l'autre finisse
    return s1.depMin < s2.arrMin && s1.arrMin > s2.depMin;
  }

  // Retourne le détail du conflit ou null si pas de conflit
  getConflictInfo(busId: string, date: string, departure: string, arrival: string, excludeId?: string): {
    type: 'same_time' | 'not_arrived';
    conflictingTrip: AdminTrip;
    message: string;
  } | null {
    const candidates = (this.getTripsForDate(date) as AdminTrip[])
      .filter((t: AdminTrip) => t.busId === busId && t.id !== excludeId && t.status !== 'cancelled');

    for (const t of candidates) {
      if (!this.slotsOverlap(departure, arrival, t.departure, t.arrival)) continue;

      const { depMin: newDep } = this.normalizeSlot(departure, arrival);
      const { depMin: existDep, arrMin: existArr } = this.normalizeSlot(t.departure, t.arrival);

      // Cas 1 : même heure de départ exacte
      if (departure === t.departure) {
        return {
          type: 'same_time',
          conflictingTrip: t,
          message: `Ce véhicule part déjà à ${t.departure} (${t.from} → ${t.to}). Deux départs à la même heure ne sont pas possibles.`,
        };
      }

      // Cas 2 : nouveau départ avant que l'ancien soit arrivé
      if (newDep < existArr && newDep >= existDep) {
        return {
          type: 'not_arrived',
          conflictingTrip: t,
          message: `Ce véhicule n'est pas encore arrivé à destination — il part à ${t.departure} et arrive à ${t.arrival} (${t.from} → ${t.to}). Le nouveau départ à ${departure} est pendant ce trajet.`,
        };
      }

      // Cas 3 : nouveau trajet englobe un trajet existant
      return {
        type: 'not_arrived',
        conflictingTrip: t,
        message: `Conflit horaire avec le trajet ${t.departure}–${t.arrival} (${t.from} → ${t.to}). Le véhicule ne serait pas disponible.`,
      };
    }
    return null;
  }

  hasConflict(busId: string, date: string, departure: string, arrival: string, excludeId?: string): boolean {
    return this.getConflictInfo(busId, date, departure, arrival, excludeId) !== null;
  }

  // ── Écritures (le serveur génère ensuite les départs réels et refuse les chevauchements d'un même véhicule) ──
  add(data: Omit<AdminTrip,'id'|'createdAt'|'updatedAt'>): AdminTrip {
    const created = this.write(() => this.api.post<any>('/admin/trip-templates', toBody(data)));
    const trip: AdminTrip = { ...data, id: this.tempId(created), createdAt: iso(), updatedAt: iso() };
    this._trips.update(ts => [trip, ...ts]);
    return trip;
  }

  update(id: string, patch: Partial<AdminTrip>): void {
    this._trips.update(ts => ts.map(t => t.id === id ? { ...t, ...patch, updatedAt: iso() } : t));
    const body: any = toBody(patch);
    if (Object.keys(body).length) void this.write(async () => this.api.patch(`/admin/trip-templates/${await this.real(id)}`, body));
    if (patch.status === 'scheduled') void this.write(async () => this.api.post(`/admin/trip-templates/${await this.real(id)}/resume`));
  }

  /** Arrête un voyage programmé : les départs à venir sans billet vendu sont retirés de la vente. */
  cancel(id: string, reason?: string): void {
    this._trips.update(ts => ts.map(t => t.id === id ? { ...t, status: 'cancelled', cancelReason: reason, updatedAt: iso() } : t));
    void this.write(async () => this.api.post(`/admin/trip-templates/${await this.real(id)}/cancel`, { reason: reason || undefined }));
  }
  resume(id: string): void { this.update(id, { status: 'scheduled' }); }

  delete(id: string): void {
    this._trips.update(ts => ts.filter(t => t.id !== id));
    void this.write(async () => this.api.delete(`/admin/trip-templates/${await this.real(id)}`));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  getRoute(routeId: string) { return this.routesSvc.routes().find(r => r.id === routeId); }
  getBus(busId: string)     { return this.fleetSvc.buses().find(b => b.id === busId); }

  recurrenceLabel(r: string): string {
    return { once:'Ponctuel', daily:'Quotidien', weekly:'Hebdo.',
             weekdays:'Sem. (L-V)', weekends:'Week-end', custom:'Personnalisé' }[r] ?? r;
  }

  dayLabel(d: number): string {
    return ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'][d] ?? '';
  }

  formatDuration(dep: string, arr: string): string {
    const [dh,dm] = dep.split(':').map(Number);
    let [ah,am] = arr.split(':').map(Number);
    if (ah < dh || (ah === dh && am < dm)) ah += 24;
    const min = (ah*60+am) - (dh*60+dm);
    return `${Math.floor(min/60)}h${String(min%60).padStart(2,'0')}`;
  }

  // ── Rang de départ (réordonnement par itinéraire/date) ─────────────────────

  // Retourne les trips d'un itinéraire pour une date, triés par rang puis heure
  getRouteTripsForDate(routeId: string, date: string): AdminTrip[] {
    return (this.getTripsForDate(date) as AdminTrip[])
      .filter((t: AdminTrip) => t.routeId === routeId && t.status !== 'cancelled')
      .sort((a: AdminTrip, b: AdminTrip) => {
        const ra = a.rank ?? 999, rb = b.rank ?? 999;
        if (ra !== rb) return ra - rb;
        return a.departure.localeCompare(b.departure);
      });
  }

  // Réassigne les rangs en masse pour un itinéraire/date (après drag-drop)
  reassignRanks(orderedIds: string[]): void {
    this._trips.update(ts => ts.map(t => { const idx = orderedIds.indexOf(t.id); return idx >= 0 ? { ...t, rank: idx + 1, updatedAt: iso() } : t; }));
    void this.write(async () => this.api.put('/admin/trip-templates/reorder', { ids: await Promise.all(orderedIds.map(id => this.real(id))) }));
  }

  // Permuter deux rangs
  swapRanks(idA: string, idB: string): void {
    const a = this._trips().find(t => t.id === idA), b = this._trips().find(t => t.id === idB);
    if (!a || !b) return;
    const rankA = a.rank ?? 999, rankB = b.rank ?? 999;
    this.update(idA, { rank: rankB });
    this.update(idB, { rank: rankA });
  }

  // Trouve les jours communs entre deux trips récurrents (pour la vue liste)
  private tripsShareADay(tA: AdminTrip, tB: AdminTrip): boolean {
    // Si l'un est annulé, pas de conflit
    if (tA.status === 'cancelled' || tB.status === 'cancelled') return false;

    // Calculer les jours de semaine actifs de chaque trip
    const daysOf = (t: AdminTrip): number[] => {
      switch (t.recurrence) {
        case 'once':     return [new Date(t.specificDate ?? t.startDate).getDay()];
        case 'daily':    return [0,1,2,3,4,5,6];
        case 'weekdays': return [1,2,3,4,5];
        case 'weekends': return [0,6];
        case 'weekly':
        case 'custom':   return t.days;
        default:         return [];
      }
    };

    const dA = daysOf(tA);
    const dB = daysOf(tB);

    // Vérifier si les périodes de validité se chevauchent
    const startA = tA.recurrence === 'once' ? (tA.specificDate ?? tA.startDate) : tA.startDate;
    const startB = tB.recurrence === 'once' ? (tB.specificDate ?? tB.startDate) : tB.startDate;
    const endA   = tA.endDate ?? '9999-12-31';
    const endB   = tB.endDate ?? '9999-12-31';

    if (startA > endB || startB > endA) return false; // périodes disjointes

    // Ont-ils au moins un jour de semaine commun?
    return dA.some(d => dB.includes(d));
  }

  // Conflit dans la vue liste (sans date précise — vérifie les jours communs)
  getConflictInfoForList(t: AdminTrip): { type: 'same_time'|'not_arrived'; conflictingTrip: AdminTrip; message: string } | null {
    const allSameBus = (this._trips() as AdminTrip[]).filter(
      (other: AdminTrip) => other.busId === t.busId && other.id !== t.id && other.status !== 'cancelled'
    );

    for (const other of allSameBus) {
      if (!this.tripsShareADay(t, other)) continue;
      if (!this.slotsOverlap(t.departure, t.arrival, other.departure, other.arrival)) continue;

      const { depMin: dA } = this.normalizeSlot(t.departure, t.arrival);
      const s2 = this.normalizeSlot(other.departure, other.arrival);
      const arrB = s2.arrMin;
      const dB   = s2.depMin;

      if (t.departure === other.departure) {
        return {
          type: 'same_time',
          conflictingTrip: other,
          message: 'Ce vehicule part deja a ' + other.departure + ' (' + other.from + ' -> ' + other.to + ') sur les jours communs.',
        };
      }
      if (dA < arrB && dA >= dB) {
        return {
          type: 'not_arrived',
          conflictingTrip: other,
          message: 'Conflit : ce vehicule part a ' + other.departure + ' et arrive a ' + other.arrival
                 + ' (' + other.from + ' -> ' + other.to + '). Le depart a ' + t.departure + ' chevauche ce trajet.',
        };
      }
      return {
        type: 'not_arrived',
        conflictingTrip: other,
        message: 'Conflit horaire avec ' + other.departure + '-' + other.arrival
               + ' (' + other.from + ' -> ' + other.to + ') sur les jours communs.',
      };
    }
    return null;
  }
}
