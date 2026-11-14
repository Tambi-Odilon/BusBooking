import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';
import { AppError } from '../../common/errors';
import { addDays, localToUtc, templateRunsOn, todayIn } from '../../common/time';
import { SettingsService } from '../settings/settings.service';
import { logger } from '../../common/logger';

export interface GenerationReport { created: number; conflicts: Array<{ templateId: string; date: string; reason: string }> }

/** Vue « voyage » complète, utilisée par la recherche, le back-office et les billets. */
export const TRIP_SELECT = `
  SELECT t.id, t.template_id, t.route_id, t.vehicle_id, t.driver_id, t.layout_id, t.service_date, t.departure_at, t.arrival_at,
         t.price, t.rank, t.status, t.sales_open_at, t.cancel_reason, t.notes,
         cf.name AS from_city, ct.name AS to_city, cf.station_address AS from_station, ct.station_address AS to_station,
         r.status AS route_status, r.distance_km,
         v.name AS vehicle_name, v.type AS vehicle_type, v.plate_number, v.amenities, v.ref AS vehicle_ref,
         l.code AS layout_code, l.capacity, l.rows AS layout_rows,
         CASE WHEN d.id IS NULL THEN NULL ELSE d.first_name || ' ' || d.last_name END AS driver_name, d.status AS driver_status,
         (SELECT count(*)::int FROM trip_seats s WHERE s.trip_id = t.id AND (s.status = 'booked' OR s.hold_expires_at > now())) AS seats_taken,
         (SELECT count(*)::int FROM trip_seats s WHERE s.trip_id = t.id AND s.status = 'booked') AS seats_booked
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    JOIN cities cf ON cf.id = r.from_city_id
    JOIN cities ct ON ct.id = r.to_city_id
    JOIN vehicles v ON v.id = t.vehicle_id
    JOIN seat_layouts l ON l.id = t.layout_id
    LEFT JOIN drivers d ON d.id = t.driver_id`;

@Injectable()
export class TripsService {
  constructor(private db: Db, private settings: SettingsService) {}

  async tripById(id: string, q: Queryable = this.db) {
    const t = await q.maybe<any>(`${TRIP_SELECT} WHERE t.id = $1`, [id]);
    if (!t) throw new AppError('TRIP_NOT_FOUND', 404, 'Voyage introuvable');
    return t;
  }

  /** Prix et durée effectifs d'un voyage : le modèle prime, puis le tarif par type de véhicule, puis le tarif de base. */
  resolve(route: any, layoutCode: string, templatePrice: number | null | undefined) {
    const price = templatePrice ?? route.priceByLayout?.[layoutCode] ?? route.basePrice;
    const durationMin = route.durationByLayout?.[layoutCode] ?? route.durationMin;
    return { price: Number(price), durationMin: Number(durationMin) };
  }

  /**
   * Crée les voyages réels à partir des modèles récurrents, sur l'horizon de vente.
   * Idempotent : la contrainte unique (modèle, date) et la contrainte d'exclusion (véhicule, créneau) font foi.
   */
  async generate(opts: { templateId?: string; from?: string; days?: number } = {}): Promise<GenerationReport> {
    const locale = await this.settings.get('locale');
    const booking = await this.settings.get('booking');
    const from = opts.from ?? todayIn(locale.timezone);
    const days = opts.days ?? booking.salesHorizonDays;
    const to = addDays(from, days);
    const templates = await this.db.q<any>(
      `SELECT tt.*, r.status AS route_status, r.base_price, r.duration_min, r.price_by_layout, r.duration_by_layout,
              v.status AS vehicle_status, v.layout_id, l.code AS layout_code
         FROM trip_templates tt JOIN routes r ON r.id = tt.route_id JOIN vehicles v ON v.id = tt.vehicle_id JOIN seat_layouts l ON l.id = v.layout_id
        WHERE tt.status = 'scheduled' AND ($1::uuid IS NULL OR tt.id = $1)`, [opts.templateId ?? null]);
    const report: GenerationReport = { created: 0, conflicts: [] };
    for (const tt of templates) {
      if (tt.routeStatus !== 'active') continue;
      const existing = new Set((await this.db.q<{ serviceDate: string }>(
        'SELECT service_date FROM trips WHERE template_id = $1 AND service_date BETWEEN $2 AND $3', [tt.id, from, to])).map(x => x.serviceDate));
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (existing.has(d) || !templateRunsOn(tt, d)) continue;
        if (tt.vehicleStatus !== 'active') { report.conflicts.push({ templateId: tt.id, date: d, reason: 'VEHICLE_UNAVAILABLE' }); continue; }
        const { price, durationMin } = this.resolve({ basePrice: tt.basePrice, durationMin: tt.durationMin, priceByLayout: tt.priceByLayout, durationByLayout: tt.durationByLayout }, tt.layoutCode, tt.price);
        const dep = localToUtc(d, tt.departureTime, locale.timezone);
        if (dep.getTime() < Date.now()) continue;   // on ne crée pas de voyage dans le passé
        const arr = new Date(dep.getTime() + durationMin * 60000);
        try {
          const r = await this.db.q(
            `INSERT INTO trips (template_id, route_id, vehicle_id, driver_id, layout_id, service_date, departure_at, arrival_at, price, rank, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (template_id, service_date) DO NOTHING RETURNING id`,
            [tt.id, tt.routeId, tt.vehicleId, tt.driverId, tt.layoutId, d, dep, arr, price, tt.rank, tt.notes]);
          report.created += r.length;
        } catch (e: any) {
          if (e?.code === '23P01') report.conflicts.push({ templateId: tt.id, date: d, reason: 'VEHICLE_SCHEDULE_CONFLICT' });
          else throw e;
        }
      }
    }
    if (report.conflicts.length) logger.warn({ conflicts: report.conflicts.length }, 'génération des voyages : créneaux en conflit ignorés');
    return report;
  }

  /**
   * Après modification d'un modèle : les voyages futurs SANS réservation ni verrou sont recréés avec les nouvelles valeurs,
   * les voyages déjà vendus sont conservés tels quels (à traiter au cas par cas : annulation ou changement de véhicule).
   */
  async resyncTemplate(templateId: string): Promise<{ removed: number; kept: number; report: GenerationReport }> {
    const removed = await this.db.q(
      `DELETE FROM trips t WHERE t.template_id = $1 AND t.departure_at > now() AND t.status = 'scheduled'
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id) RETURNING id`, [templateId]);
    const kept = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM trips WHERE template_id = $1 AND departure_at > now() AND status = 'scheduled'`, [templateId]);
    const report = await this.generate({ templateId });
    return { removed: removed.length, kept: kept.n, report };
  }
}
