import { Injectable } from '@nestjs/common';
import { Db, Tx } from '../../common/db';
import { AppError } from '../../common/errors';
import { EventBus } from '../../common/events';
import { fmtDuration, localParts } from '../../common/time';
import { SettingsService } from '../settings/settings.service';
import { layoutSeats } from '../settings/schemas';
import { TripsService, TRIP_SELECT } from '../transport/trips.service';

export interface HoldResult { token: string; tripId: string; seats: string[]; expiresAt: Date; extensionsLeft: number }

@Injectable()
export class SeatsService {
  constructor(private db: Db, private settings: SettingsService, private trips: TripsService, private bus: EventBus) {}

  /** Un voyage est-il vendable maintenant ? Le guichet peut vendre jusqu'au départ, le site ferme plus tôt (paramètre). */
  async assertSellable(trip: any, staff: boolean) {
    const b = await this.settings.get('booking');
    if (trip.status === 'cancelled') throw new AppError('TRIP_CANCELLED', 409, 'Ce voyage est annulé');
    if (trip.routeStatus !== 'active') throw new AppError('ROUTE_SUSPENDED', 409, 'Cet itinéraire est suspendu');
    if (!(trip.status === 'scheduled' || (staff && trip.status === 'boarding'))) throw new AppError('TRIP_NOT_ON_SALE', 409, 'Ce voyage n\'est plus en vente');
    const dep = new Date(trip.departureAt).getTime();
    const closeMs = staff ? 0 : b.salesCloseMinutes * 60000;
    if (dep - closeMs <= Date.now()) throw new AppError('SALES_CLOSED', 409, staff ? 'Ce voyage est déjà parti' : 'La vente en ligne est fermée pour ce départ');
    if (!staff && trip.salesOpenAt && new Date(trip.salesOpenAt).getTime() > Date.now())
      throw new AppError('SALES_NOT_OPEN', 409, 'La vente n\'est pas encore ouverte pour ce départ', { opensAt: trip.salesOpenAt });
  }

  /** Recherche client : uniquement des voyages réellement programmés (plus d'horaires fictifs). */
  async search(from: string, to: string, date: string, passengers: number) {
    const b = await this.settings.get('booking');
    const locale = await this.settings.get('locale');
    const route = await this.db.maybe<any>(
      `SELECT r.id, r.status, r.suspend_reason, r.suspended_until FROM routes r JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
        WHERE cf.name = $1 AND ct.name = $2 AND r.status <> 'deleted'`, [from, to]);
    if (!route) return { status: 'not_found' as const, slots: [] };
    if (route.status === 'suspended') return { status: 'suspended' as const, reason: route.suspendReason, until: route.suspendedUntil, slots: [] };
    const rows = await this.db.q<any>(
      `${TRIP_SELECT} WHERE t.route_id = $1 AND t.service_date = $2 AND t.status = 'scheduled'
         AND t.departure_at > now() + ($3 || ' minutes')::interval AND (t.sales_open_at IS NULL OR t.sales_open_at <= now())
       ORDER BY t.rank NULLS LAST, t.departure_at`, [route.id, date, String(b.salesCloseMinutes)]);
    const slots = rows.map(t => this.slot(t, locale.timezone)).filter(s => s.seatsAvailable >= passengers);
    if (!rows.length) return { status: 'no_trips' as const, slots: [] };
    if (!slots.length) return { status: 'full' as const, slots: [] };
    return { status: 'available' as const, slots };
  }
  slot(t: any, zone: string) {
    const dep = localParts(new Date(t.departureAt), zone), arr = localParts(new Date(t.arrivalAt), zone);
    const durMin = Math.round((new Date(t.arrivalAt).getTime() - new Date(t.departureAt).getTime()) / 60000);
    return {
      tripId: t.id, routeId: t.routeId, fromCity: t.fromCity, toCity: t.toCity, serviceDate: t.serviceDate,
      departureAt: t.departureAt, arrivalAt: t.arrivalAt, departure: dep.time, arrival: arr.time, arrivalDate: arr.date,
      duration: fmtDuration(durMin), durationMin: durMin, price: t.price, status: t.status,
      vehicleId: t.vehicleId, vehicleName: t.vehicleName, vehicleType: t.vehicleType, vehicleLayout: t.layoutCode, capacity: t.capacity,
      amenities: t.amenities || [], seatsAvailable: Math.max(0, t.capacity - t.seatsTaken), seatsBooked: t.seatsBooked,
      fromStation: t.fromStation, toStation: t.toStation, driverName: t.driverName ?? null,
    };
  }

  /** État complet des sièges d'un voyage : source de vérité, les événements temps réel ne font que le mettre à jour. */
  async seatMap(tripId: string, holdToken?: string) {
    const trip = await this.trips.tripById(tripId);
    const locale = await this.settings.get('locale');
    const rows = await this.db.q<any>(
      `SELECT seat_no, status, hold_token, hold_expires_at FROM trip_seats WHERE trip_id = $1 AND (status = 'booked' OR hold_expires_at > now())`, [tripId]);
    let hold: any = null;
    if (holdToken) hold = await this.db.maybe<any>(`SELECT token, expires_at, extensions FROM seat_holds WHERE token = $1 AND trip_id = $2 AND expires_at > now()`, [holdToken, tripId]);
    const b = await this.settings.get('booking');
    return {
      trip: this.slot(trip, locale.timezone),
      layout: { code: trip.layoutCode, capacity: trip.capacity, rows: trip.layoutRows },
      seats: rows.map(r => ({ seat: r.seatNo, status: r.status as 'held' | 'booked', mine: !!hold && r.holdToken === hold.token, expiresAt: r.status === 'held' ? r.holdExpiresAt : null })),
      hold: hold ? { token: hold.token, expiresAt: hold.expiresAt, extensionsLeft: Math.max(0, b.holdMaxExtensions - hold.extensions), seats: rows.filter(r => r.holdToken === hold.token && r.status === 'held').map(r => r.seatNo) } : null,
      serverTime: new Date(),
    };
  }

  /**
   * Remplace la sélection de sièges d'un client (ou d'un guichet). Tout ou rien :
   * si un seul siège demandé est déjà pris, rien n'est modifié et la liste des sièges indisponibles est renvoyée.
   * La garantie « un seul gagnant » vient de la clé primaire (trip_id, seat_no) de trip_seats.
   */
  async setHold(tripId: string, seats: string[], token: string | undefined, ctx: { userId?: string | null; staff: boolean }): Promise<HoldResult> {
    const b = await this.settings.get('booking');
    const wanted = [...new Set(seats)].sort();
    const trip = await this.trips.tripById(tripId);
    await this.assertSellable(trip, ctx.staff);
    const valid = new Set(layoutSeats(trip.layoutRows));
    const unknown = wanted.filter(s => !valid.has(s));
    if (unknown.length) throw new AppError('SEAT_UNKNOWN', 400, 'Siège inexistant dans ce véhicule', { seats: unknown });
    const max = ctx.staff ? trip.capacity : b.maxPassengers;
    if (wanted.length > max) throw new AppError('TOO_MANY_SEATS', 400, `Maximum ${max} sièges par réservation`);

    // Refus rapide : si un siège demandé est déjà vendu ou retenu par quelqu'un d'autre, on répond tout de suite sans ouvrir
    // de transaction (c'est le cas de presque toutes les requêtes lors d'une ruée). La garantie reste l'insertion ci-dessous.
    if (wanted.length) {
      const taken = (await this.db.q<{ seatNo: string }>(
        `SELECT seat_no FROM trip_seats WHERE trip_id = $1 AND seat_no = ANY($2::text[])
            AND (status = 'booked' OR hold_expires_at >= now()) AND ($3::text IS NULL OR hold_token::text IS DISTINCT FROM $3) ORDER BY seat_no`,
        [tripId, wanted, token ?? null])).map(r => r.seatNo);
      if (taken.length) throw new AppError('SEAT_TAKEN', 409, taken.length > 1 ? 'Ces sièges viennent d\'être pris' : 'Ce siège vient d\'être pris', { seats: taken });
    }

    return this.db.tx(async t => {
      let hold = token ? await t.maybe<any>(`SELECT * FROM seat_holds WHERE token = $1 AND trip_id = $2 AND expires_at > now() FOR UPDATE`, [token, tripId]) : null;
      if (hold && await t.maybe(`SELECT 1 FROM trip_seats WHERE hold_token = $1 AND booking_id IS NOT NULL LIMIT 1`, [hold.token]))
        throw new AppError('HOLD_LOCKED', 409, 'Une réservation est déjà en cours de paiement avec ces sièges');
      if (!hold) {
        if (!wanted.length) throw new AppError('HOLD_EXPIRED', 409, 'Votre sélection a expiré');
        hold = await t.one<any>(
          `INSERT INTO seat_holds (token, trip_id, owner_user, channel, expires_at) VALUES (gen_random_uuid(), $1, $2, $3, now() + ($4 || ' minutes')::interval) RETURNING *`,
          [tripId, ctx.userId ?? null, ctx.staff ? 'counter' : 'web', String(b.seatHoldMinutes)]);
      }
      const released = (await t.q<{ seatNo: string }>(
        `DELETE FROM trip_seats WHERE trip_id = $1 AND hold_token = $2 AND status = 'held' AND booking_id IS NULL AND NOT (seat_no = ANY($3::text[])) RETURNING seat_no`,
        [tripId, hold.token, wanted])).map(r => r.seatNo);
      const mineBefore = new Set((await t.q<{ seatNo: string }>(`SELECT seat_no FROM trip_seats WHERE trip_id = $1 AND hold_token = $2 AND status = 'held'`, [tripId, hold.token])).map(r => r.seatNo));
      let got: string[] = [];
      if (wanted.length) {
        got = (await t.q<{ seatNo: string }>(
          `INSERT INTO trip_seats (trip_id, seat_no, status, hold_token, hold_expires_at)
           SELECT $1, s, 'held', $2::uuid, $3::timestamptz FROM unnest($4::text[]) AS s ORDER BY s
           ON CONFLICT (trip_id, seat_no) DO UPDATE
              SET hold_token = EXCLUDED.hold_token, hold_expires_at = EXCLUDED.hold_expires_at, status = 'held', booking_id = NULL, updated_at = now()
            WHERE trip_seats.status = 'held' AND (trip_seats.hold_expires_at < now() OR trip_seats.hold_token = EXCLUDED.hold_token)
           RETURNING seat_no`, [tripId, hold.token, hold.expiresAt, wanted])).map(r => r.seatNo);
        if (got.length !== wanted.length) {
          const taken = wanted.filter(s => !got.includes(s));
          throw new AppError('SEAT_TAKEN', 409, taken.length > 1 ? 'Ces sièges viennent d\'être pris' : 'Ce siège vient d\'être pris', { seats: taken });
        }
      } else {
        await t.q('DELETE FROM seat_holds WHERE token = $1', [hold.token]);
      }
      const newly = got.filter(s => !mineBefore.has(s));
      t.afterCommit(() => {
        if (released.length) this.bus.emit(`trip:${tripId}`, 'seat.released', { tripId, seats: released });
        if (newly.length) this.bus.emit(`trip:${tripId}`, 'seat.held', { tripId, seats: newly, expiresAt: hold.expiresAt });
      });
      return { token: hold.token, tripId, seats: wanted, expiresAt: hold.expiresAt, extensionsLeft: Math.max(0, b.holdMaxExtensions - hold.extensions) };
    });
  }

  /** Prolonge le verrou (nombre de prolongations plafonné par les paramètres). */
  async extendHold(tripId: string, token: string): Promise<HoldResult> {
    const b = await this.settings.get('booking');
    return this.db.tx(async t => {
      const hold = await t.maybe<any>(`SELECT * FROM seat_holds WHERE token = $1 AND trip_id = $2 AND expires_at > now() FOR UPDATE`, [token, tripId]);
      if (!hold) throw new AppError('HOLD_EXPIRED', 409, 'Votre sélection a expiré');
      if (hold.extensions >= b.holdMaxExtensions) throw new AppError('HOLD_EXTENSION_LIMIT', 409, 'Le délai ne peut plus être prolongé');
      const up = await t.one<any>(`UPDATE seat_holds SET expires_at = expires_at + ($2 || ' minutes')::interval, extensions = extensions + 1 WHERE token = $1 RETURNING *`, [token, String(b.seatHoldMinutes)]);
      const seats = (await t.q<{ seatNo: string }>(`UPDATE trip_seats SET hold_expires_at = $2, updated_at = now() WHERE hold_token = $1 AND status = 'held' RETURNING seat_no`, [token, up.expiresAt])).map(r => r.seatNo);
      await t.q(`UPDATE bookings SET expires_at = $2 WHERE status = 'pending_payment' AND id IN (SELECT booking_id FROM trip_seats WHERE hold_token = $1 AND booking_id IS NOT NULL)`, [token, up.expiresAt]);
      t.afterCommit(() => this.bus.emit(`trip:${tripId}`, 'seat.held', { tripId, seats, expiresAt: up.expiresAt }));
      return { token, tripId, seats, expiresAt: up.expiresAt, extensionsLeft: Math.max(0, b.holdMaxExtensions - up.extensions) };
    });
  }

  /** Abandon explicite (bouton retour, fermeture de page via sendBeacon). Sans effet si un paiement est en cours. */
  async releaseHold(tripId: string, token: string): Promise<{ released: string[] }> {
    return this.db.tx(async t => {
      const hold = await t.maybe<any>(`SELECT * FROM seat_holds WHERE token = $1 AND trip_id = $2 FOR UPDATE`, [token, tripId]);
      if (!hold) return { released: [] };
      const pendingPay = await t.maybe(
        `SELECT 1 FROM payments p JOIN trip_seats s ON s.booking_id = p.booking_id WHERE s.hold_token = $1 AND p.status IN ('initiated','pending') LIMIT 1`, [token]);
      if (pendingPay) return { released: [] };
      await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'abandoned', cancelled_at = now(), updated_at = now()
                  WHERE status = 'pending_payment' AND id IN (SELECT booking_id FROM trip_seats WHERE hold_token = $1 AND booking_id IS NOT NULL)`, [token]);
      const released = (await t.q<{ seatNo: string }>(`DELETE FROM trip_seats WHERE hold_token = $1 AND status = 'held' RETURNING seat_no`, [token])).map(r => r.seatNo);
      await t.q('DELETE FROM seat_holds WHERE token = $1', [token]);
      if (released.length) t.afterCommit(() => this.bus.emit(`trip:${tripId}`, 'seat.released', { tripId, seats: released }));
      return { released };
    });
  }

  /** Tâche planifiée : libère les verrous expirés et prévient tous les écrans connectés. */
  async sweepExpiredHolds(): Promise<number> {
    const rows = await this.db.q<{ tripId: string; seatNo: string }>(`DELETE FROM trip_seats WHERE status = 'held' AND hold_expires_at < now() RETURNING trip_id, seat_no`);
    const byTrip = new Map<string, string[]>();
    for (const r of rows) byTrip.set(r.tripId, [...(byTrip.get(r.tripId) || []), r.seatNo]);
    for (const [tripId, seats] of byTrip) this.bus.emit(`trip:${tripId}`, 'seat.released', { tripId, seats });
    await this.db.q(`DELETE FROM seat_holds WHERE expires_at < now() - interval '1 hour'`);
    return rows.length;
  }

  /**
   * Attribution définitive de sièges à une réservation (paiement confirmé, vente au guichet, changement de siège).
   * Un siège est accepté s'il est déjà à cette réservation, libre, verrouillé par `holdToken`, ou verrouillé par un tiers mais expiré.
   * Renvoie les sièges obtenus ; l'appelant annule (savepoint) s'il en manque un.
   */
  async acquireBooked(t: Tx, tripId: string, seats: string[], bookingId: string, holdToken: string | null): Promise<string[]> {
    if (!seats.length) return [];
    return (await t.q<{ seatNo: string }>(
      `INSERT INTO trip_seats (trip_id, seat_no, status, booking_id)
       SELECT $1, s, 'booked', $2::uuid FROM unnest($3::text[]) AS s ORDER BY s
       ON CONFLICT (trip_id, seat_no) DO UPDATE
          SET status = 'booked', booking_id = EXCLUDED.booking_id, hold_token = NULL, hold_expires_at = NULL, updated_at = now()
        WHERE trip_seats.booking_id = EXCLUDED.booking_id
           OR (trip_seats.status = 'held' AND (trip_seats.hold_expires_at < now() OR trip_seats.hold_token = $4::uuid))
       RETURNING seat_no`, [tripId, bookingId, [...seats].sort(), holdToken])).map(r => r.seatNo);
  }
}
