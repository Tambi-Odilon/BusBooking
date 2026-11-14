/* Outils communs aux tests d'intégration et de concurrence : une vraie API NestJS, une vraie base PostgreSQL, un vrai Redis. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/bb_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/1';
process.env.JOBS_DISABLED = 'true';            // les tâches planifiées sont déclenchées à la main par les tests
process.env.RATE_LIMIT_FACTOR = '100000';      // la limitation de débit a son propre test
process.env.SIM_AUTO = 'false';                // le simulateur de paiement n'avance que quand le test le décide
process.env.SIM_DELAY_MS = '0';
process.env.SIM_LATE_MS = '0';
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '30';
process.env.UPLOAD_DIR = '/tmp/bb-test-uploads';
process.env.PUBLIC_URL = 'http://localhost:4200';

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DateTime } from 'luxon';
import { createApp } from '../src/bootstrap';
import { Db } from '../src/common/db';
import { RateLimiter, RedisService } from '../src/common/redis';
import { SettingsService } from '../src/modules/settings/settings.service';
import { SeatsService } from '../src/modules/booking/seats.service';
import { BookingsService } from '../src/modules/booking/bookings.service';
import { PaymentsService, webhookSignature } from '../src/modules/payments/payments.service';
import { SimulatorProvider } from '../src/modules/payments/providers';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { TripsService } from '../src/modules/transport/trips.service';
import { Scheduler } from '../src/modules/jobs/scheduler';

export const ZONE = 'Indian/Antananarivo';
export const ADMIN = { firstName: 'Ada', lastName: 'Admin', email: 'admin@test.local', password: 'Admin-Test-2026' };
export const uuid = () => randomUUID();
export const key = () => 'k-' + randomUUID();
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Date locale (fuseau de la société) à J+n. */
export const day = (n: number) => DateTime.now().setZone(ZONE).plus({ days: n }).toISODate()!;

export interface Res { status: number; body: any; headers: Record<string, any>; raw: Buffer; cookies: Record<string, string> }
export interface Ctx {
  app: NestFastifyApplication; db: Db; settings: SettingsService; seats: SeatsService; bookings: BookingsService; payments: PaymentsService;
  notifications: NotificationsService; trips: TripsService; scheduler: Scheduler; limiter: RateLimiter; redis: RedisService;
  api(method: string, url: string, opts?: { body?: any; token?: string; headers?: Record<string, string>; cookies?: Record<string, string> }): Promise<Res>;
  close(): Promise<void>;
}

/** Démarre l'API sur un schéma vide (migrations rejouées) : chaque fichier de test est indépendant. */
export async function boot(): Promise<Ctx> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  const app = await createApp({ swagger: false });   // la documentation OpenAPI est vérifiée sur le serveur réel (test/openapi-check.js)
  await app.init();
  const fastify: any = app.getHttpAdapter().getInstance();
  await fastify.ready();
  const redis = app.get(RedisService);
  await redis.client.flushdb();
  const api: Ctx['api'] = async (method, url, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const r = await fastify.inject({ method, url: url.startsWith('/health') || url === '/metrics' ? url : '/api/v1' + url, payload: opts.body, headers, cookies: opts.cookies });
    let body: any = null;
    try { body = r.payload ? JSON.parse(r.payload) : null; } catch { body = r.payload; }
    const cookies: Record<string, string> = {};
    for (const c of r.cookies || []) cookies[c.name] = c.value;
    return { status: r.statusCode, body, headers: r.headers, raw: r.rawPayload, cookies };
  };
  return {
    app, api, db: app.get(Db), settings: app.get(SettingsService), seats: app.get(SeatsService), bookings: app.get(BookingsService),
    payments: app.get(PaymentsService), notifications: app.get(NotificationsService), trips: app.get(TripsService), scheduler: app.get(Scheduler),
    limiter: app.get(RateLimiter), redis,
    close: async () => { await app.close(); },
  };
}

/** Termine l'assistant de configuration avec le strict minimum et renvoie le jeton de l'administrateur. */
export async function setup(c: Ctx, extra: any = {}): Promise<string> {
  const r = await c.api('POST', '/setup/complete', { body: {
    identity: { name: 'Trans Test' }, admin: ADMIN, seed: 'empty',
    payments: [{ code: 'mvola', enabled: true, mode: 'test' }, { code: 'orange_money', enabled: true, mode: 'test' }], ...extra } });
  if (r.status !== 200) throw new Error('setup: ' + JSON.stringify(r.body));
  return (await login(c, ADMIN.email, ADMIN.password, 'staff')).token;
}
export async function login(c: Ctx, email: string, password: string, scope: 'customer' | 'staff' = 'customer') {
  const r = await c.api('POST', '/auth/login', { body: { email, password, scope } });
  if (r.status !== 200) throw new Error('login: ' + JSON.stringify(r.body));
  return { token: r.body.accessToken as string, user: r.body.user, cookies: r.cookies, res: r };
}
export async function staff(c: Ctx, admin: string, role: string, email = `${role}-${Date.now()}@test.local`) {
  const password = 'Staff-Test-2026';
  const r = await c.api('POST', '/admin/staff', { token: admin, body: { email, firstName: 'Sam', lastName: role, role, password } });
  if (r.status >= 300) throw new Error('staff: ' + JSON.stringify(r.body));
  return { ...(await login(c, email, password, 'staff')), id: r.body.id as string, email, password };
}
export async function customer(c: Ctx, email = `client-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`, phone = '0341234567') {
  const password = 'Client-Test-2026';
  const r = await c.api('POST', '/auth/register', { body: { email, password, firstName: 'Clara', lastName: 'Client', phone } });
  if (r.status >= 300) throw new Error('register: ' + JSON.stringify(r.body));
  return { token: r.body.accessToken as string, user: r.body.user, email, password, cookies: r.cookies };
}

let plate = 0;
export async function vehicle(c: Ctx, admin: string, layout: 'bus' | 'minibus16' | 'minibus10' = 'minibus16', name = 'Véhicule') {
  const layouts = (await c.api('GET', '/admin/seat-layouts', { token: admin })).body;
  const l = layouts.find((x: any) => x.code === layout);
  const r = await c.api('POST', '/admin/vehicles', { token: admin, body: { name: `${name} ${++plate}`, layoutId: l.id, plateNumber: `T-${Date.now() % 100000}-${plate}` } });
  if (r.status >= 300) throw new Error('vehicle: ' + JSON.stringify(r.body));
  return r.body;
}
export async function route(c: Ctx, admin: string, from = 'Antananarivo', to = 'Antsirabe', basePrice = 15000, durationMin = 180) {
  const r = await c.api('POST', '/admin/routes', { token: admin, body: { fromCity: from, toCity: to, durationMin, basePrice } });
  if (r.status >= 300) throw new Error('route: ' + JSON.stringify(r.body));
  return r.body;
}
export async function trip(c: Ctx, admin: string, o: { routeId: string; vehicleId: string; date?: string; time?: string; price?: number; driverId?: string }) {
  const r = await c.api('POST', '/admin/trips', { token: admin, body: { routeId: o.routeId, vehicleId: o.vehicleId, date: o.date ?? day(2), departureTime: o.time ?? '08:00', price: o.price, driverId: o.driverId } });
  if (r.status >= 300) throw new Error('trip: ' + JSON.stringify(r.body));
  return r.body;
}
/** Un itinéraire, un véhicule et un départ prêts à vendre. */
export async function world(c: Ctx, admin: string, o: { layout?: 'bus' | 'minibus16' | 'minibus10'; from?: string; to?: string; date?: string; time?: string; price?: number } = {}) {
  const v = await vehicle(c, admin, o.layout ?? 'minibus16');
  const r = await route(c, admin, o.from ?? 'Antananarivo', o.to ?? 'Antsirabe', o.price ?? 15000);
  const t = await trip(c, admin, { routeId: r.id, vehicleId: v.id, date: o.date, time: o.time });
  return { vehicle: v, route: r, trip: t, tripId: t.id as string };
}

export const pax = (seatNo: string, i = 0) => ({ seatNo, firstName: 'Passager' + i, lastName: 'Test', phone: '0340000100', gender: 'M' as const, category: 'adult' as const });
export const CONTACT = { name: 'Clara Client', phone: '0341234567', email: 'clara@test.local' };

export async function hold(c: Ctx, tripId: string, seats: string[], holdToken?: string, token?: string) {
  return c.api('POST', `/trips/${tripId}/holds`, { token, body: { seats, holdToken } });
}
export async function book(c: Ctx, tripId: string, holdToken: string, seats: string[], o: { token?: string; idem?: string; contact?: any } = {}) {
  return c.api('POST', '/bookings', { token: o.token, headers: { 'idempotency-key': o.idem ?? key() },
    body: { tripId, holdToken, passengers: seats.map(pax), contact: o.contact ?? CONTACT } });
}
export async function pay(c: Ctx, booking: any, o: { method?: string; phone?: string; idem?: string; token?: string } = {}) {
  return c.api('POST', '/payments', { token: o.token, headers: { 'idempotency-key': o.idem ?? key(), 'x-booking-token': booking.accessToken },
    body: { reference: booking.reference, method: o.method ?? 'mvola', payerPhone: o.phone ?? '0340000111' } });
}
/** Joue le rôle de l'opérateur : le paiement simulé est revérifié maintenant. Renvoie le résultat de la machine à états. */
export const settle = (c: Ctx, paymentId: string) => c.payments.checkOne(paymentId);
/** Parcours complet d'un client : sièges → réservation → paiement confirmé. */
export async function purchase(c: Ctx, tripId: string, seats: string[], o: { token?: string; contact?: any } = {}) {
  const h = await hold(c, tripId, seats, undefined, o.token);
  if (h.status !== 200) throw new Error('hold: ' + JSON.stringify(h.body));
  const b = await book(c, tripId, h.body.token, seats, o);
  if (b.status >= 300) throw new Error('book: ' + JSON.stringify(b.body));
  const p = await pay(c, b.body, { token: o.token });
  if (p.status >= 300) throw new Error('pay: ' + JSON.stringify(p.body));
  const result = await settle(c, p.body.id);
  return { hold: h.body, booking: b.body, payment: p.body, result };
}
export async function getBooking(c: Ctx, b: any, token?: string) {
  return (await c.api('GET', `/bookings/${b.reference}`, { token, headers: { 'x-booking-token': b.accessToken } })).body;
}
/** Callback signé du simulateur (succès, échec, doublon, retard, désordre). */
export async function simWebhook(c: Ctx, payment: any, status: 'succeeded' | 'failed' | 'pending', eventId = uuid()) {
  const p = await c.db.one<any>('SELECT * FROM payments WHERE id = $1', [payment.id]);
  return c.api('POST', `/payments/webhooks/${p.method}/${p.id}/${webhookSignature(p.method, p.id)}`, {
    body: { providerRef: p.providerRef, status, eventId }, headers: { 'x-sim-signature': SimulatorProvider.sign(p.providerRef, status, eventId) } });
}
export const seatRows = (c: Ctx, tripId: string) => c.db.q<any>('SELECT seat_no, status, booking_id, hold_token FROM trip_seats WHERE trip_id = $1 ORDER BY seat_no', [tripId]);
/** Invariant central : pour un voyage, aucun siège n'appartient à deux réservations confirmées. */
export async function assertNoDoubleSale(c: Ctx, tripId: string) {
  const dup = await c.db.q<any>(
    `SELECT p.seat_no, count(*)::int AS n FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id
      WHERE b.trip_id = $1 AND b.status IN ('confirmed','completed') AND p.status IN ('active','boarded') GROUP BY p.seat_no HAVING count(*) > 1`, [tripId]);
  if (dup.length) throw new Error('DOUBLE VENTE : ' + JSON.stringify(dup));
  const orphan = await c.db.q<any>(
    `SELECT p.seat_no FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id
      WHERE b.trip_id = $1 AND b.status = 'confirmed' AND p.status IN ('active','boarded') AND p.seat_no <> 'N/A'
        AND NOT EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id = b.trip_id AND s.seat_no = p.seat_no AND s.booking_id = b.id AND s.status = 'booked')`, [tripId]);
  if (orphan.length) throw new Error('Billet confirmé sans siège attribué : ' + JSON.stringify(orphan));
}
