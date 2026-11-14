import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePermission, Staff } from '../../common/auth';
import { Api, ZBody, ZPatch, zDate, zEmail, zId, zMoney, zOptText, zPhone, zSeat, zText, zTime, normalizePhone } from '../../common/zod';
import { Db, paging } from '../../common/db';
import { AppError } from '../../common/errors';
import { Audit } from '../../common/audit';
import { EventBus } from '../../common/events';
import { dow, localToUtc, addDays, todayIn } from '../../common/time';
import { SettingsService } from '../settings/settings.service';
import { layoutSeats } from '../settings/schemas';
import { TripsService, TRIP_SELECT } from './trips.service';

const layoutPrices = z.record(z.string().max(40), zMoney);
const layoutDurations = z.record(z.string().max(40), z.number().int().min(1).max(10080));
const citySchema = z.strictObject({ name: zText(80), region: zOptText(80), stationAddress: zOptText(300), isActive: z.boolean().optional() });
const layoutSchema = z.strictObject({
  name: zText(80),
  rows: z.array(z.strictObject({ rowId: zText(10), seats: z.array(zSeat).max(8), aisleAfter: z.number().int().min(0).max(8).optional(), isDriverRow: z.boolean().optional() })).min(1).max(30),
});
const vehicleSchema = z.strictObject({
  name: zText(80), type: z.string().trim().max(80).default(''), layoutId: zId, plateNumber: zText(20),
  status: z.enum(['active', 'maintenance', 'retired']).default('active'), yearBuilt: z.number().int().min(1950).max(2100).nullish(),
  amenities: z.array(z.string().max(30)).max(20).default([]), maintenanceNote: zOptText(500), routeIds: z.array(zId).max(200).optional(),
});
const driverSchema = z.strictObject({
  firstName: zText(60), lastName: zText(60), phone: zPhone.transform(normalizePhone), email: zEmail.nullish(),
  licenseNumber: zText(40), licenseClass: z.enum(['B', 'C', 'D', 'E']).default('D'), licenseExpiry: zDate.nullish(),
  status: z.enum(['active', 'leave', 'suspended', 'resigned']).default('active'), leaveUntil: zDate.nullish(), leaveReason: zOptText(300),
  defaultVehicleId: zId.nullish(), hiredAt: zDate.nullish(), birthDate: zDate.nullish(), address: zOptText(300), notes: zOptText(1000), userId: zId.nullish(),
});
const routeSchema = z.strictObject({
  fromCity: zText(80), toCity: zText(80), distanceKm: z.number().int().min(0).max(100000).default(0),
  durationMin: z.number().int().min(1).max(10080), basePrice: zMoney,
  priceByLayout: layoutPrices.default({}), durationByLayout: layoutDurations.default({}),
  notes: zOptText(1000), vehicleIds: z.array(zId).max(500).optional(),
});
const templateBase = z.strictObject({
  routeId: zId, vehicleId: zId, driverId: zId.nullish(), departureTime: zTime,
  recurrence: z.enum(['once', 'daily', 'weekly', 'weekdays', 'weekends', 'custom']),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  startDate: zDate, endDate: zDate.nullish(), specificDate: zDate.nullish(),
  price: zMoney.nullish(), rank: z.number().int().min(1).max(999).nullish(), notes: zOptText(500),
});
const templateSchema = templateBase.refine(t => t.recurrence !== 'once' || !!t.specificDate, { message: 'Date du voyage ponctuel requise', path: ['specificDate'] })
  .refine(t => !['weekly', 'custom'].includes(t.recurrence) || t.days.length > 0, { message: 'Choisissez au moins un jour', path: ['days'] })
  .refine(t => !t.endDate || t.endDate >= t.startDate, { message: 'La date de fin précède la date de début', path: ['endDate'] });
const tripCreate = z.strictObject({ routeId: zId, vehicleId: zId, driverId: zId.nullish(), date: zDate, departureTime: zTime, price: zMoney.nullish(), notes: zOptText(500) });
const tripPatch = z.strictObject({
  driverId: zId.nullish(), price: zMoney.optional(), notes: zOptText(500), salesOpenAt: z.iso.datetime().nullish(),
  status: z.enum(['scheduled', 'boarding', 'in_progress', 'completed']).optional(),
});


async function cityId(db: Db, name: string, createIfMissing: boolean): Promise<string> {
  const c = await db.maybe<{ id: string }>('SELECT id FROM cities WHERE name = $1', [name]);
  if (c) return c.id;
  if (!createIfMissing) throw new AppError('CITY_NOT_FOUND', 404, `Ville inconnue : ${name}`);
  return (await db.one<{ id: string }>('INSERT INTO cities (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id', [name])).id;
}

@ApiTags('Administration · villes et plans de sièges')
@Controller('admin')
export class ReferenceController {
  constructor(private db: Db, private audit: Audit) {}

  @Staff() @Get('cities') @Api('Villes desservies')
  cities() { return this.db.q('SELECT * FROM cities ORDER BY name'); }
  @RequirePermission('canManageRoutes') @Post('cities') @Api('Ajouter une ville', citySchema)
  createCity(@ZBody(citySchema) b: any) { return this.db.insert('cities', b); }
  @RequirePermission('canManageRoutes') @Patch('cities/:id') @Api('Modifier une ville')
  async updateCity(@Param('id') id: string, @ZPatch(citySchema) b: any) { return this.db.update('cities', zId.parse(id), b); }
  @RequirePermission('canManageRoutes') @HttpCode(204) @Delete('cities/:id') @Api('Supprimer une ville non utilisée')
  async deleteCity(@Param('id') id: string) { await this.db.q('DELETE FROM cities WHERE id = $1', [zId.parse(id)]); }

  @Staff() @Get('seat-layouts') @Api('Plans de sièges')
  layouts() { return this.db.q('SELECT * FROM seat_layouts ORDER BY is_builtin DESC, capacity DESC'); }
  @RequirePermission('canManageFleet') @Post('seat-layouts') @Api('Créer un plan de sièges personnalisé', layoutSchema)
  async createLayout(@ZBody(layoutSchema) b: any, @CurrentUser() u: AuthUser) {
    const seats = layoutSeats(b.rows);
    if (!seats.length) throw new AppError('LAYOUT_EMPTY', 400, 'Le plan ne contient aucun siège');
    if (new Set(seats).size !== seats.length) throw new AppError('LAYOUT_DUPLICATE_SEAT', 400, 'Deux sièges portent le même numéro');
    const code = 'custom-' + Date.now().toString(36);
    const l = await this.db.insert('seat_layouts', { code, name: b.name, capacity: seats.length, rows: b.rows });
    await this.audit.log({ actor: u, category: 'fleet', action: 'Plan de sièges créé', severity: 'success', targetType: 'layout', targetId: l.id, targetName: b.name });
    return l;
  }
  @RequirePermission('canManageFleet') @HttpCode(204) @Delete('seat-layouts/:id') @Api('Supprimer un plan personnalisé non utilisé')
  async deleteLayout(@Param('id') id: string) {
    const l = await this.db.one<any>('SELECT is_builtin FROM seat_layouts WHERE id = $1', [zId.parse(id)]);
    if (l.isBuiltin) throw new AppError('BUILTIN_LAYOUT', 409, 'Un plan intégré ne peut pas être supprimé');
    await this.db.q('DELETE FROM seat_layouts WHERE id = $1', [id]);
  }
}

@ApiTags('Administration · flotte')
@Controller('admin/vehicles')
export class VehiclesController {
  constructor(private db: Db, private audit: Audit) {}
  private readonly select = `
    SELECT v.*, l.code AS vehicle_layout, l.capacity, l.name AS layout_name,
           (SELECT d.first_name || ' ' || d.last_name FROM drivers d WHERE d.default_vehicle_id = v.id AND d.status = 'active' LIMIT 1) AS driver,
           (SELECT coalesce(array_agg(rv.route_id), '{}') FROM route_vehicles rv WHERE rv.vehicle_id = v.id) AS route_ids,
           st.total_trips, st.last_trip, st.next_trip, coalesce(rev.total_revenue, 0) AS total_revenue, coalesce(rev.seats_sold, 0) AS seats_sold
      FROM vehicles v JOIN seat_layouts l ON l.id = v.layout_id
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE t.status = 'completed')::int AS total_trips,
                                max(t.service_date) FILTER (WHERE t.departure_at <= now() AND t.status <> 'cancelled') AS last_trip,
                                min(t.service_date) FILTER (WHERE t.departure_at > now() AND t.status = 'scheduled') AS next_trip
                           FROM trips t WHERE t.vehicle_id = v.id) st ON true
      LEFT JOIN LATERAL (SELECT sum(b.total)::bigint AS total_revenue, count(p.*)::int AS seats_sold
                           FROM trips t JOIN bookings b ON b.trip_id = t.id AND b.status IN ('confirmed','completed','no_show')
                           LEFT JOIN booking_passengers p ON p.booking_id = b.id AND p.status <> 'cancelled'
                          WHERE t.vehicle_id = v.id) rev ON true`;

  @RequirePermission('canViewFleet', 'canViewSeats', 'canViewRoutes', 'canSellWalkin') @Get() @Api('Liste des véhicules')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q, 200, 100);
    const search = String(q.search || '').trim().slice(0, 60), status = String(q.status || '');
    const where = `($1 = '' OR v.name ILIKE '%'||$1||'%' OR v.plate_number ILIKE '%'||$1||'%' OR v.ref ILIKE '%'||$1||'%') AND ($2 = '' OR v.status = $2)`;
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM vehicles v WHERE ${where}`, [search, status])).n;
    const items = await this.db.q(`${this.select} WHERE ${where} ORDER BY v.created_at LIMIT $3 OFFSET $4`, [search, status, limit, offset]);
    return { items, total, page, limit };
  }
  @RequirePermission('canViewFleet') @Get(':id') @Api('Détail d\'un véhicule')
  get(@Param('id') id: string) { return this.db.one(`${this.select} WHERE v.id = $1`, [zId.parse(id)]); }

  private async setRoutes(vehicleId: string, routeIds: string[] | undefined) {
    if (!routeIds) return;
    await this.db.tx(async t => {
      await t.q('DELETE FROM route_vehicles WHERE vehicle_id = $1', [vehicleId]);
      for (const r of routeIds) await t.q('INSERT INTO route_vehicles (route_id, vehicle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r, vehicleId]);
    });
  }
  @RequirePermission('canManageFleet') @Post() @Api('Ajouter un véhicule', vehicleSchema)
  async create(@ZBody(vehicleSchema) b: any, @CurrentUser() u: AuthUser) {
    const { routeIds, ...cols } = b;
    const plate = cols.plateNumber.toUpperCase();
    const ref = 'VEH-' + plate.replace(/[^A-Z0-9]/g, '').slice(-6) + '-' + Date.now().toString(36).slice(-3).toUpperCase();
    const v = await this.db.insert<any>('vehicles', { ...cols, plateNumber: plate, ref });
    await this.setRoutes(v.id, routeIds);
    await this.audit.log({ actor: u, category: 'fleet', action: 'Véhicule ajouté', severity: 'success', targetType: 'vehicle', targetId: v.id, targetName: `${v.name} (${v.plateNumber})` });
    return this.get(v.id);
  }
  @RequirePermission('canManageFleet') @Patch(':id') @Api('Modifier un véhicule')
  async update(@Param('id') id: string, @ZPatch(vehicleSchema) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>('SELECT * FROM vehicles WHERE id = $1', [zId.parse(id)]);
    const { routeIds, ...cols } = b;
    if (cols.layoutId && cols.layoutId !== before.layoutId) {
      const future = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM trips t WHERE t.vehicle_id = $1 AND t.departure_at > now() AND t.status <> 'cancelled' AND EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id)`, [id]);
      if (future.n > 0) throw new AppError('LAYOUT_CHANGE_BLOCKED', 409, `Ce véhicule a ${future.n} voyage(s) à venir avec des sièges vendus. Utilisez « Remplacer le véhicule » sur ces voyages.`);
    }
    if (cols.plateNumber) cols.plateNumber = cols.plateNumber.toUpperCase();
    await this.db.update('vehicles', id, { ...cols, updatedAt: new Date() });
    if (cols.layoutId && cols.layoutId !== before.layoutId)
      await this.db.q(`UPDATE trips SET layout_id = $2 WHERE vehicle_id = $1 AND departure_at > now() AND status = 'scheduled'`, [id, cols.layoutId]);
    await this.setRoutes(id, routeIds);
    await this.audit.log({ actor: u, category: 'fleet', action: 'Véhicule modifié', targetType: 'vehicle', targetId: id, targetName: before.name,
      severity: cols.status && cols.status !== before.status ? 'warning' : 'info', diff: this.audit.diff(before, cols) });
    const out: any = await this.get(id);
    if (cols.status && cols.status !== 'active' && before.status === 'active')
      out.upcomingTrips = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM trips WHERE vehicle_id = $1 AND departure_at > now() AND status = 'scheduled'`, [id])).n;
    return out;
  }
  @RequirePermission('canManageFleet') @HttpCode(204) @Delete(':id') @Api('Supprimer un véhicule sans historique')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const v = await this.db.one<any>('SELECT * FROM vehicles WHERE id = $1', [zId.parse(id)]);
    const used = await this.db.maybe('SELECT 1 FROM trips WHERE vehicle_id = $1 LIMIT 1', [id]);
    if (used) throw new AppError('VEHICLE_HAS_HISTORY', 409, 'Ce véhicule a un historique de voyages : passez-le en « retiré » plutôt que de le supprimer');
    await this.db.q('DELETE FROM trip_templates WHERE vehicle_id = $1', [id]);
    await this.db.q('UPDATE drivers SET default_vehicle_id = NULL WHERE default_vehicle_id = $1', [id]);
    await this.db.q('DELETE FROM vehicles WHERE id = $1', [id]);
    await this.audit.log({ actor: u, category: 'fleet', action: 'Véhicule supprimé', severity: 'danger', targetType: 'vehicle', targetId: id, targetName: v.name });
  }
}

@ApiTags('Administration · chauffeurs')
@Controller('admin/drivers')
export class DriversController {
  constructor(private db: Db, private audit: Audit, private bus: EventBus) {}
  private readonly select = `
    SELECT d.*, v.name AS vehicle_name, v.plate_number AS vehicle_plate,
           (SELECT count(*)::int FROM trips t WHERE t.driver_id = d.id AND t.status = 'completed') AS total_trips,
           (SELECT coalesce(sum(r.distance_km), 0)::int FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.driver_id = d.id AND t.status = 'completed') AS total_km
      FROM drivers d LEFT JOIN vehicles v ON v.id = d.default_vehicle_id`;

  @RequirePermission('canViewDrivers', 'canViewRoutes') @Get() @Api('Liste des chauffeurs')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q, 200, 100);
    const search = String(q.search || '').trim().slice(0, 60), status = String(q.status || '');
    const where = `($1 = '' OR d.first_name ILIKE '%'||$1||'%' OR d.last_name ILIKE '%'||$1||'%' OR d.phone LIKE '%'||$1||'%' OR d.license_number ILIKE '%'||$1||'%') AND ($2 = '' OR d.status = $2)`;
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM drivers d WHERE ${where}`, [search, status])).n;
    const items = await this.db.q(`${this.select} WHERE ${where} ORDER BY d.last_name, d.first_name LIMIT $3 OFFSET $4`, [search, status, limit, offset]);
    return { items, total, page, limit };
  }
  @RequirePermission('canManageDrivers') @Post() @Api('Ajouter un chauffeur', driverSchema)
  async create(@ZBody(driverSchema) b: any, @CurrentUser() u: AuthUser) {
    const d = await this.db.insert<any>('drivers', b);
    await this.audit.log({ actor: u, category: 'fleet', action: 'Chauffeur ajouté', severity: 'success', targetType: 'driver', targetId: d.id, targetName: `${d.firstName} ${d.lastName}` });
    return this.db.one(`${this.select} WHERE d.id = $1`, [d.id]);
  }
  /** Un chauffeur qui devient indisponible déclenche une alerte sur ses voyages à venir ; les voyages restent vendus. */
  @RequirePermission('canManageDrivers') @Patch(':id') @Api('Modifier un chauffeur (statut, congé, véhicule)')
  async update(@Param('id') id: string, @ZPatch(driverSchema) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>('SELECT * FROM drivers WHERE id = $1', [zId.parse(id)]);
    await this.db.update('drivers', id, { ...b, updatedAt: new Date() });
    const out: any = await this.db.one(`${this.select} WHERE d.id = $1`, [id]);
    if (b.status && b.status !== 'active' && before.status === 'active') {
      const affected = await this.db.q<any>(
        `SELECT t.id, t.service_date, t.departure_at FROM trips t WHERE t.driver_id = $1 AND t.status = 'scheduled' AND t.departure_at > now()
            AND ($2::date IS NULL OR t.service_date <= $2::date) ORDER BY t.departure_at LIMIT 200`, [id, b.status === 'leave' ? (b.leaveUntil ?? null) : null]);
      out.affectedTrips = affected;
      if (affected.length) this.bus.emit('staff', 'alert', { type: 'driver_unavailable', driverId: id, driverName: `${before.firstName} ${before.lastName}`, trips: affected.length });
    }
    await this.audit.log({ actor: u, category: 'fleet', action: 'Chauffeur modifié', targetType: 'driver', targetId: id, targetName: `${before.firstName} ${before.lastName}`,
      severity: b.status && b.status !== before.status ? 'warning' : 'info', diff: this.audit.diff(before, b) });
    return out;
  }
  @RequirePermission('canManageDrivers') @HttpCode(204) @Delete(':id') @Api('Supprimer un chauffeur sans historique')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const d = await this.db.one<any>('SELECT * FROM drivers WHERE id = $1', [zId.parse(id)]);
    if (await this.db.maybe('SELECT 1 FROM trips WHERE driver_id = $1 LIMIT 1', [id])) throw new AppError('DRIVER_HAS_HISTORY', 409, 'Ce chauffeur a un historique : passez-le en « démissionnaire » plutôt que de le supprimer');
    await this.db.q('UPDATE trip_templates SET driver_id = NULL WHERE driver_id = $1', [id]);
    await this.db.q('DELETE FROM drivers WHERE id = $1', [id]);
    await this.audit.log({ actor: u, category: 'fleet', action: 'Chauffeur supprimé', severity: 'danger', targetType: 'driver', targetId: id, targetName: `${d.firstName} ${d.lastName}` });
  }
}

@ApiTags('Administration · itinéraires')
@Controller('admin/routes')
export class RoutesController {
  constructor(private db: Db, private audit: Audit, private trips: TripsService) {}
  private readonly select = `
    SELECT r.*, cf.name AS from_city, ct.name AS to_city,
           (SELECT coalesce(array_agg(rv.vehicle_id), '{}') FROM route_vehicles rv WHERE rv.route_id = r.id) AS assigned_vehicle_ids,
           (SELECT count(*)::int FROM trips t WHERE t.route_id = r.id AND t.status = 'completed') AS total_trips,
           (SELECT coalesce(sum(b.total), 0)::bigint FROM trips t JOIN bookings b ON b.trip_id = t.id AND b.status IN ('confirmed','completed','no_show') WHERE t.route_id = r.id) AS total_revenue
      FROM routes r JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id`;

  @RequirePermission('canViewRoutes', 'canSellWalkin', 'canViewSeats') @Get() @Api('Liste des itinéraires')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q, 200, 100);
    const status = String(q.status || '');
    const where = `($1 = '' OR r.status = $1) AND ($1 <> '' OR r.status <> 'deleted' OR $2)`;
    const params = [status, q.includeDeleted === 'true'];
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM routes r WHERE ${where}`, params)).n;
    const items = await this.db.q(`${this.select} WHERE ${where} ORDER BY cf.name, ct.name LIMIT $3 OFFSET $4`, [...params, limit, offset]);
    return { items, total, page, limit };
  }
  private async setVehicles(routeId: string, ids?: string[]) {
    if (!ids) return;
    await this.db.tx(async t => {
      await t.q('DELETE FROM route_vehicles WHERE route_id = $1', [routeId]);
      for (const v of ids) await t.q('INSERT INTO route_vehicles (route_id, vehicle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [routeId, v]);
    });
  }
  @RequirePermission('canManageRoutes') @Post() @Api('Créer un itinéraire', routeSchema)
  async create(@ZBody(routeSchema) b: any, @CurrentUser() u: AuthUser) {
    const { fromCity, toCity, vehicleIds, ...cols } = b;
    if (fromCity.toLowerCase() === toCity.toLowerCase()) throw new AppError('SAME_CITY', 400, 'Le départ et l\'arrivée doivent être différents');
    const r = await this.db.insert<any>('routes', { ...cols, fromCityId: await cityId(this.db, fromCity, true), toCityId: await cityId(this.db, toCity, true) });
    await this.setVehicles(r.id, vehicleIds);
    await this.audit.log({ actor: u, category: 'routes', action: 'Itinéraire créé', severity: 'success', targetType: 'route', targetId: r.id, targetName: `${fromCity} → ${toCity}` });
    return this.db.one(`${this.select} WHERE r.id = $1`, [r.id]);
  }
  @RequirePermission('canManageRoutes') @Patch(':id') @Api('Modifier un itinéraire (tarifs, durée, véhicules)')
  async update(@Param('id') id: string, @ZPatch(routeSchema) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>(`${this.select} WHERE r.id = $1`, [zId.parse(id)]);
    const { fromCity, toCity, vehicleIds, ...cols } = b;
    if (fromCity) cols.fromCityId = await cityId(this.db, fromCity, true);
    if (toCity) cols.toCityId = await cityId(this.db, toCity, true);
    await this.db.update('routes', id, { ...cols, updatedAt: new Date() });
    await this.setVehicles(id, vehicleIds);
    await this.audit.log({ actor: u, category: 'routes', action: 'Itinéraire modifié', targetType: 'route', targetId: id, targetName: `${before.fromCity} → ${before.toCity}`, diff: this.audit.diff(before, cols) });
    return this.db.one(`${this.select} WHERE r.id = $1`, [id]);
  }
  /** Suspendre ferme la vente. Les voyages déjà vendus restent programmés : c'est à l'exploitant de les annuler un par un s'il le faut. */
  @RequirePermission('canManageRoutes') @HttpCode(200) @Post(':id/suspend') @Api('Suspendre un itinéraire (ferme les ventes)')
  async suspend(@Param('id') id: string, @ZBody(z.strictObject({ reason: zText(300), until: zDate.nullish() })) b: any, @CurrentUser() u: AuthUser) {
    const r = await this.db.one<any>(`${this.select} WHERE r.id = $1`, [zId.parse(id)]);
    await this.db.q(`UPDATE routes SET status = 'suspended', suspend_reason = $2, suspended_until = $3, updated_at = now() WHERE id = $1`, [id, b.reason, b.until ?? null]);
    const sold = await this.db.q(
      `SELECT t.id, t.service_date, t.departure_at, (SELECT count(*)::int FROM trip_seats s WHERE s.trip_id = t.id AND s.status = 'booked') AS seats_booked
         FROM trips t WHERE t.route_id = $1 AND t.status = 'scheduled' AND t.departure_at > now()
          AND EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id AND s.status = 'booked') ORDER BY t.departure_at LIMIT 200`, [id]);
    await this.audit.log({ actor: u, category: 'routes', action: 'Itinéraire suspendu', severity: 'warning', targetType: 'route', targetId: id, targetName: `${r.fromCity} → ${r.toCity}`, details: b.reason });
    return { ...(await this.db.one(`${this.select} WHERE r.id = $1`, [id])), soldTrips: sold };
  }
  @RequirePermission('canManageRoutes') @HttpCode(200) @Post(':id/reactivate') @Api('Réactiver ou restaurer un itinéraire')
  async reactivate(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const r = await this.db.one<any>(`${this.select} WHERE r.id = $1`, [zId.parse(id)]);
    await this.db.q(`UPDATE routes SET status = 'active', suspend_reason = NULL, suspended_until = NULL, updated_at = now() WHERE id = $1`, [id]);
    await this.trips.generate();
    await this.audit.log({ actor: u, category: 'routes', action: 'Itinéraire réactivé', severity: 'success', targetType: 'route', targetId: id, targetName: `${r.fromCity} → ${r.toCity}` });
    return this.db.one(`${this.select} WHERE r.id = $1`, [id]);
  }
  @RequirePermission('canManageRoutes') @HttpCode(204) @Delete(':id') @Api('Supprimer un itinéraire (corbeille, ou définitif s\'il n\'a aucun historique)')
  async remove(@Param('id') id: string, @Query('hard') hard: string, @CurrentUser() u: AuthUser) {
    const r = await this.db.one<any>(`${this.select} WHERE r.id = $1`, [zId.parse(id)]);
    const future = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM trips t WHERE t.route_id = $1 AND t.departure_at > now() AND t.status = 'scheduled' AND EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id AND s.status = 'booked')`, [id]);
    if (future.n > 0) throw new AppError('ROUTE_HAS_SOLD_TRIPS', 409, `${future.n} voyage(s) à venir ont des billets vendus : annulez-les d'abord`);
    if (hard === 'true' && !(await this.db.maybe('SELECT 1 FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE t.route_id = $1 LIMIT 1', [id]))) {
      await this.db.tx(async t => {
        await t.q('DELETE FROM trips WHERE route_id = $1', [id]);
        await t.q('DELETE FROM trip_templates WHERE route_id = $1', [id]);
        await t.q('DELETE FROM routes WHERE id = $1', [id]);
      });
    } else {
      await this.db.q(`UPDATE routes SET status = 'deleted', updated_at = now() WHERE id = $1`, [id]);
      await this.db.q(`DELETE FROM trips t WHERE t.route_id = $1 AND t.departure_at > now() AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id = t.id) AND NOT EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id)`, [id]);
    }
    await this.audit.log({ actor: u, category: 'routes', action: 'Itinéraire supprimé', severity: 'danger', targetType: 'route', targetId: id, targetName: `${r.fromCity} → ${r.toCity}` });
  }
}

// ── Détection des conflits entre modèles (même véhicule, jours communs, créneaux qui se chevauchent) ───────────────
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const daysOf = (t: any): number[] => t.recurrence === 'once' ? [dow(t.specificDate ?? t.startDate)] : t.recurrence === 'daily' ? [0, 1, 2, 3, 4, 5, 6]
  : t.recurrence === 'weekdays' ? [1, 2, 3, 4, 5] : t.recurrence === 'weekends' ? [0, 6] : t.days || [];
export function templatesConflict(a: any, b: any): boolean {
  if (a.vehicleId !== b.vehicleId || a.status === 'cancelled' || b.status === 'cancelled') return false;
  const sA = a.recurrence === 'once' ? a.specificDate : a.startDate, sB = b.recurrence === 'once' ? b.specificDate : b.startDate;
  const eA = a.recurrence === 'once' ? a.specificDate : (a.endDate ?? '9999-12-31'), eB = b.recurrence === 'once' ? b.specificDate : (b.endDate ?? '9999-12-31');
  if (sA > eB || sB > eA) return false;
  // un voyage qui passe minuit occupe aussi le début du lendemain
  const span = (t: any) => daysOf(t).flatMap(d => { const s = d * 1440 + toMin(t.departureTime); return [[s, s + t.durationMin], [s + 10080, s + t.durationMin + 10080], [s - 10080, s + t.durationMin - 10080]]; });
  return span(a).some(([s1, e1]) => span(b).some(([s2, e2]) => s1 < e2 && e1 > s2));
}

@ApiTags('Administration · voyages programmés')
@Controller('admin/trip-templates')
export class TemplatesController {
  constructor(private db: Db, private audit: Audit, private trips: TripsService) {}
  private readonly select = `
    SELECT tt.*, cf.name AS from_city, ct.name AS to_city, v.name AS vehicle_name, v.plate_number, l.code AS layout_code, l.capacity,
           coalesce((r.duration_by_layout ->> l.code)::int, r.duration_min) AS duration_min,
           coalesce(tt.price, (r.price_by_layout ->> l.code)::bigint, r.base_price) AS effective_price,
           CASE WHEN d.id IS NULL THEN NULL ELSE d.first_name || ' ' || d.last_name END AS driver_name
      FROM trip_templates tt JOIN routes r ON r.id = tt.route_id JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
      JOIN vehicles v ON v.id = tt.vehicle_id JOIN seat_layouts l ON l.id = v.layout_id LEFT JOIN drivers d ON d.id = tt.driver_id`;

  @RequirePermission('canViewRoutes') @Get() @Api('Voyages programmés (récurrences) avec conflits éventuels')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q, 500, 200);
    const all = await this.db.q<any>(`${this.select} WHERE ($1::uuid IS NULL OR tt.route_id = $1) ORDER BY cf.name, ct.name, tt.rank NULLS LAST, tt.departure_time`, [q.routeId ? zId.parse(q.routeId) : null]);
    const withConflicts = all.map(t => { const c = all.find(o => o.id !== t.id && templatesConflict(t, o)); return { ...t, conflictWith: c ? { id: c.id, departureTime: c.departureTime, fromCity: c.fromCity, toCity: c.toCity } : null }; });
    return { items: withConflicts.slice(offset, offset + limit), total: all.length, page, limit };
  }
  private async check(b: any) {
    const v = await this.db.maybe<any>('SELECT status FROM vehicles WHERE id = $1', [b.vehicleId]);
    if (!v) throw new AppError('VEHICLE_NOT_FOUND', 404);
    const r = await this.db.maybe<any>('SELECT status FROM routes WHERE id = $1', [b.routeId]);
    if (!r || r.status === 'deleted') throw new AppError('ROUTE_NOT_FOUND', 404);
  }
  @RequirePermission('canManageRoutes') @Post() @Api('Programmer un voyage (ponctuel ou récurrent)', templateSchema)
  async create(@ZBody(templateSchema) b: any, @CurrentUser() u: AuthUser) {
    await this.check(b);
    const tt = await this.db.insert<any>('trip_templates', b);
    const report = await this.trips.generate({ templateId: tt.id });
    const row = await this.db.one<any>(`${this.select} WHERE tt.id = $1`, [tt.id]);
    await this.audit.log({ actor: u, category: 'trips', action: 'Voyage programmé', severity: 'success', targetType: 'trip_template', targetId: tt.id,
      targetName: `${row.fromCity} → ${row.toCity} ${row.departureTime}`, details: `Récurrence : ${b.recurrence} · ${report.created} départ(s) créé(s)` });
    return { ...row, generation: report };
  }
  @RequirePermission('canManageRoutes') @Patch(':id') @Api('Modifier un voyage programmé')
  async update(@Param('id') id: string, @ZPatch(templateBase) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>(`${this.select} WHERE tt.id = $1`, [zId.parse(id)]);
    const raw = await this.db.one<any>('SELECT route_id, vehicle_id, driver_id, departure_time, recurrence, days, start_date, end_date, specific_date, price, rank, notes FROM trip_templates WHERE id = $1', [id]);
    const merged = templateSchema.parse({ ...raw, notes: raw.notes ?? undefined, ...b });   // le modèle complet doit rester cohérent
    await this.check(merged);
    await this.db.update('trip_templates', id, { ...b, updatedAt: new Date() });
    const sync = await this.trips.resyncTemplate(id);
    await this.audit.log({ actor: u, category: 'trips', action: 'Voyage programmé modifié', targetType: 'trip_template', targetId: id,
      targetName: `${before.fromCity} → ${before.toCity} ${before.departureTime}`, diff: this.audit.diff(before, b),
      details: sync.kept ? `${sync.kept} départ(s) déjà vendus conservés tels quels` : undefined });
    return { ...(await this.db.one(`${this.select} WHERE tt.id = $1`, [id])), generation: sync.report, keptSoldTrips: sync.kept };
  }
  @RequirePermission('canManageRoutes') @HttpCode(200) @Put('reorder') @Api('Réordonner les départs d\'un itinéraire')
  async reorder(@ZBody(z.strictObject({ ids: z.array(zId).min(1).max(200) })) b: any) {
    await this.db.tx(async t => {
      for (let i = 0; i < b.ids.length; i++) {
        await t.q('UPDATE trip_templates SET rank = $2, updated_at = now() WHERE id = $1', [b.ids[i], i + 1]);
        await t.q(`UPDATE trips SET rank = $2 WHERE template_id = $1 AND departure_at > now()`, [b.ids[i], i + 1]);
      }
    });
    return { ok: true };
  }
  /** Arrête la récurrence. Les départs futurs non vendus disparaissent ; les départs vendus restent et se traitent un par un. */
  @RequirePermission('canManageRoutes') @HttpCode(200) @Post(':id/cancel') @Api('Arrêter un voyage programmé')
  async cancel(@Param('id') id: string, @ZBody(z.strictObject({ reason: zOptText(300) })) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>(`${this.select} WHERE tt.id = $1`, [zId.parse(id)]);
    await this.db.q(`UPDATE trip_templates SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`, [id, b.reason ?? null]);
    const removed = await this.db.q(`DELETE FROM trips t WHERE t.template_id = $1 AND t.departure_at > now() AND t.status = 'scheduled'
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id = t.id) AND NOT EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id) RETURNING id`, [id]);
    const sold = await this.db.q(`SELECT id, service_date, departure_at FROM trips WHERE template_id = $1 AND departure_at > now() AND status = 'scheduled' ORDER BY departure_at`, [id]);
    await this.audit.log({ actor: u, category: 'trips', action: 'Voyage programmé arrêté', severity: 'danger', targetType: 'trip_template', targetId: id,
      targetName: `${before.fromCity} → ${before.toCity} ${before.departureTime}`, details: b.reason });
    return { removedTrips: removed.length, soldTrips: sold };
  }
  @RequirePermission('canManageRoutes') @HttpCode(200) @Post(':id/resume') @Api('Reprendre un voyage programmé arrêté')
  async resume(@Param('id') id: string) {
    await this.db.q(`UPDATE trip_templates SET status = 'scheduled', cancel_reason = NULL, updated_at = now() WHERE id = $1`, [zId.parse(id)]);
    return { generation: await this.trips.generate({ templateId: id }) };
  }
  @RequirePermission('canManageRoutes') @HttpCode(204) @Delete(':id') @Api('Supprimer un voyage programmé jamais vendu')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>(`${this.select} WHERE tt.id = $1`, [zId.parse(id)]);
    await this.db.q(`DELETE FROM trips t WHERE t.template_id = $1 AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id = t.id) AND NOT EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = t.id)`, [id]);
    await this.db.q('DELETE FROM trip_templates WHERE id = $1', [id]);   // les voyages vendus gardent leur historique (template_id passe à NULL)
    await this.audit.log({ actor: u, category: 'trips', action: 'Voyage programmé supprimé', severity: 'danger', targetType: 'trip_template', targetId: id, targetName: `${before.fromCity} → ${before.toCity} ${before.departureTime}` });
  }
}

@ApiTags('Administration · voyages')
@Controller('admin/trips')
export class TripsAdminController {
  constructor(private db: Db, private audit: Audit, private trips: TripsService, private settings: SettingsService, private bus: EventBus) {}

  @RequirePermission('canViewRoutes', 'canViewSeats', 'canSellWalkin', 'canViewBookings') @Get() @Api('Voyages réels sur une période (planning)')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q, 500, 100);
    // sans période : la semaine à venir (fuseau de la société)
    const today = todayIn((await this.settings.get('locale')).timezone);
    const from = zDate.parse(q.from ?? q.date ?? today), to = zDate.parse(q.to ?? q.date ?? (q.from ? q.from : addDays(today, 6)));
    if (to < from || addDays(from, 92) < to) throw new AppError('INVALID_PERIOD', 400, 'Période invalide (92 jours maximum)');
    const params = [from, to, q.routeId ? zId.parse(q.routeId) : null, q.vehicleId ? zId.parse(q.vehicleId) : null, q.driverId ? zId.parse(q.driverId) : null, String(q.status || '')];
    const where = `t.service_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR t.route_id = $3) AND ($4::uuid IS NULL OR t.vehicle_id = $4) AND ($5::uuid IS NULL OR t.driver_id = $5) AND ($6 = '' OR t.status = $6)`;
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM trips t WHERE ${where}`, params)).n;
    const items = await this.db.q(`${TRIP_SELECT} WHERE ${where} ORDER BY t.departure_at, t.rank NULLS LAST LIMIT $7 OFFSET $8`, [...params, limit, offset]);
    return { items, total, page, limit };
  }
  @RequirePermission('canViewRoutes', 'canViewSeats', 'canSellWalkin', 'canViewBookings') @Get(':id') @Api('Détail d\'un voyage')
  get(@Param('id') id: string) { return this.trips.tripById(zId.parse(id)); }

  @RequirePermission('canManageRoutes') @Post() @Api('Créer un voyage isolé', tripCreate)
  async create(@ZBody(tripCreate) b: any, @CurrentUser() u: AuthUser) {
    const locale = await this.settings.get('locale');
    const route = await this.db.one<any>('SELECT * FROM routes WHERE id = $1', [b.routeId]);
    const v = await this.db.one<any>('SELECT v.*, l.code AS layout_code FROM vehicles v JOIN seat_layouts l ON l.id = v.layout_id WHERE v.id = $1', [b.vehicleId]);
    if (v.status !== 'active') throw new AppError('VEHICLE_UNAVAILABLE', 409, 'Ce véhicule n\'est pas en service');
    const { price, durationMin } = this.trips.resolve(route, v.layoutCode, b.price);
    const dep = localToUtc(b.date, b.departureTime, locale.timezone);
    if (dep.getTime() < Date.now()) throw new AppError('TRIP_IN_PAST', 400, 'La date de départ est passée');
    const t = await this.db.insert<any>('trips', { routeId: b.routeId, vehicleId: b.vehicleId, driverId: b.driverId ?? null, layoutId: v.layoutId, serviceDate: b.date,
      departureAt: dep, arrivalAt: new Date(dep.getTime() + durationMin * 60000), price, notes: b.notes });
    await this.audit.log({ actor: u, category: 'trips', action: 'Voyage créé', severity: 'success', targetType: 'trip', targetId: t.id });
    return this.trips.tripById(t.id);
  }
  @RequirePermission('canManageRoutes') @Patch(':id') @Api('Modifier un voyage (chauffeur, prix, statut, ouverture des ventes)', tripPatch)
  async update(@Param('id') id: string, @ZBody(tripPatch) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.trips.tripById(zId.parse(id));
    if (before.status === 'cancelled') throw new AppError('TRIP_CANCELLED', 409, 'Ce voyage est annulé');
    if (b.driverId) {
      const d = await this.db.one<any>('SELECT status FROM drivers WHERE id = $1', [b.driverId]);
      if (d.status !== 'active') throw new AppError('DRIVER_UNAVAILABLE', 409, 'Ce chauffeur n\'est pas disponible');
    }
    await this.db.update('trips', id, { ...b, updatedAt: new Date() });
    const after = await this.trips.tripById(id);
    this.bus.emit(`trip:${id}`, 'trip.updated', { tripId: id, status: after.status, price: after.price });
    await this.audit.log({ actor: u, category: 'trips', action: 'Voyage modifié', targetType: 'trip', targetId: id,
      targetName: `${before.fromCity} → ${before.toCity} ${before.serviceDate}`, diff: this.audit.diff(before, b) });
    return after;
  }
  @RequirePermission('canManageRoutes') @HttpCode(200) @Post('generate') @Api('Régénérer les voyages à partir des modèles')
  generate() { return this.trips.generate(); }
}
