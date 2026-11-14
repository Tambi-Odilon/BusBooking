import { Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, ClientIp, CurrentUser, OptionalAuth, Public, RateLimit, RequirePermission } from '../../common/auth';
import { Api, ZBody, zDate, zEmail, zId, zPhone, zSeat, zText } from '../../common/zod';
import { Db, paging } from '../../common/db';
import { AppError } from '../../common/errors';
import { Idempotency } from '../../common/idempotency';
import { SettingsService } from '../settings/settings.service';
import { SeatsService } from './seats.service';
import { BookingsService } from './bookings.service';
import { TicketsService } from '../tickets/tickets.service';
import { Outbox } from '../notifications/outbox';

const passenger = z.strictObject({
  seatNo: zSeat, firstName: zText(60), lastName: zText(60), phone: z.union([z.literal(''), zPhone]).optional(),
  gender: z.enum(['M', 'F', '']).default(''), category: z.enum(['adult', 'child']).default('adult'),
});
const contact = z.strictObject({ name: zText(120), phone: zPhone, email: z.union([z.literal(''), zEmail]).nullish() });
export const bookingCreate = z.strictObject({
  tripId: zId, holdToken: zId, passengers: z.array(passenger).min(1).max(60), contact, lang: z.string().max(5).optional(),
});
const holdSchema = z.strictObject({ seats: z.array(zSeat).max(60), holdToken: zId.nullish() });
const tokenSchema = z.strictObject({ holdToken: zId });
const cancelSchema = z.strictObject({ passengerIds: z.array(zId).max(60).optional(), reason: z.string().trim().max(300).optional() });
const changeSchema = z.strictObject({ tripId: zId.optional(), seats: z.array(z.strictObject({ passengerId: zId, seatNo: zSeat })).max(60), holdToken: zId.nullish() });

@ApiTags('Recherche et sièges')
@Controller()
export class SearchController {
  constructor(private db: Db, private seats: SeatsService, private settings: SettingsService) {}

  @Public() @Get('cities') @Api('Villes desservies par au moins un itinéraire actif')
  async cities() {
    return (await this.db.q<{ name: string }>(
      `SELECT DISTINCT c.name FROM cities c JOIN routes r ON (r.from_city_id = c.id OR r.to_city_id = c.id) AND r.status = 'active' WHERE c.is_active ORDER BY c.name`)).map(c => c.name);
  }
  @Public() @Get('routes/popular') @Api('Itinéraires les plus réservés')
  popular() {
    return this.db.q(
      `SELECT cf.name AS from_city, ct.name AS to_city,
              -- « à partir de » = prix réel du départ à venir le moins cher (et non le prix de référence de l'itinéraire)
              COALESCE((SELECT min(t.price) FROM trips t WHERE t.route_id = r.id AND t.status = 'scheduled' AND t.departure_at > now()), r.base_price) AS price,
              (SELECT count(*) FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE t.route_id = r.id AND b.status IN ('confirmed','completed') AND b.created_at > now() - interval '90 days') AS n
         FROM routes r JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
        WHERE r.status = 'active' AND EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.id AND t.status = 'scheduled' AND t.departure_at > now())
        ORDER BY n DESC, r.created_at LIMIT 4`);
  }
  @Public() @RateLimit('search', 120, 60) @Get('search') @Api('Rechercher les départs disponibles')
  async search(@Query() q: any) {
    const p = z.object({ from: zText(80), to: zText(80), date: zDate, passengers: z.coerce.number().int().min(1).max(60).default(1) }).parse(q);
    const max = (await this.settings.get('booking')).maxPassengers;
    if (p.passengers > max) throw new AppError('TOO_MANY_PASSENGERS', 400, `Maximum ${max} passagers par réservation`);
    return this.seats.search(p.from, p.to, p.date, p.passengers);
  }
  @Public() @Get('trips/:id/seats') @Api('Plan et état des sièges d\'un voyage')
  seatMap(@Param('id') id: string, @Query('holdToken') token?: string) { return this.seats.seatMap(zId.parse(id), token ? zId.parse(token) : undefined); }

  @OptionalAuth() @RateLimit('hold', 60, 60) @HttpCode(200) @Post('trips/:id/holds') @Api('Sélectionner des sièges (verrou temporaire, tout ou rien)', holdSchema)
  hold(@Param('id') id: string, @ZBody(holdSchema) b: any, @CurrentUser() u: AuthUser | null) {
    return this.seats.setHold(zId.parse(id), b.seats, b.holdToken ?? undefined, { userId: u?.id, staff: u?.kind === 'staff' });
  }
  @Public() @RateLimit('hold', 60, 60) @Patch('trips/:id/holds') @Api('Prolonger le verrou', tokenSchema)
  extend(@Param('id') id: string, @ZBody(tokenSchema) b: any) { return this.seats.extendHold(zId.parse(id), b.holdToken); }
  @Public() @HttpCode(200) @Delete('trips/:id/holds') @Api('Libérer les sièges (abandon)')
  release(@Param('id') id: string, @Query('holdToken') token: string) { return this.seats.releaseHold(zId.parse(id), zId.parse(token)); }
  /** Variante POST pour `navigator.sendBeacon` à la fermeture de la page (sendBeacon ne sait pas envoyer DELETE). */
  @Public() @HttpCode(200) @Post('trips/:id/holds/release') @Api('Libérer les sièges à la fermeture de la page')
  beacon(@Param('id') id: string, @Query('holdToken') token: string) { return this.seats.releaseHold(zId.parse(id), zId.parse(token)); }
}

@ApiTags('Réservations')
@Controller('bookings')
export class BookingsController {
  constructor(private bookings: BookingsService, private idem: Idempotency, private tickets: TicketsService, private outbox: Outbox) {}

  @OptionalAuth() @RateLimit('booking', 30, 60) @Post() @Api('Créer une réservation à partir d\'un verrou (en-tête Idempotency-Key requis)', bookingCreate)
  create(@ZBody(bookingCreate) b: any, @Headers() h: any, @CurrentUser() u: AuthUser | null, @ClientIp() ip: string) {
    const key = Idempotency.key(h);
    return this.idem.run(`booking:${b.holdToken}`, key, b, () => this.bookings.create(b, { user: u, ip }, key, u?.kind === 'staff' ? 'counter' : 'web'));
  }
  @Get('mine') @Api('Mes réservations (client connecté)')
  mine(@CurrentUser() u: AuthUser, @Query() q: any) { const { page, limit, offset } = paging(q, 50, 10); return this.bookings.mine(u, page, limit, offset); }

  @Public() @RateLimit('lookup', 10, 600) @HttpCode(200) @Post('lookup') @Api('Retrouver une réservation avec sa référence et le téléphone de contact')
  lookup(@ZBody(z.strictObject({ reference: z.string().trim().min(3).max(40), phone: zPhone })) b: any) { return this.bookings.lookup(b.reference, b.phone); }

  @OptionalAuth() @Get(':reference') @Api('Détail d\'une réservation')
  async get(@Param('reference') ref: string, @Headers() h: any, @Query('t') t: string, @CurrentUser() u: AuthUser | null) {
    const b = await this.bookings.authorize(ref, { user: u }, h['x-booking-token'] || t);
    return this.bookings.view(b.id);
  }
  @OptionalAuth() @RateLimit('cancel', 20, 600) @HttpCode(200) @Post(':reference/cancel') @Api('Annuler une réservation ou certains passagers', cancelSchema)
  async cancel(@Param('reference') ref: string, @ZBody(cancelSchema) body: any, @Headers() h: any, @CurrentUser() u: AuthUser | null, @ClientIp() ip: string) {
    const b = await this.bookings.authorize(ref, { user: u }, h['x-booking-token']);
    return this.bookings.cancel(b.id, { user: u?.kind === 'customer' ? u : null, ip }, { ...body, mode: 'customer' });
  }
  @OptionalAuth() @RateLimit('change', 20, 600) @HttpCode(200) @Post(':reference/change') @Api('Changer de siège ou de départ', changeSchema)
  async change(@Param('reference') ref: string, @ZBody(changeSchema) body: any, @Headers() h: any, @CurrentUser() u: AuthUser | null, @ClientIp() ip: string) {
    const b = await this.bookings.authorize(ref, { user: u }, h['x-booking-token']);
    return this.bookings.change(b.id, { user: u?.kind === 'customer' ? u : null, ip }, body, 'customer');
  }
  @OptionalAuth() @RateLimit('ticket', 30, 60) @Get(':reference/ticket.pdf') @Api('Télécharger le billet PDF (avec QR code)')
  async ticket(@Param('reference') ref: string, @Headers() h: any, @Query('t') t: string, @CurrentUser() u: AuthUser | null, @Res() res: any) {
    const b = await this.bookings.authorize(ref, { user: u }, h['x-booking-token'] || t);
    const pdf = await this.tickets.pdf(b.id);
    res.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="billet-${ref.toUpperCase()}.pdf"`).header('Cache-Control', 'private, no-store').send(pdf);
  }
  @OptionalAuth() @Get(':reference/qr') @Api('QR codes des billets (images en data-URL)')
  async qr(@Param('reference') ref: string, @Headers() h: any, @Query('t') t: string, @CurrentUser() u: AuthUser | null) {
    const b = await this.bookings.authorize(ref, { user: u }, h['x-booking-token'] || t);
    return this.tickets.qrCodes(b.id);
  }
  @OptionalAuth() @RateLimit('resend', 5, 600) @HttpCode(202) @Post(':reference/resend') @Api('Renvoyer le billet par e-mail')
  async resend(@Param('reference') ref: string, @ZBody(z.strictObject({ email: zEmail.optional() })) body: any, @Headers() h: any, @CurrentUser() u: AuthUser | null) {
    const b = await this.bookings.authorize(ref, { user: u }, h['x-booking-token']);
    const v = await this.bookings.view(b.id);
    if (v.status !== 'confirmed') throw new AppError('BOOKING_NOT_CONFIRMED', 409, 'Le billet n\'est disponible que pour une réservation confirmée');
    const to = body.email || v.contact.email;
    if (!to) throw new AppError('EMAIL_REQUIRED', 400, 'Indiquez une adresse e-mail');
    await this.tickets.enqueueTicketEmail(b.id, to);
    return { ok: true };
  }
}

@ApiTags('Contrôle des billets')
@Controller('tickets')
export class TicketsController {
  constructor(private tickets: TicketsService) {}
  @RequirePermission('canCheckTickets', 'canSellWalkin', 'canManageBookings') @RateLimit('verify', 240, 60) @HttpCode(200) @Post('verify') @Api('Vérifier un billet scanné (QR code ou numéro)')
  verify(@ZBody(z.strictObject({ code: z.string().trim().min(3).max(200), tripId: zId.optional() })) b: any) { return this.tickets.verify(b.code, b.tripId); }
  @RequirePermission('canCheckTickets', 'canSellWalkin', 'canManageBookings') @HttpCode(200) @Post('board') @Api('Valider l\'embarquement d\'un passager')
  board(@ZBody(z.strictObject({ code: z.string().trim().min(3).max(200), tripId: zId.optional() })) b: any, @CurrentUser() u: AuthUser) { return this.tickets.board(b.code, u, b.tripId); }
}
