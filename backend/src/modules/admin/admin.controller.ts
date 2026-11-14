import { Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, ClientIp, CurrentUser, Public, RateLimit, RequirePermission, can } from '../../common/auth';
import { Api, ZBody, ZPatch, zColor, zDate, zEmail, zId, zPhone, zSeat, zText } from '../../common/zod';
import { Db, paging } from '../../common/db';
import { AppError } from '../../common/errors';
import { Audit } from '../../common/audit';
import { addDays, todayIn } from '../../common/time';
import { SettingsService } from '../settings/settings.service';
import { BookingsService } from '../booking/bookings.service';
import { SeatsService } from '../booking/seats.service';
import { PaymentsService } from '../payments/payments.service';
import { Idempotency } from '../../common/idempotency';
import { TripsService, TRIP_SELECT } from '../transport/trips.service';

const passenger = z.strictObject({ seatNo: zSeat, firstName: zText(60), lastName: zText(60), phone: z.union([z.literal(''), zPhone]).optional(), gender: z.enum(['M', 'F', '']).default(''), category: z.enum(['adult', 'child']).default('adult') });
const walkinSchema = z.strictObject({
  tripId: zId, holdToken: zId.nullish(), passengers: z.array(passenger).min(1).max(60),
  contact: z.strictObject({ name: zText(120), phone: zPhone, email: z.union([z.literal(''), zEmail]).nullish() }),
  paymentMethod: z.string().min(2).max(40).default('cash'), payerPhone: zPhone.optional(), amountReceived: z.number().int().min(0).optional(),
  createAccount: z.boolean().default(false), lang: z.string().max(5).optional(),
});
const BOOKING_LIST = `
  SELECT b.id, b.reference, b.status, b.channel, b.total, b.currency, b.created_at, b.contact_name, b.contact_phone, b.contact_email, b.customer_id, b.needs_attention, b.cancel_reason,
         t.service_date, t.departure_at, cf.name AS from_city, ct.name AS to_city, v.name AS vehicle_name, b.trip_id,
         (SELECT array_agg(p.seat_no ORDER BY p.seat_no) FROM booking_passengers p WHERE p.booking_id = b.id AND p.status <> 'cancelled') AS seats,
         (SELECT (array_agg(pm.method ORDER BY pm.created_at DESC))[1] FROM payments pm WHERE pm.booking_id = b.id) AS payment_method,
         CASE WHEN EXISTS (SELECT 1 FROM payments pm WHERE pm.booking_id = b.id AND pm.status IN ('refunded','refund_pending','partially_refunded')) THEN 'refunded'
              WHEN EXISTS (SELECT 1 FROM payments pm WHERE pm.booking_id = b.id AND pm.status = 'succeeded') THEN 'paid' ELSE 'pending' END AS payment_status,
         (SELECT su.first_name || ' ' || su.last_name FROM users su WHERE su.id = b.sold_by) AS sold_by_name
    FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
    JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id JOIN vehicles v ON v.id = t.vehicle_id`;

@ApiTags('Administration · réservations et guichet')
@Controller('admin')
export class BookingsAdminController {
  constructor(private db: Db, private bookings: BookingsService, private seats: SeatsService, private payments: PaymentsService, private idem: Idempotency, private audit: Audit) {}

  @RequirePermission('canViewBookings') @Get('bookings') @Api('Réservations (pagination, recherche, filtres)')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q);
    const params = [String(q.search || '').trim().slice(0, 80), String(q.status || ''), q.from ? zDate.parse(q.from) : null, q.to ? zDate.parse(q.to) : null,
      q.tripId ? zId.parse(q.tripId) : null, String(q.channel || ''), q.attention === 'true'];
    const where = `($1 = '' OR b.reference ILIKE '%'||$1||'%' OR b.contact_name ILIKE '%'||$1||'%' OR b.contact_phone LIKE '%'||$1||'%' OR b.contact_email ILIKE '%'||$1||'%')
      AND ($2 = '' OR b.status = $2) AND ($3::date IS NULL OR t.service_date >= $3) AND ($4::date IS NULL OR t.service_date <= $4)
      AND ($5::uuid IS NULL OR b.trip_id = $5) AND ($6 = '' OR b.channel = $6) AND (NOT $7 OR b.needs_attention)`;
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE ${where}`, params)).n;
    const items = await this.db.q(`${BOOKING_LIST} WHERE ${where} ORDER BY b.created_at DESC LIMIT $8 OFFSET $9`, [...params, limit, offset]);
    return { items, total, page, limit };
  }
  @RequirePermission('canViewBookings', 'canSellWalkin') @Get('bookings/:id') @Api('Détail d\'une réservation')
  get(@Param('id') id: string) { return this.bookings.view(zId.parse(id), { withToken: true }); }

  @RequirePermission('canManageBookings') @HttpCode(200) @Post('bookings/:id/cancel') @Api('Annuler une réservation (remboursement selon la politique, ou pourcentage imposé)')
  cancel(@Param('id') id: string, @ZBody(z.strictObject({ passengerIds: z.array(zId).max(60).optional(), reason: z.string().trim().max(300).optional(), refundPercent: z.number().min(0).max(100).optional() })) b: any,
    @CurrentUser() u: AuthUser, @ClientIp() ip: string) { return this.bookings.cancel(zId.parse(id), { user: u, ip }, { ...b, mode: 'staff' }); }
  @RequirePermission('canManageBookings') @HttpCode(200) @Post('bookings/:id/change') @Api('Changer les sièges ou le départ d\'une réservation')
  change(@Param('id') id: string, @ZBody(z.strictObject({ tripId: zId.optional(), seats: z.array(z.strictObject({ passengerId: zId, seatNo: zSeat })).max(60), holdToken: zId.nullish(), collectDifference: z.boolean().optional() })) b: any,
    @CurrentUser() u: AuthUser, @ClientIp() ip: string) { return this.bookings.change(zId.parse(id), { user: u, ip }, b, 'staff'); }
  @RequirePermission('canManageBookings') @HttpCode(200) @Post('bookings/:id/no-show') @Api('Marquer des passagers absents')
  noShow(@Param('id') id: string, @ZBody(z.strictObject({ passengerIds: z.array(zId).max(60).optional() })) b: any, @CurrentUser() u: AuthUser) { return this.bookings.markNoShow(zId.parse(id), u, b.passengerIds); }
  @RequirePermission('canManageBookings') @HttpCode(200) @Post('bookings/:id/resolve') @Api('Lever le signalement « à traiter »')
  async resolve(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    await this.db.q('UPDATE bookings SET needs_attention = false, updated_at = now() WHERE id = $1', [zId.parse(id)]);
    await this.audit.log({ actor: u, category: 'bookings', action: 'Signalement traité', targetType: 'booking', targetId: id });
    return this.bookings.view(id);
  }

  /** Vente au guichet. Espèces : réservation, encaissement et billets dans une seule transaction. Mobile money : réservation puis demande de paiement. */
  @RequirePermission('canSellWalkin') @RateLimit('walkin', 120, 60) @Post('walkin') @Api('Vente au guichet (en-tête Idempotency-Key requis)', walkinSchema)
  async walkin(@ZBody(walkinSchema) b: any, @CurrentUser() u: AuthUser, @ClientIp() ip: string, @Headers() h: any) {
    const key = Idempotency.key(h);
    return this.idem.run(`walkin:${u.id}`, key, b, async () => {
      const { paymentMethod, payerPhone, amountReceived, createAccount, ...input } = b;
      if (createAccount) await this.bookings.ensureWalkinCustomer({ firstName: b.passengers[0].firstName, lastName: b.passengers[0].lastName, phone: b.contact.phone, email: b.contact.email });
      if (paymentMethod === 'cash') return { booking: await this.bookings.sellCash({ ...input, amountReceived }, u), payment: null };
      if (!input.holdToken) throw new AppError('HOLD_REQUIRED', 400, 'Sélectionnez d\'abord les sièges sur le plan');
      const booking = await this.bookings.create(input, { user: u, ip }, key, 'counter');
      const payment = await this.payments.initiate(booking.id, paymentMethod, payerPhone || b.contact.phone, key);
      return { booking, payment };
    });
  }
  @RequirePermission('canViewSeats', 'canSellWalkin', 'canViewBookings', 'canCheckTickets') @Get('trips/:id/manifest') @Api('Manifeste des passagers d\'un voyage')
  async manifest(@Param('id') id: string) {
    const map = await this.seats.seatMap(zId.parse(id));
    const passengers = await this.db.q(
      `SELECT p.id, p.seat_no, p.first_name, p.last_name, p.phone, p.gender, p.status, p.ticket_number, p.boarded_at, b.id AS booking_id, b.reference, b.channel, b.contact_phone, b.needs_attention
         FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id
        WHERE b.trip_id = $1 AND b.status IN ('confirmed','completed','no_show') AND p.status <> 'cancelled' ORDER BY p.seat_no`, [id]);
    return { ...map, passengers };
  }
  @RequirePermission('canManageRoutes') @HttpCode(200) @Post('trips/:id/cancel') @Api('Annuler un voyage (rembourse et prévient tous les passagers)')
  cancelTrip(@Param('id') id: string, @ZBody(z.strictObject({ reason: zText(300) })) b: any, @CurrentUser() u: AuthUser) { return this.bookings.cancelTrip(zId.parse(id), b.reason, u); }
  @RequirePermission('canManageRoutes', 'canManageFleet') @HttpCode(200) @Post('trips/:id/replace-vehicle') @Api('Remplacer le véhicule d\'un voyage (réaffectation des sièges)')
  replaceVehicle(@Param('id') id: string, @ZBody(z.strictObject({ vehicleId: zId })) b: any, @CurrentUser() u: AuthUser) { return this.bookings.replaceVehicle(zId.parse(id), b.vehicleId, u); }
}

@ApiTags('Administration · pilotage')
@Controller('admin')
export class ReportsController {
  constructor(private db: Db, private settings: SettingsService, private trips: TripsService) {}
  private async today() { return todayIn((await this.settings.get('locale')).timezone); }

  /** Le chiffre d'affaires est compté à la date d'encaissement, net des remboursements effectués. */
  @RequirePermission('canViewDashboard') @Get('dashboard') @Api('Indicateurs du tableau de bord')
  async dashboard(@CurrentUser() u: AuthUser) {
    const tz = (await this.settings.get('locale')).timezone;
    const today = await this.today();
    const month = today.slice(0, 8) + '01';
    const money = can(u, 'canViewRevenue');
    const rev = await this.db.one<any>(
      `SELECT coalesce(sum(amount - refunded_amount) FILTER (WHERE (succeeded_at AT TIME ZONE $1)::date = $2::date), 0)::bigint AS today_revenue,
              coalesce(sum(amount - refunded_amount) FILTER (WHERE (succeeded_at AT TIME ZONE $1)::date >= $3::date), 0)::bigint AS month_revenue,
              coalesce(sum(amount - refunded_amount) FILTER (WHERE (succeeded_at AT TIME ZONE $1)::date >= ($3::date - interval '1 month') AND (succeeded_at AT TIME ZONE $1)::date < $3::date), 0)::bigint AS prev_month_revenue,
              coalesce(sum(amount - refunded_amount), 0)::bigint AS total_revenue
         FROM payments WHERE succeeded_at IS NOT NULL`, [tz, today, month]);
    const bk = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE (created_at AT TIME ZONE $1)::date = $2::date AND status IN ('confirmed','completed','no_show'))::int AS today_bookings,
              count(*) FILTER (WHERE (created_at AT TIME ZONE $1)::date >= $3::date AND status IN ('confirmed','completed','no_show'))::int AS month_bookings,
              count(*) FILTER (WHERE (created_at AT TIME ZONE $1)::date >= ($3::date - interval '1 month') AND (created_at AT TIME ZONE $1)::date < $3::date AND status IN ('confirmed','completed','no_show'))::int AS prev_month_bookings,
              count(*) FILTER (WHERE status IN ('confirmed','completed','no_show'))::int AS total_bookings,
              count(*) FILTER (WHERE status = 'pending_payment')::int AS pending_bookings,
              count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason IN ('customer','staff','trip_cancelled') AND created_at > now() - interval '30 days')::int AS cancelled_30d,
              count(*) FILTER (WHERE status IN ('confirmed','completed','no_show','cancelled') AND created_at > now() - interval '30 days')::int AS all_30d,
              count(*) FILTER (WHERE needs_attention)::int AS needs_attention
         FROM bookings`, [tz, today, month]);
    const seats = await this.db.one<any>(
      `SELECT coalesce(sum(l.capacity), 0)::int AS total_seats,
              coalesce(sum((SELECT count(*) FROM trip_seats s WHERE s.trip_id = t.id AND s.status = 'booked')), 0)::int AS booked_seats,
              coalesce(sum((SELECT count(*) FROM trip_seats s WHERE s.trip_id = t.id AND s.status = 'held' AND s.hold_expires_at > now())), 0)::int AS pending_seats,
              count(*)::int AS trips_today
         FROM trips t JOIN seat_layouts l ON l.id = t.layout_id WHERE t.service_date = $1 AND t.status <> 'cancelled'`, [today]);
    const users = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE kind = 'customer' AND status <> 'deleted')::int AS total_users,
              count(*) FILTER (WHERE kind = 'customer' AND last_seen_at > now() - interval '30 days')::int AS active_users FROM users`);
    const refunds = await this.db.one<any>(`SELECT count(*) FILTER (WHERE status = 'manual')::int AS manual_refunds, count(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending_refunds FROM refunds`);
    const growth = (a: number, b: number) => b > 0 ? Math.round((a - b) / b * 1000) / 10 : (a > 0 ? 100 : 0);
    return {
      ...(money ? { todayRevenue: rev.todayRevenue, monthRevenue: rev.monthRevenue, totalRevenue: rev.totalRevenue, revenueGrowth: growth(rev.monthRevenue, rev.prevMonthRevenue) } : {}),
      todayBookings: bk.todayBookings, monthBookings: bk.monthBookings, totalBookings: bk.totalBookings, pendingBookings: bk.pendingBookings,
      bookingsGrowth: growth(bk.monthBookings, bk.prevMonthBookings), cancelRate: bk.all30d ? Math.round(bk.cancelled30d / bk.all30d * 1000) / 10 : 0,
      needsAttention: bk.needsAttention, manualRefunds: refunds.manualRefunds, pendingRefunds: refunds.pendingRefunds,
      totalUsers: users.totalUsers, activeUsers: users.activeUsers,
      totalSeats: seats.totalSeats, bookedSeats: seats.bookedSeats, pendingSeats: seats.pendingSeats, availableSeats: Math.max(0, seats.totalSeats - seats.bookedSeats - seats.pendingSeats),
      occupancyRate: seats.totalSeats ? Math.round(seats.bookedSeats / seats.totalSeats * 1000) / 10 : 0, tripsToday: seats.tripsToday,
    };
  }
  @RequirePermission('canViewRevenue') @Get('reports/revenue') @Api('Chiffre d\'affaires par jour, par itinéraire et par moyen de paiement')
  async revenue(@Query() q: any) {
    const tz = (await this.settings.get('locale')).timezone;
    const to = q.to ? zDate.parse(q.to) : await this.today();
    const from = q.from ? zDate.parse(q.from) : addDays(to, -29);
    if (from > to || addDays(from, 366) < to) throw new AppError('INVALID_PERIOD', 400, 'Période invalide (366 jours maximum)');
    const daily = await this.db.q(
      `SELECT d::date AS date, coalesce(sum(p.amount - p.refunded_amount), 0)::bigint AS amount, count(DISTINCT p.booking_id)::int AS bookings
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN payments p ON p.succeeded_at IS NOT NULL AND (p.succeeded_at AT TIME ZONE $1)::date = d::date
        GROUP BY d ORDER BY d`, [tz, from, to]);
    const byRoute = await this.db.q(
      `SELECT cf.name AS from_city, ct.name AS to_city, sum(p.amount - p.refunded_amount)::bigint AS revenue, count(DISTINCT b.id)::int AS bookings
         FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
         JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
        WHERE p.succeeded_at IS NOT NULL AND (p.succeeded_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY cf.name, ct.name ORDER BY revenue DESC LIMIT 50`, [tz, from, to]);
    const byMethod = await this.db.q(
      `SELECT method, sum(amount)::bigint AS collected, sum(refunded_amount)::bigint AS refunded, count(*)::int AS payments
         FROM payments WHERE succeeded_at IS NOT NULL AND (succeeded_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date GROUP BY method ORDER BY collected DESC`, [tz, from, to]);
    const byChannel = await this.db.q(
      `SELECT b.channel, sum(p.amount - p.refunded_amount)::bigint AS revenue, count(DISTINCT b.id)::int AS bookings
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE p.succeeded_at IS NOT NULL AND (p.succeeded_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date GROUP BY b.channel`, [tz, from, to]);
    return { from, to, daily, byRoute, byMethod, byChannel, total: (daily as any[]).reduce((a, d) => a + d.amount, 0) };
  }
  @RequirePermission('canViewRevenue') @Get('reports/export.csv') @Api('Export CSV des encaissements')
  async exportCsv(@Query() q: any, @Res() res: any) {
    const tz = (await this.settings.get('locale')).timezone;
    const to = q.to ? zDate.parse(q.to) : await this.today(), from = q.from ? zDate.parse(q.from) : addDays(to, -29);
    const rows = await this.db.q<any>(
      `SELECT to_char(p.succeeded_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS paid_at, b.reference, b.channel, p.method, p.amount, p.refunded_amount, p.currency,
              cf.name AS from_city, ct.name AS to_city, t.service_date, b.contact_name, b.contact_phone, b.status
         FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
         JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
        WHERE p.succeeded_at IS NOT NULL AND (p.succeeded_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date ORDER BY p.succeeded_at LIMIT 50000`, [tz, from, to]);
    // protection contre l'injection de formules dans les tableurs
    const cell = (v: any) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const head = ['Date encaissement', 'Référence', 'Canal', 'Moyen', 'Montant', 'Remboursé', 'Devise', 'Départ', 'Arrivée', 'Date voyage', 'Client', 'Téléphone', 'Statut'];
    const csv = '﻿' + [head.map(cell).join(';'), ...rows.map(r => [r.paidAt, r.reference, r.channel, r.method, r.amount, r.refundedAmount, r.currency, r.fromCity, r.toCity, r.serviceDate, r.contactName, r.contactPhone, r.status].map(cell).join(';'))].join('\r\n');
    res.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="encaissements-${from}-${to}.csv"`).send(csv);
  }
  @RequirePermission('canViewDashboard') @Get('activity') @Api('Activité récente (dernières réservations)')
  activity() { return this.db.q(`${BOOKING_LIST} ORDER BY b.created_at DESC LIMIT 15`); }

  /** Planning du chauffeur connecté (ou d'un chauffeur donné pour qui peut voir les chauffeurs). */
  @RequirePermission('canViewOwnSchedule', 'canViewDrivers') @Get('driver-schedule') @Api('Planning chauffeur')
  async driverSchedule(@Query() q: any, @CurrentUser() u: AuthUser) {
    const today = await this.today();
    const from = q.from ? zDate.parse(q.from) : today, to = q.to ? zDate.parse(q.to) : addDays(from, 13);
    let driverId: string | null = q.driverId && can(u, 'canViewDrivers') ? zId.parse(q.driverId) : null;
    if (!driverId) driverId = (await this.db.maybe<{ id: string }>('SELECT id FROM drivers WHERE user_id = $1', [u.id]))?.id ?? null;
    if (!driverId) return { driver: null, trips: [] };
    const driver = await this.db.one('SELECT id, first_name, last_name, status, license_expiry FROM drivers WHERE id = $1', [driverId]);
    const trips = await this.db.q(`${TRIP_SELECT} WHERE t.driver_id = $1 AND t.service_date BETWEEN $2 AND $3 AND t.status <> 'cancelled' ORDER BY t.departure_at`, [driverId, from, to]);
    return { driver, trips };
  }
}

@ApiTags('Administration · journal d\'audit et notifications')
@Controller('admin')
export class AuditController {
  constructor(private db: Db) {}
  @RequirePermission('canViewAudit') @Get('audit') @Api('Journal d\'audit (lecture seule)')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q);
    const params = [String(q.category || ''), q.actorId ? zId.parse(q.actorId) : null, String(q.search || '').trim().slice(0, 80), String(q.severity || '')];
    const where = `($1 = '' OR category = $1) AND ($2::uuid IS NULL OR actor_id = $2) AND ($4 = '' OR severity = $4)
      AND ($3 = '' OR action ILIKE '%'||$3||'%' OR target_name ILIKE '%'||$3||'%' OR actor_name ILIKE '%'||$3||'%' OR details ILIKE '%'||$3||'%')`;
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, params)).n;
    const items = await this.db.q(`SELECT id, actor_id, actor_public_id, actor_name, category, action, severity, target_type, target_id, target_name, details, diff, ip, created_at FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $5 OFFSET $6`, [...params, limit, offset]);
    return { items, total, page, limit };
  }
  /** Mon propre historique : chaque compte interne voit ses actions sans avoir la permission d'audit globale. */
  @RequirePermission('canViewAudit', 'canViewDashboard', 'canSellWalkin', 'canViewOwnSchedule', 'canViewBookings', 'canViewSeats') @Get('audit/mine') @Api('Mes propres actions')
  async mine(@Query() q: any, @CurrentUser() u: AuthUser) {
    const { page, limit, offset } = paging(q);
    const total = (await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1', [u.id])).n;
    return { items: await this.db.q('SELECT id, category, action, severity, target_name, details, diff, created_at FROM audit_log WHERE actor_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3', [u.id, limit, offset]), total, page, limit };
  }
  /** Recalcule toute la chaîne de hachage : une ligne modifiée ou supprimée directement en base est détectée. */
  @RequirePermission('canViewAudit') @Get('audit/verify') @Api('Vérifier l\'intégrité du journal d\'audit')
  async verify() {
    const r = await this.db.one<any>(
      `WITH c AS (SELECT a.id, a.hash, a.prev_hash, lag(a.hash) OVER (ORDER BY a.id) AS expected_prev, audit_row_hash(a.prev_hash, a) AS recomputed FROM audit_log a)
       SELECT count(*)::int AS entries, min(id) FILTER (WHERE hash <> recomputed OR prev_hash <> coalesce(expected_prev, '')) AS first_broken_id FROM c`);
    return { entries: r.entries, intact: r.firstBrokenId === null, firstBrokenId: r.firstBrokenId };
  }
  @RequirePermission('canViewSettings') @Get('notifications') @Api('Journal des e-mails et SMS')
  async notifications(@Query() q: any) {
    const { page, limit, offset } = paging(q);
    const status = String(q.status || '');
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE ($1 = '' OR status = $1)`, [status])).n;
    return { items: await this.db.q(`SELECT id, channel, recipient, template, lang, subject, body, status, attempts, last_error, created_at, sent_at FROM notifications_outbox WHERE ($1 = '' OR status = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [status, limit, offset]), total, page, limit };
  }
  @RequirePermission('canManageSettings') @HttpCode(200) @Post('notifications/:id/retry') @Api('Relancer l\'envoi d\'un message en échec')
  async retry(@Param('id') id: string) { await this.db.q(`UPDATE notifications_outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1 AND status = 'failed'`, [zId.parse(id)]); return { ok: true }; }
}

const safeUrl = z.string().trim().max(600000).refine(v => v === '' || /^(https?:\/\/|\/|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(v), 'URL ou image invalide');
const adSchema = z.strictObject({
  title: zText(120), description: z.string().trim().max(600).default(''), imageUrl: safeUrl.nullish(),
  imagePosition: z.enum(['left', 'right', 'top', 'background']).nullish(), imageSize: z.enum(['small', 'medium', 'large']).nullish(),
  linkUrl: z.string().trim().max(500).refine(v => v === '' || /^(https?:\/\/|\/|tel:|mailto:)/i.test(v), 'Lien invalide').nullish(), linkLabel: z.string().trim().max(60).nullish(),
  bgColor: zColor.default('#1d4ed8'), textColor: zColor.default('#ffffff'),
  position: z.enum(['banner_top', 'banner_bottom', 'sidebar', 'between_results', 'notification']).default('banner_top'),
  pages: z.array(z.string().max(60)).max(20).default([]), status: z.enum(['active', 'paused']).default('active'),
  startDate: zDate, endDate: zDate, priority: z.number().int().min(1).max(10).default(5),
  displayType: z.enum(['banner', 'notification']).default('banner'), notifDuration: z.number().int().min(1).max(120).default(8),
  notifPosition: z.enum(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']).nullish(),
  carouselInterval: z.number().int().min(0).max(120).default(6),
});
const AD_SELECT = `SELECT a.*, coalesce(s.views, 0)::int AS views, coalesce(s.clicks, 0)::int AS clicks,
    CASE WHEN a.status = 'paused' THEN 'paused' WHEN a.end_date < current_date THEN 'expired' WHEN a.start_date > current_date THEN 'scheduled' ELSE 'active' END AS effective_status
  FROM ads a LEFT JOIN LATERAL (SELECT sum(views) AS views, sum(clicks) AS clicks FROM ad_stats_daily d WHERE d.ad_id = a.id) s ON true`;

@ApiTags('Publicités')
@Controller()
export class AdsController {
  constructor(private db: Db, private audit: Audit) {}
  @Public() @Get('ads') @Api('Publicités actives pour une page du site')
  active(@Query('page') page: string) {
    return this.db.q(
      `SELECT id, title, description, image_url, image_position, image_size, link_url, link_label, bg_color, text_color, position, pages, priority, display_type, notif_duration, notif_position, carousel_interval
         FROM ads WHERE status = 'active' AND current_date BETWEEN start_date AND end_date AND (cardinality(pages) = 0 OR $1 = ANY(pages)) ORDER BY priority DESC, created_at LIMIT 30`, [String(page || '/').slice(0, 60)]);
  }
  @Public() @RateLimit('adstat', 300, 60) @HttpCode(204) @Post('ads/:id/view') @Api('Compter un affichage')
  view(@Param('id') id: string) { return this.stat(id, 'views'); }
  @Public() @RateLimit('adstat', 300, 60) @HttpCode(204) @Post('ads/:id/click') @Api('Compter un clic')
  click(@Param('id') id: string) { return this.stat(id, 'clicks'); }
  private async stat(id: string, col: 'views' | 'clicks') {
    await this.db.q(`INSERT INTO ad_stats_daily (ad_id, day, ${col}) SELECT id, current_date, 1 FROM ads WHERE id = $1 ON CONFLICT (ad_id, day) DO UPDATE SET ${col} = ad_stats_daily.${col} + 1`, [zId.parse(id)]);
  }
  @RequirePermission('canManageAds') @Get('admin/ads') @Api('Toutes les publicités avec statistiques')
  async list(@Query() q: any) {
    const { page, limit, offset } = paging(q);
    const total = (await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM ads')).n;
    return { items: await this.db.q(`${AD_SELECT} ORDER BY a.priority DESC, a.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]), total, page, limit };
  }
  @RequirePermission('canManageAds') @Post('admin/ads') @Api('Créer une publicité', adSchema)
  async create(@ZBody(adSchema) b: any, @CurrentUser() u: AuthUser) {
    if (b.endDate < b.startDate) throw new AppError('INVALID_PERIOD', 400, 'La date de fin précède la date de début');
    const a = await this.db.insert<any>('ads', b);
    await this.audit.log({ actor: u, category: 'ads', action: 'Publicité créée', severity: 'success', targetType: 'ad', targetId: a.id, targetName: a.title });
    return this.db.one(`${AD_SELECT} WHERE a.id = $1`, [a.id]);
  }
  @RequirePermission('canManageAds') @Patch('admin/ads/:id') @Api('Modifier une publicité')
  async update(@Param('id') id: string, @ZPatch(adSchema) b: any, @CurrentUser() u: AuthUser) {
    const before = await this.db.one<any>('SELECT * FROM ads WHERE id = $1', [zId.parse(id)]);
    await this.db.update('ads', id, { ...b, updatedAt: new Date() });
    await this.audit.log({ actor: u, category: 'ads', action: 'Publicité modifiée', targetType: 'ad', targetId: id, targetName: before.title, diff: this.audit.diff({ ...before, imageUrl: before.imageUrl ? '[image]' : '' }, { ...b, ...(b.imageUrl !== undefined ? { imageUrl: b.imageUrl ? '[image]' : '' } : {}) }) });
    return this.db.one(`${AD_SELECT} WHERE a.id = $1`, [id]);
  }
  @RequirePermission('canManageAds') @HttpCode(204) @Delete('admin/ads/:id') @Api('Supprimer une publicité')
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const a = await this.db.one<any>('SELECT title FROM ads WHERE id = $1', [zId.parse(id)]);
    await this.db.q('DELETE FROM ads WHERE id = $1', [id]);
    await this.audit.log({ actor: u, category: 'ads', action: 'Publicité supprimée', severity: 'danger', targetType: 'ad', targetId: id, targetName: a.title });
  }
}
