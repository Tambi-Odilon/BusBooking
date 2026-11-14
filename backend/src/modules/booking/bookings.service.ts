import { Injectable } from '@nestjs/common';
import { Db, Queryable, Tx } from '../../common/db';
import { AppError } from '../../common/errors';
import { AuthUser, can } from '../../common/auth';
import { Audit } from '../../common/audit';
import { EventBus } from '../../common/events';
import { hmac, randomCode, safeEqual } from '../../common/crypto';
import { env } from '../../common/env';
import { localParts } from '../../common/time';
import { normalizePhone } from '../../common/zod';
import { SettingsService, derivePrefix } from '../settings/settings.service';
import { layoutSeats } from '../settings/schemas';
import { TripsService } from '../transport/trips.service';
import { Outbox } from '../notifications/outbox';
import { RefundsService } from '../payments/refunds.service';
import { SeatsService } from './seats.service';
import { newPublicId } from '../auth/auth.service';

export interface PassengerInput { seatNo: string; firstName: string; lastName: string; phone?: string; gender?: string; category?: 'adult' | 'child' }
export interface CreateBookingInput {
  tripId: string; holdToken: string; passengers: PassengerInput[];
  contact: { name: string; phone: string; email?: string | null }; lang?: string;
}
export type Actor = { user: AuthUser | null; ip?: string };
/** Réservations qu'un paiement tardif peut encore « réveiller » si les sièges sont toujours libres. */
const REVIVABLE = ['abandoned', 'replaced', 'payment_timeout'];

/** Jeton d'accès d'une réservation pour les invités : dérivé, donc régénérable (lien dans l'e-mail, recherche par référence + téléphone). */
export const bookingAccessToken = (bookingId: string) => hmac('booking-access:' + bookingId).slice(0, 32);

@Injectable()
export class BookingsService {
  constructor(private db: Db, private settings: SettingsService, private trips: TripsService, private seats: SeatsService,
    private refunds: RefundsService, private outbox: Outbox, private bus: EventBus, private audit: Audit) {}

  // ── Tarification (toujours côté serveur) ───────────────────────────────────
  async price(tripPrice: number, passengers: Array<{ category?: string }>) {
    const b = await this.settings.get('booking');
    const legal = await this.settings.get('legal');
    const prices = passengers.map(p => p.category === 'child' && b.child.enabled ? Math.round(tripPrice * (100 - b.child.discountPercent) / 100) : tripPrice);
    const subtotal = prices.reduce((a, x) => a + x, 0);
    const serviceFee = b.serviceFeeMode === 'per_seat' ? b.serviceFee * passengers.length : b.serviceFee;
    const base = subtotal + serviceFee;
    let taxAmount = 0, total = base;
    if (legal.taxEnabled && legal.taxRatePercent > 0) {
      if (legal.taxIncluded) taxAmount = Math.round(base * legal.taxRatePercent / (100 + legal.taxRatePercent));
      else { taxAmount = Math.round(base * legal.taxRatePercent / 100); total = base + taxAmount; }
    }
    return { prices, subtotal, serviceFee, taxAmount, total };
  }
  private async newReference(t: Queryable): Promise<string> {
    const id = await this.settings.get('identity');
    const prefix = id.referencePrefix || derivePrefix(id.name);
    for (let i = 0; i < 5; i++) {
      const ref = `${prefix}-${randomCode(7)}`;
      if (!(await t.maybe('SELECT 1 FROM bookings WHERE reference = $1', [ref]))) return ref;
    }
    throw new AppError('REFERENCE_GENERATION_FAILED', 500);
  }
  /** Rattache la réservation à un compte client existant (même e-mail ou même téléphone), sans jamais en créer un implicitement. */
  private async findCustomer(t: Queryable, contact: { phone: string; email?: string | null }): Promise<string | null> {
    const u = await t.maybe<{ id: string }>(
      `SELECT id FROM users WHERE kind = 'customer' AND status = 'active' AND ((email IS NOT NULL AND email = $1) OR (phone IS NOT NULL AND phone = $2)) ORDER BY (email = $1) DESC NULLS LAST LIMIT 1`,
      [contact.email || null, contact.phone]);
    return u?.id ?? null;
  }

  // ── Création (site web, ou guichet avec paiement mobile) ───────────────────
  async create(d: CreateBookingInput, actor: Actor, idempotencyKey: string | null, channel: 'web' | 'counter' = 'web'): Promise<any> {
    const b = await this.settings.get('booking');
    const locale = await this.settings.get('locale');
    const staff = actor.user?.kind === 'staff';
    if (!actor.user && !b.allowGuestCheckout) throw new AppError('LOGIN_REQUIRED', 401, 'Un compte est nécessaire pour réserver');
    const contact = { ...d.contact, phone: normalizePhone(d.contact.phone) };
    const bookingId = await this.db.tx(async t => {
      const hold = await t.maybe<any>(`SELECT * FROM seat_holds WHERE token = $1 AND trip_id = $2 AND expires_at > now() FOR UPDATE`, [d.holdToken, d.tripId]);
      if (!hold) throw new AppError('HOLD_EXPIRED', 409, 'Votre sélection de sièges a expiré, veuillez recommencer');
      const held = await t.q<any>(`SELECT seat_no, booking_id FROM trip_seats WHERE trip_id = $1 AND hold_token = $2 AND status = 'held' AND hold_expires_at > now() ORDER BY seat_no FOR UPDATE`, [d.tripId, d.holdToken]);
      const want = d.passengers.map(p => p.seatNo).sort();
      if (new Set(want).size !== want.length || held.length !== want.length || held.some((h, i) => h.seatNo !== want[i]))
        throw new AppError('HOLD_MISMATCH', 409, 'Les passagers ne correspondent pas aux sièges sélectionnés');
      const trip = await this.trips.tripById(d.tripId, t);
      await this.seats.assertSellable(trip, staff);

      // l'utilisateur est revenu en arrière et a modifié les passagers : l'ancienne réservation en attente est remplacée
      const previous = [...new Set(held.map(h => h.bookingId).filter(Boolean))];
      for (const id of previous) {
        if (await t.maybe(`SELECT 1 FROM payments WHERE booking_id = $1 AND status IN ('initiated','pending')`, [id]))
          throw new AppError('PAYMENT_IN_PROGRESS', 409, 'Un paiement est déjà en cours pour cette réservation');
        await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'replaced', cancelled_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [id]);
      }
      const p = await this.price(trip.price, d.passengers);
      const customerId = actor.user?.kind === 'customer' ? actor.user.id : await this.findCustomer(t, contact);
      const booking = await t.insert<any>('bookings', {
        reference: await this.newReference(t), tripId: d.tripId, customerId, channel, soldBy: staff ? actor.user!.id : null,
        subtotal: p.subtotal, serviceFee: p.serviceFee, taxAmount: p.taxAmount, total: p.total, currency: locale.currencyCode,
        contactName: contact.name, contactPhone: contact.phone, contactEmail: contact.email || null, lang: d.lang || locale.defaultLang,
        accessTokenHash: '-', idempotencyKey, expiresAt: hold.expiresAt,
      });
      for (let i = 0; i < d.passengers.length; i++) {
        const x = d.passengers[i];
        await t.insert('booking_passengers', { bookingId: booking.id, seatNo: x.seatNo, firstName: x.firstName, lastName: x.lastName,
          phone: x.phone ? normalizePhone(x.phone) : '', gender: x.gender ?? '', category: x.category ?? 'adult', price: p.prices[i] });
      }
      await t.q(`UPDATE trip_seats SET booking_id = $3, updated_at = now() WHERE trip_id = $1 AND hold_token = $2 AND status = 'held'`, [d.tripId, d.holdToken, booking.id]);
      t.afterCommit(() => this.bus.emit('staff', 'booking.created', { id: booking.id, reference: booking.reference, status: 'pending_payment', tripId: d.tripId }));
      return booking.id as string;
    });
    return this.view(bookingId, { withToken: true });
  }

  // ── Lecture ────────────────────────────────────────────────────────────────
  async view(bookingId: string, opts: { withToken?: boolean } = {}, q: Queryable = this.db) {
    const b = await q.maybe<any>('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (!b) throw new AppError('BOOKING_NOT_FOUND', 404, 'Réservation introuvable');
    const settings = await this.settings.get('booking');
    const locale = await this.settings.get('locale');
    const trip = await this.trips.tripById(b.tripId, q);
    const passengers = await q.q<any>('SELECT id, seat_no, first_name, last_name, phone, gender, category, price, status, ticket_number, boarded_at FROM booking_passengers WHERE booking_id = $1 ORDER BY seat_no', [bookingId]);
    const pay = await q.one<any>(
      `SELECT coalesce(sum(amount) FILTER (WHERE status IN ('succeeded','refund_pending','partially_refunded','refunded')), 0)::bigint AS paid,
              coalesce(sum(refunded_amount), 0)::bigint AS refunded,
              bool_or(status IN ('initiated','pending')) AS pending,
              (array_agg(method ORDER BY created_at DESC))[1] AS method, (array_agg(id ORDER BY created_at DESC))[1] AS last_id,
              (array_agg(status ORDER BY created_at DESC))[1] AS last_status
         FROM payments WHERE booking_id = $1`, [bookingId]);
    const refundPending = (await q.one<{ s: number }>(`SELECT coalesce(sum(amount),0)::bigint AS s FROM refunds WHERE booking_id = $1 AND status IN ('pending','processing','manual')`, [bookingId])).s;
    const dep = new Date(trip.departureAt).getTime();
    const cancelDeadline = new Date(dep - settings.cancellation.deadlineHours * 3600000);
    const changeDeadline = new Date(dep - settings.change.deadlineHours * 3600000);
    const active = passengers.filter(p => p.status !== 'cancelled');
    return {
      id: b.id, reference: b.reference, status: b.status, channel: b.channel, cancelReason: b.cancelReason, needsAttention: b.needsAttention, attentionNote: b.attentionNote,
      createdAt: b.createdAt, expiresAt: b.status === 'pending_payment' ? b.expiresAt : null, confirmedAt: b.confirmedAt, cancelledAt: b.cancelledAt,
      subtotal: b.subtotal, serviceFee: b.serviceFee, taxAmount: b.taxAmount, total: b.total, currency: b.currency, lang: b.lang,
      contact: { name: b.contactName, phone: b.contactPhone, email: b.contactEmail }, customerId: b.customerId, soldBy: b.soldBy,
      trip: this.seats.slot(trip, locale.timezone), tripStatus: trip.status, plateNumber: trip.plateNumber,
      passengers, seats: active.map(p => p.seatNo),
      payment: {
        status: pay.paid > 0 ? (pay.refunded >= pay.paid ? 'refunded' : pay.refunded > 0 ? 'partially_refunded' : refundPending > 0 ? 'refund_pending' : 'paid') : pay.pending ? 'pending' : 'unpaid',
        method: pay.method, paidAmount: pay.paid, refundedAmount: pay.refunded, refundPendingAmount: refundPending, lastPaymentId: pay.lastId, lastPaymentStatus: pay.lastStatus,
      },
      canCancel: b.status === 'confirmed' && settings.cancellation.enabled && Date.now() <= cancelDeadline.getTime(),
      canChange: b.status === 'confirmed' && settings.change.enabled && Date.now() <= changeDeadline.getTime(),
      cancelDeadline, refundPercent: settings.cancellation.refundPercent,
      ...(opts.withToken ? { accessToken: bookingAccessToken(b.id) } : {}),
    };
  }
  /** Vérifie le droit de lecture : personnel habilité, client propriétaire, ou invité muni du jeton. Sinon 404 (pas d'énumération). */
  async authorize(reference: string, actor: Actor, token?: string): Promise<any> {
    const b = await this.db.maybe<any>('SELECT id, customer_id FROM bookings WHERE reference = $1', [String(reference || '').toUpperCase().slice(0, 40)]);
    const nope = new AppError('BOOKING_NOT_FOUND', 404, 'Réservation introuvable');
    if (!b) throw nope;
    const u = actor.user;
    if (u?.kind === 'staff' && (can(u, 'canViewBookings') || can(u, 'canManageBookings') || can(u, 'canSellWalkin') || can(u, 'canCheckTickets'))) return b;
    if (u?.kind === 'customer' && b.customerId === u.id) return b;
    if (token && safeEqual(token, bookingAccessToken(b.id))) return b;
    throw nope;
  }
  /** « Retrouver mon billet » sans compte : référence + téléphone de contact. */
  async lookup(reference: string, phone: string) {
    const b = await this.db.maybe<any>('SELECT id, contact_phone FROM bookings WHERE reference = $1', [reference.toUpperCase()]);
    const digits = (s: string) => s.replace(/\D/g, '').slice(-8);
    if (!b || !b.contactPhone || digits(b.contactPhone) !== digits(phone) || digits(phone).length < 6) throw new AppError('BOOKING_NOT_FOUND', 404, 'Aucune réservation ne correspond');
    return this.view(b.id, { withToken: true });
  }
  async mine(user: AuthUser, page: number, limit: number, offset: number) {
    const total = (await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1', [user.id])).n;
    const ids = await this.db.q<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, limit, offset]);
    return { items: await Promise.all(ids.map(r => this.view(r.id, { withToken: true }))), total, page, limit };
  }

  // ── Confirmation après paiement ────────────────────────────────────────────
  /**
   * Appelé dans la transaction qui valide un paiement, la réservation étant verrouillée (FOR UPDATE).
   * Règle d'or : on ne confirme que si TOUS les sièges peuvent être attribués ; sinon rien n'est attribué et l'appelant rembourse.
   */
  async confirmPaid(t: Tx, booking: any, holdToken: string | null = null): Promise<{ ok: true; already?: boolean } | { ok: false; reason: string }> {
    if (booking.status === 'confirmed') return { ok: true, already: true };
    const revivable = booking.status === 'pending_payment' || booking.status === 'expired' || (booking.status === 'cancelled' && REVIVABLE.includes(booking.cancelReason));
    if (!revivable) return { ok: false, reason: booking.cancelReason === 'trip_cancelled' ? 'trip_cancelled' : 'booking_cancelled' };
    const trip = await t.one<any>(`SELECT t.status, t.departure_at, l.rows FROM trips t JOIN seat_layouts l ON l.id = t.layout_id WHERE t.id = $1 FOR SHARE OF t`, [booking.tripId]);
    if (trip.status === 'cancelled') return { ok: false, reason: 'trip_cancelled' };
    if (new Date(trip.departureAt).getTime() < Date.now() && booking.channel !== 'counter') return { ok: false, reason: 'trip_departed' };
    const pax = await t.q<any>(`SELECT id, seat_no FROM booking_passengers WHERE booking_id = $1 AND status = 'active' ORDER BY seat_no`, [booking.id]);
    const wanted = pax.map(p => p.seatNo);
    const valid = new Set(layoutSeats(trip.rows));
    if (wanted.some(s => !valid.has(s))) return { ok: false, reason: 'seat_lost' };   // véhicule remplacé entre-temps
    try {
      await t.savepoint(async () => {
        const got = await this.seats.acquireBooked(t, booking.tripId, wanted, booking.id, holdToken);
        if (got.length !== wanted.length) throw new AppError('SEAT_LOST', 409);
      });
    } catch (e) { if (e instanceof AppError && e.code === 'SEAT_LOST') return { ok: false, reason: 'seat_lost' }; throw e; }

    for (let i = 0; i < pax.length; i++)
      await t.q('UPDATE booking_passengers SET ticket_number = coalesce(ticket_number, $2) WHERE id = $1', [pax[i].id, `${booking.reference}-${i + 1}`]);
    await t.q(`UPDATE bookings SET status = 'confirmed', cancel_reason = NULL, cancelled_at = NULL, confirmed_at = now(), expires_at = NULL, updated_at = now() WHERE id = $1`, [booking.id]);
    await this.notifyBooking(t, booking, 'booking_confirmed', true);
    t.afterCommit(() => {
      this.bus.emit(`trip:${booking.tripId}`, 'seat.booked', { tripId: booking.tripId, seats: wanted });
      this.emitBooking(booking, 'booking.confirmed', 'confirmed');
    });
    return { ok: true };
  }
  emitBooking(b: any, event: string, status: string, extra: any = {}) {
    const payload = { id: b.id, reference: b.reference, status, tripId: b.tripId, ...extra };
    this.bus.emit(`booking:${b.id}`, event, payload);
    if (b.customerId) this.bus.emit(`user:${b.customerId}`, event, payload);
    this.bus.emit('staff', 'booking.updated', payload);
  }
  /** Met en file l'e-mail (et le SMS si activé) lié à une réservation, dans la transaction en cours. */
  async notifyBooking(t: Queryable, b: any, template: string, attachTicket = false, extraVars: Record<string, any> = {}) {
    const n = await this.settings.get('notifications');
    const locale = await this.settings.get('locale');
    const trip = await this.trips.tripById(b.tripId, t);
    const dep = localParts(new Date(trip.departureAt), locale.timezone);
    const seats = (await t.q<{ seatNo: string }>(`SELECT seat_no FROM booking_passengers WHERE booking_id = $1 AND status <> 'cancelled' ORDER BY seat_no`, [b.id])).map(r => r.seatNo);
    const vars = {
      ticket_number: b.reference, reference: b.reference, customer_name: b.contactName, from: trip.fromCity, to: trip.toCity,
      date: dep.date, departure_time: dep.time, seats: seats.join(', '), total: b.total, vehicle: trip.vehicleName,
      booking_url: `${env().publicUrl}/booking/${b.reference}?t=${bookingAccessToken(b.id)}`, ...extraVars,
    };
    if (b.contactEmail && n.sendTicketByEmail)
      await this.outbox.enqueue({ channel: 'email', to: b.contactEmail, template, lang: b.lang, vars, attachBookingId: attachTicket ? b.id : undefined }, t);
    if (b.contactPhone && n.sms.enabled && (n.sendTicketBySms || template !== 'booking_confirmed'))
      await this.outbox.enqueue({ channel: 'sms', to: b.contactPhone, template, lang: b.lang, vars }, t);
  }

  // ── Vente au guichet en espèces : réservation + paiement + billets dans UNE transaction ──
  async sellCash(d: Omit<CreateBookingInput, 'holdToken'> & { holdToken?: string | null; amountReceived?: number }, staff: AuthUser): Promise<any> {
    const locale = await this.settings.get('locale');
    const contact = { ...d.contact, phone: normalizePhone(d.contact.phone) };
    const bookingId = await this.db.tx(async t => {
      const trip = await this.trips.tripById(d.tripId, t);
      await this.seats.assertSellable(trip, true);
      const seats = d.passengers.map(p => p.seatNo);
      if (new Set(seats).size !== seats.length) throw new AppError('DUPLICATE_SEAT', 400, 'Un siège est attribué à deux passagers');
      const valid = new Set(layoutSeats(trip.layoutRows));
      if (seats.some(s => !valid.has(s))) throw new AppError('SEAT_UNKNOWN', 400, 'Siège inexistant dans ce véhicule');
      const p = await this.price(trip.price, d.passengers);
      if (d.amountReceived !== undefined && d.amountReceived < p.total) throw new AppError('AMOUNT_INSUFFICIENT', 400, 'Le montant reçu est inférieur au total', { total: p.total });
      const booking = await t.insert<any>('bookings', {
        reference: await this.newReference(t), tripId: d.tripId, customerId: await this.findCustomer(t, contact), channel: 'counter', soldBy: staff.id,
        subtotal: p.subtotal, serviceFee: p.serviceFee, taxAmount: p.taxAmount, total: p.total, currency: locale.currencyCode,
        contactName: contact.name, contactPhone: contact.phone, contactEmail: contact.email || null, lang: d.lang || locale.defaultLang, accessTokenHash: '-',
      });
      for (let i = 0; i < d.passengers.length; i++) {
        const x = d.passengers[i];
        await t.insert('booking_passengers', { bookingId: booking.id, seatNo: x.seatNo, firstName: x.firstName, lastName: x.lastName,
          phone: x.phone ? normalizePhone(x.phone) : '', gender: x.gender ?? '', category: x.category ?? 'adult', price: p.prices[i] });
      }
      const r = await this.confirmPaid(t, booking, d.holdToken ?? null);
      if (!r.ok) throw new AppError('SEAT_TAKEN', 409, 'Un des sièges vient d\'être vendu, actualisez le plan', { reason: r.reason });
      await t.q(`INSERT INTO payments (booking_id, method, mode, amount, currency, status, received_by, succeeded_at) VALUES ($1,'cash','live',$2,$3,'succeeded',$4, now())`,
        [booking.id, p.total, locale.currencyCode, staff.id]);
      if (d.holdToken) await t.q('DELETE FROM seat_holds WHERE token = $1', [d.holdToken]);
      await this.audit.log({ actor: staff, category: 'bookings', action: 'Vente au guichet', severity: 'success', targetType: 'booking', targetId: booking.id, targetName: booking.reference,
        details: `${seats.length} siège(s) · ${trip.fromCity} → ${trip.toCity}` }, t);
      return booking.id as string;
    });
    return this.view(bookingId, { withToken: true });
  }
  /** Crée (ou retrouve) le compte client d'un passager servi au guichet. Compte sans mot de passe : le client le choisit via « mot de passe oublié ». */
  async ensureWalkinCustomer(d: { firstName: string; lastName: string; phone: string; email?: string | null }): Promise<string> {
    const phone = normalizePhone(d.phone);
    const existing = await this.findCustomer(this.db, { phone, email: d.email });
    if (existing) return existing;
    const u = await this.db.insert<any>('users', { kind: 'customer', email: d.email || null, phone, firstName: d.firstName, lastName: d.lastName, publicId: newPublicId() });
    return u.id;
  }

  // ── Annulation et remboursement ────────────────────────────────────────────
  async cancel(bookingId: string, actor: Actor, opts: { passengerIds?: string[]; reason?: string; refundPercent?: number; mode: 'customer' | 'staff' }) {
    const s = await this.settings.get('booking');
    await this.db.tx(async t => {
      const b = await t.maybe<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 404);
      if (b.status === 'pending_payment') {
        await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'abandoned', cancelled_at = now(), updated_at = now() WHERE id = $1`, [b.id]);
        const rel = (await t.q<{ seatNo: string }>('DELETE FROM trip_seats WHERE booking_id = $1 RETURNING seat_no', [b.id])).map(r => r.seatNo);
        t.afterCommit(() => { if (rel.length) this.bus.emit(`trip:${b.tripId}`, 'seat.released', { tripId: b.tripId, seats: rel }); this.emitBooking(b, 'booking.cancelled', 'cancelled'); });
        return;
      }
      if (b.status !== 'confirmed') throw new AppError('BOOKING_NOT_CANCELLABLE', 409, 'Cette réservation ne peut plus être annulée');
      const trip = await t.one<any>('SELECT departure_at FROM trips WHERE id = $1', [b.tripId]);
      let percent = s.cancellation.refundPercent;
      if (opts.mode === 'customer') {
        if (!s.cancellation.enabled) throw new AppError('CANCELLATION_DISABLED', 409, 'L\'annulation en ligne n\'est pas proposée, contactez le guichet');
        if (Date.now() > new Date(trip.departureAt).getTime() - s.cancellation.deadlineHours * 3600000)
          throw new AppError('CANCELLATION_DEADLINE_PASSED', 409, `L'annulation n'est plus possible moins de ${s.cancellation.deadlineHours} h avant le départ`);
      } else if (opts.refundPercent !== undefined) {
        if (!can(actor.user, 'canRefund')) throw new AppError('PERMISSION_DENIED', 403, 'Seul un compte habilité peut fixer le montant du remboursement');
        percent = opts.refundPercent;
      }
      const all = await t.q<any>(`SELECT * FROM booking_passengers WHERE booking_id = $1 AND status IN ('active','boarded') FOR UPDATE`, [b.id]);
      const targets = opts.passengerIds?.length ? all.filter(p => opts.passengerIds!.includes(p.id)) : all;
      if (!targets.length || (opts.passengerIds?.length && targets.length !== opts.passengerIds.length)) throw new AppError('PASSENGER_NOT_FOUND', 404, 'Passager introuvable dans cette réservation');
      if (targets.some(p => p.status === 'boarded')) throw new AppError('PASSENGER_BOARDED', 409, 'Un passager déjà embarqué ne peut pas être annulé');
      const full = targets.length === all.length;
      await t.q(`UPDATE booking_passengers SET status = 'cancelled' WHERE id = ANY($1::uuid[])`, [targets.map(p => p.id)]);
      const seats = targets.map(p => p.seatNo);
      await t.q('DELETE FROM trip_seats WHERE booking_id = $1 AND seat_no = ANY($2::text[])', [b.id, seats]);
      // base du remboursement : prix des billets annulés (+ frais et taxes si annulation totale et politique « frais remboursés »)
      const ticketPart = targets.reduce((a, p) => a + p.price, 0);
      const alreadyRefunded = (await t.one<{ s: number }>(`SELECT coalesce(sum(amount),0)::bigint AS s FROM refunds WHERE booking_id = $1 AND status <> 'failed'`, [b.id])).s;
      const base = full && (s.cancellation.refundServiceFee || opts.mode === 'staff' && percent === 100) ? b.total - alreadyRefunded : ticketPart;
      const amount = Math.max(0, Math.round(base * percent / 100));
      const scheduled = await this.refunds.schedule(t, b.id, amount, opts.reason || (opts.mode === 'customer' ? 'customer_cancellation' : 'staff_cancellation'), actor.user?.id ?? null);
      if (full) await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_at = now() WHERE id = $1`, [b.id, opts.mode === 'customer' ? 'customer' : 'staff']);
      else await t.q('UPDATE bookings SET updated_at = now() WHERE id = $1', [b.id]);
      await this.notifyBooking(t, b, 'booking_cancelled', false, { cancelled_seats: seats.join(', '), refund_amount: scheduled });
      if (actor.user?.kind === 'staff') await this.audit.log({ actor: actor.user, category: 'bookings', action: full ? 'Réservation annulée' : 'Passager annulé', severity: 'danger',
        targetType: 'booking', targetId: b.id, targetName: b.reference, details: `Sièges ${seats.join(', ')} · remboursement ${scheduled} (${percent} %)${opts.reason ? ' · ' + opts.reason : ''}`, ip: actor.ip }, t);
      t.afterCommit(() => {
        this.bus.emit(`trip:${b.tripId}`, 'seat.released', { tripId: b.tripId, seats });
        this.emitBooking(b, full ? 'booking.cancelled' : 'booking.updated', full ? 'cancelled' : 'confirmed', { refundAmount: scheduled });
      });
    });
    return this.view(bookingId);
  }

  // ── Modification (changement de siège ou de départ) ────────────────────────
  async change(bookingId: string, actor: Actor, d: { tripId?: string; seats: Array<{ passengerId: string; seatNo: string }>; holdToken?: string | null; collectDifference?: boolean }, mode: 'customer' | 'staff') {
    const s = await this.settings.get('booking');
    await this.db.tx(async t => {
      const b = await t.maybe<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 404);
      if (b.status !== 'confirmed') throw new AppError('BOOKING_NOT_CHANGEABLE', 409, 'Seule une réservation confirmée peut être modifiée');
      const oldTrip = await this.trips.tripById(b.tripId, t);
      const newTripId = d.tripId ?? b.tripId;
      const newTrip = newTripId === b.tripId ? oldTrip : await this.trips.tripById(newTripId, t);
      if (mode === 'customer') {
        if (!s.change.enabled) throw new AppError('CHANGE_DISABLED', 409, 'La modification en ligne n\'est pas proposée, contactez le guichet');
        if (Date.now() > new Date(oldTrip.departureAt).getTime() - s.change.deadlineHours * 3600000)
          throw new AppError('CHANGE_DEADLINE_PASSED', 409, `La modification n'est plus possible moins de ${s.change.deadlineHours} h avant le départ`);
        if (newTrip.routeId !== oldTrip.routeId) throw new AppError('CHANGE_ROUTE_NOT_ALLOWED', 409, 'Le changement d\'itinéraire se fait au guichet');
      }
      if (newTripId !== b.tripId || mode === 'customer') await this.seats.assertSellable(newTrip, mode === 'staff');
      const pax = await t.q<any>(`SELECT * FROM booking_passengers WHERE booking_id = $1 AND status = 'active' ORDER BY seat_no FOR UPDATE`, [b.id]);
      const map = new Map(d.seats.map(x => [x.passengerId, x.seatNo]));
      if (newTripId !== b.tripId && pax.some(p => !map.has(p.id))) throw new AppError('SEATS_REQUIRED', 400, 'Choisissez un siège pour chaque passager sur le nouveau départ');
      if ([...map.keys()].some(id => !pax.find(p => p.id === id))) throw new AppError('PASSENGER_NOT_FOUND', 404);
      const next = pax.map(p => ({ ...p, newSeat: map.get(p.id) ?? p.seatNo }));
      const newSeats = next.map(p => p.newSeat);
      if (new Set(newSeats).size !== newSeats.length) throw new AppError('DUPLICATE_SEAT', 400, 'Un siège est attribué à deux passagers');
      const valid = new Set(layoutSeats(newTrip.layoutRows));
      if (newSeats.some(x => !valid.has(x))) throw new AppError('SEAT_UNKNOWN', 400, 'Siège inexistant dans ce véhicule');

      const priced = await this.price(newTrip.price, next);
      const oldTickets = pax.reduce((a, p) => a + p.price, 0);
      const diff = priced.subtotal - oldTickets;
      if (diff > 0 && !(mode === 'staff' && d.collectDifference))
        throw new AppError('PRICE_DIFFERENCE', 409, 'Le nouveau départ est plus cher : le complément se règle au guichet', { difference: diff });

      // 1) on prend les nouveaux sièges ; 2) seulement ensuite on rend les anciens. En cas d'échec, tout est annulé.
      const got = await this.seats.acquireBooked(t, newTripId, newSeats, b.id, d.holdToken ?? null);
      if (got.length !== newSeats.length) throw new AppError('SEAT_TAKEN', 409, 'Un des sièges choisis vient d\'être pris', { seats: newSeats.filter(x => !got.includes(x)) });
      const freed = newTripId === b.tripId
        ? (await t.q<{ seatNo: string }>('DELETE FROM trip_seats WHERE trip_id = $1 AND booking_id = $2 AND NOT (seat_no = ANY($3::text[])) RETURNING seat_no', [b.tripId, b.id, newSeats])).map(r => r.seatNo)
        : (await t.q<{ seatNo: string }>('DELETE FROM trip_seats WHERE trip_id = $1 AND booking_id = $2 RETURNING seat_no', [b.tripId, b.id])).map(r => r.seatNo);
      for (let i = 0; i < next.length; i++) await t.q('UPDATE booking_passengers SET seat_no = $2, price = $3 WHERE id = $1', [next[i].id, next[i].newSeat, priced.prices[i]]);
      await t.q('UPDATE bookings SET trip_id = $2, subtotal = subtotal + $3, total = total + $3, needs_attention = false, attention_note = NULL, updated_at = now() WHERE id = $1', [b.id, newTripId, diff]);
      let refunded = 0;
      if (diff < 0) refunded = await this.refunds.schedule(t, b.id, -diff, 'change_price_difference', actor.user?.id ?? null);
      if (diff > 0) await t.q(`INSERT INTO payments (booking_id, method, mode, amount, currency, status, received_by, succeeded_at) VALUES ($1,'cash','live',$2,$3,'succeeded',$4, now())`, [b.id, diff, b.currency, actor.user!.id]);
      if (d.holdToken) await t.q('DELETE FROM seat_holds WHERE token = $1', [d.holdToken]);
      const nb = { ...b, tripId: newTripId };
      await this.notifyBooking(t, nb, 'booking_changed', true, { old_seats: pax.map(p => p.seatNo).join(', ') });
      if (actor.user?.kind === 'staff') await this.audit.log({ actor: actor.user, category: 'bookings', action: 'Réservation modifiée', severity: 'warning', targetType: 'booking', targetId: b.id, targetName: b.reference,
        details: `${pax.map(p => p.seatNo).join(', ')} → ${newSeats.join(', ')}${newTripId !== b.tripId ? ' · nouveau départ' : ''}${diff ? ' · écart ' + diff : ''}`, ip: actor.ip }, t);
      t.afterCommit(() => {
        if (freed.length) this.bus.emit(`trip:${b.tripId}`, 'seat.released', { tripId: b.tripId, seats: freed });
        this.bus.emit(`trip:${newTripId}`, 'seat.booked', { tripId: newTripId, seats: newSeats });
        this.emitBooking(nb, 'booking.updated', 'confirmed', { refundAmount: refunded });
      });
    });
    return this.view(bookingId);
  }

  // ── Embarquement et absence ────────────────────────────────────────────────
  async markNoShow(bookingId: string, staff: AuthUser, passengerIds?: string[]) {
    const s = await this.settings.get('booking');
    await this.db.tx(async t => {
      const b = await t.maybe<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 404);
      if (!['confirmed', 'completed'].includes(b.status)) throw new AppError('BOOKING_NOT_CONFIRMED', 409, 'Seule une réservation confirmée peut être marquée absente');
      const rows = await t.q<any>(`UPDATE booking_passengers SET status = 'no_show' WHERE booking_id = $1 AND status = 'active' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) RETURNING id, price`, [b.id, passengerIds?.length ? passengerIds : null]);
      if (!rows.length) throw new AppError('PASSENGER_NOT_FOUND', 404, 'Aucun passager à marquer absent');
      const left = (await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM booking_passengers WHERE booking_id = $1 AND status IN ('active','boarded')`, [b.id])).n;
      if (left === 0) await t.q(`UPDATE bookings SET status = 'no_show', updated_at = now() WHERE id = $1`, [b.id]);
      if (s.noShow.refundPercent > 0) await this.refunds.schedule(t, b.id, Math.round(rows.reduce((a, r) => a + r.price, 0) * s.noShow.refundPercent / 100), 'no_show', staff.id);
      await this.audit.log({ actor: staff, category: 'bookings', action: 'Passager absent (no-show)', severity: 'warning', targetType: 'booking', targetId: b.id, targetName: b.reference, details: `${rows.length} passager(s)` }, t);
      t.afterCommit(() => this.emitBooking(b, 'booking.updated', left === 0 ? 'no_show' : b.status));
    });
    return this.view(bookingId);
  }

  // ── Opérations sur un voyage ───────────────────────────────────────────────
  /** Annule un voyage : toutes les réservations sont annulées, intégralement remboursées, et les passagers prévenus. */
  async cancelTrip(tripId: string, reason: string, staff: AuthUser) {
    return this.db.tx(async t => {
      const trip = await t.maybe<any>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
      if (!trip) throw new AppError('TRIP_NOT_FOUND', 404);
      if (trip.status === 'cancelled') throw new AppError('TRIP_ALREADY_CANCELLED', 409, 'Ce voyage est déjà annulé');
      if (['completed', 'in_progress'].includes(trip.status)) throw new AppError('TRIP_ALREADY_STARTED', 409, 'Un voyage commencé ou terminé ne peut pas être annulé');
      const bookings = await t.q<any>(`SELECT * FROM bookings WHERE trip_id = $1 AND status IN ('confirmed','pending_payment') FOR UPDATE`, [tripId]);
      let refunded = 0, confirmed = 0;
      for (const b of bookings) {
        if (b.status === 'confirmed') {
          confirmed++;
          const done = (await t.one<{ s: number }>(`SELECT coalesce(sum(amount),0)::bigint AS s FROM refunds WHERE booking_id = $1 AND status <> 'failed'`, [b.id])).s;
          refunded += await this.refunds.schedule(t, b.id, b.total - done, 'trip_cancelled', staff.id);
          await this.notifyBooking(t, b, 'trip_cancelled', false, { cancel_reason: reason, refund_amount: b.total - done });
        }
        await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'trip_cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [b.id]);
        await t.q(`UPDATE booking_passengers SET status = 'cancelled' WHERE booking_id = $1 AND status = 'active'`, [b.id]);
      }
      await t.q(`UPDATE trips SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`, [tripId, reason]);
      await t.q('DELETE FROM trip_seats WHERE trip_id = $1', [tripId]);
      await t.q('DELETE FROM seat_holds WHERE trip_id = $1', [tripId]);
      await this.audit.log({ actor: staff, category: 'trips', action: 'Voyage annulé', severity: 'danger', targetType: 'trip', targetId: tripId,
        details: `${reason} · ${confirmed} réservation(s) remboursée(s) pour ${refunded}` }, t);
      t.afterCommit(() => {
        this.bus.emit(`trip:${tripId}`, 'trip.cancelled', { tripId, reason });
        for (const b of bookings) this.emitBooking(b, 'booking.cancelled', 'cancelled', { reason: 'trip_cancelled' });
      });
      return { cancelledBookings: bookings.length, confirmedBookings: confirmed, refundedAmount: refunded };
    });
  }

  /**
   * Remplace le véhicule d'un voyage. Les sièges vendus qui existent dans le nouveau plan sont conservés ;
   * les autres passagers sont replacés sur le siège libre le plus proche ; s'il n'y a plus de place, la réservation est signalée « à traiter ».
   */
  async replaceVehicle(tripId: string, vehicleId: string, staff: AuthUser) {
    return this.db.tx(async t => {
      const trip = await t.maybe<any>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
      if (!trip) throw new AppError('TRIP_NOT_FOUND', 404);
      if (!['scheduled', 'boarding'].includes(trip.status)) throw new AppError('TRIP_NOT_EDITABLE', 409, 'Ce voyage ne peut plus être modifié');
      const v = await t.maybe<any>('SELECT v.*, l.rows, l.capacity FROM vehicles v JOIN seat_layouts l ON l.id = v.layout_id WHERE v.id = $1', [vehicleId]);
      if (!v) throw new AppError('VEHICLE_NOT_FOUND', 404);
      if (v.status !== 'active') throw new AppError('VEHICLE_UNAVAILABLE', 409, 'Ce véhicule n\'est pas en service');
      const newSeats = layoutSeats(v.rows), valid = new Set(newSeats);

      // sélections en cours et réservations non payées : elles sont libérées, les clients concernés devront rechoisir
      const dropped = (await t.q<{ seatNo: string }>(`DELETE FROM trip_seats WHERE trip_id = $1 AND status = 'held' RETURNING seat_no`, [tripId])).map(r => r.seatNo);
      await t.q('DELETE FROM seat_holds WHERE trip_id = $1', [tripId]);
      await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'vehicle_changed', cancelled_at = now(), updated_at = now() WHERE trip_id = $1 AND status = 'pending_payment'`, [tripId]);

      const pax = await t.q<any>(
        `SELECT p.id, p.seat_no, p.first_name, p.last_name, p.booking_id, b.reference FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id
          WHERE b.trip_id = $1 AND b.status = 'confirmed' AND p.status IN ('active','boarded') ORDER BY b.confirmed_at, p.seat_no FOR UPDATE OF p, b`, [tripId]);
      const taken = new Set(pax.filter(p => valid.has(p.seatNo)).map(p => p.seatNo));
      const moved: any[] = [], unseated: any[] = [];
      const rowOf = (s: string) => s.replace(/\d+$/, '');
      for (const p of pax.filter(x => !valid.has(x.seatNo))) {
        const free = newSeats.filter(s => !taken.has(s));
        const target = free.find(s => rowOf(s) === rowOf(p.seatNo)) ?? free[0];   // même rangée si possible, sinon premier siège libre
        if (target) { taken.add(target); moved.push({ passengerId: p.id, bookingId: p.bookingId, reference: p.reference, name: `${p.firstName} ${p.lastName}`, from: p.seatNo, to: target }); }
        else unseated.push({ passengerId: p.id, bookingId: p.bookingId, reference: p.reference, name: `${p.firstName} ${p.lastName}`, from: p.seatNo });
      }
      // le véhicule change : la contrainte d'exclusion refuse (23P01 → 409) s'il a déjà un voyage sur ce créneau
      await t.q('UPDATE trips SET vehicle_id = $2, layout_id = $3, updated_at = now() WHERE id = $1', [tripId, vehicleId, v.layoutId]);
      for (const m of moved) {
        await t.q('DELETE FROM trip_seats WHERE trip_id = $1 AND seat_no = $2 AND booking_id = $3', [tripId, m.from, m.bookingId]);
        await t.q(`INSERT INTO trip_seats (trip_id, seat_no, status, booking_id) VALUES ($1,$2,'booked',$3)`, [tripId, m.to, m.bookingId]);
        await t.q('UPDATE booking_passengers SET seat_no = $2 WHERE id = $1', [m.passengerId, m.to]);
      }
      for (const u of unseated) {
        await t.q('DELETE FROM trip_seats WHERE trip_id = $1 AND seat_no = $2 AND booking_id = $3', [tripId, u.from, u.bookingId]);
        await t.q(`UPDATE booking_passengers SET seat_no = 'N/A' WHERE id = $1`, [u.passengerId]);
        await t.q(`UPDATE bookings SET needs_attention = true, attention_note = $2, updated_at = now() WHERE id = $1`, [u.bookingId, `Véhicule remplacé : plus de siège pour ${u.name} (ancien siège ${u.from}). Proposer un autre départ ou un remboursement.`]);
      }
      const touched = [...new Set([...moved, ...unseated].map(x => x.bookingId))];
      for (const id of touched) {
        const b = await t.one<any>('SELECT * FROM bookings WHERE id = $1', [id]);
        const mine = moved.filter(m => m.bookingId === id);
        await this.notifyBooking(t, b, 'seat_changed', mine.length > 0 && !unseated.some(u => u.bookingId === id), {
          vehicle: v.name, changes: mine.map(m => `${m.name} : ${m.from} → ${m.to}`).join(' ; '), unseated: unseated.filter(u => u.bookingId === id).map(u => u.name).join(', '),
        });
      }
      await this.audit.log({ actor: staff, category: 'trips', action: 'Véhicule remplacé', severity: 'warning', targetType: 'trip', targetId: tripId, targetName: v.name,
        details: `${pax.length - moved.length - unseated.length} siège(s) conservé(s), ${moved.length} déplacé(s), ${unseated.length} sans siège` }, t);
      t.afterCommit(() => {
        this.bus.emit(`trip:${tripId}`, 'trip.vehicle_changed', { tripId, vehicleId, droppedHolds: dropped });
        if (unseated.length) this.bus.emit('staff', 'alert', { type: 'reassignment_needed', tripId, count: unseated.length });
      });
      return { kept: pax.length - moved.length - unseated.length, moved, unseated, droppedHolds: dropped.length };
    });
  }

  /** Tâche planifiée : les réservations non payées dont le délai est dépassé passent à « expirée ». */
  async expirePending(): Promise<number> {
    const rows = await this.db.q<any>(
      `UPDATE bookings b SET status = 'expired', updated_at = now() WHERE b.status = 'pending_payment' AND b.expires_at < now()
        RETURNING b.id, b.reference, b.trip_id, b.customer_id`);
    for (const b of rows) this.emitBooking(b, 'booking.expired', 'expired');
    return rows.length;
  }
  /** Tâche planifiée : clôture des voyages (en cours / terminé) et des réservations associées. */
  async closeTrips(): Promise<{ started: number; completed: number; noShows: number }> {
    const s = await this.settings.get('booking');
    const started = await this.db.q<{ id: string }>(`UPDATE trips SET status = 'in_progress', updated_at = now() WHERE status IN ('scheduled','boarding') AND departure_at <= now() RETURNING id`);
    for (const r of started) { await this.db.q(`DELETE FROM trip_seats WHERE trip_id = $1 AND status = 'held'`, [r.id]); this.bus.emit(`trip:${r.id}`, 'trip.updated', { tripId: r.id, status: 'in_progress' }); }
    const done = await this.db.q<{ id: string }>(`UPDATE trips SET status = 'completed', updated_at = now() WHERE status = 'in_progress' AND arrival_at <= now() RETURNING id`);
    let noShows = 0;
    for (const r of done) {
      // absence automatique seulement si le contrôle des billets est réellement utilisé sur ce voyage (au moins un passager scanné)
      if (s.noShow.auto && await this.db.maybe(`SELECT 1 FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id WHERE b.trip_id = $1 AND p.status = 'boarded' LIMIT 1`, [r.id])) {
        noShows += (await this.db.q(`UPDATE booking_passengers p SET status = 'no_show' FROM bookings b WHERE b.id = p.booking_id AND b.trip_id = $1 AND b.status = 'confirmed' AND p.status = 'active' RETURNING p.id`, [r.id])).length;
        await this.db.q(`UPDATE bookings b SET status = 'no_show', updated_at = now() WHERE b.trip_id = $1 AND b.status = 'confirmed'
                            AND NOT EXISTS (SELECT 1 FROM booking_passengers p WHERE p.booking_id = b.id AND p.status IN ('active','boarded'))`, [r.id]);
      }
      await this.db.q(`UPDATE bookings SET status = 'completed', updated_at = now() WHERE trip_id = $1 AND status = 'confirmed'`, [r.id]);
      this.bus.emit(`trip:${r.id}`, 'trip.updated', { tripId: r.id, status: 'completed' });
    }
    return { started: started.length, completed: done.length, noShows };
  }
}
