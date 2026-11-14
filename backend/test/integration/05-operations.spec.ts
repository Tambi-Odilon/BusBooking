import { DateTime } from 'luxon';
import { Ctx, ZONE, assertNoDoubleSale, book, boot, customer, day, getBooking, hold, key, pay, purchase, route, seatRows, settle, setup, staff, trip, vehicle, world } from '../helpers';

const walkin = (c: Ctx, token: string, tripId: string, seats: string[], extra: any = {}, idem = key()) =>
  c.api('POST', '/admin/walkin', { token, headers: { 'idempotency-key': idem }, body: {
    tripId, passengers: seats.map((s, i) => ({ seatNo: s, firstName: 'Guichet' + i, lastName: 'Client' })), contact: { name: 'Guichet Client', phone: '0345550001' }, paymentMethod: 'cash', ...extra } });

describe('Exploitation : guichet, annulations, modifications, voyages', () => {
  let c: Ctx, admin: string;
  beforeAll(async () => { c = await boot(); admin = await setup(c); });
  afterAll(async () => { await c.close(); });

  describe('Vente au guichet', () => {
    let w: Awaited<ReturnType<typeof world>>, guichet: Awaited<ReturnType<typeof staff>>;
    beforeAll(async () => { w = await world(c, admin, { layout: 'minibus16' }); guichet = await staff(c, admin, 'employe'); });
    it('espèces : réservation, encaissement et billets en une seule opération', async () => {
      const r = await walkin(c, guichet.token, w.tripId, ['A1', 'A2'], { amountReceived: 40000 });
      expect(r.status).toBe(201);
      expect(r.body.booking).toMatchObject({ status: 'confirmed', channel: 'counter', total: 32000, soldBy: guichet.id });
      expect(r.body.booking.payment).toMatchObject({ status: 'paid', method: 'cash', paidAmount: 32000 });
      expect(r.body.booking.passengers.every((p: any) => p.ticketNumber)).toBe(true);
      expect((await seatRows(c, w.tripId)).map(s => s.status)).toEqual(['booked', 'booked']);
      const audit = await c.db.one<any>(`SELECT actor_id, action FROM audit_log WHERE target_id = $1`, [r.body.booking.id]);
      expect(audit).toEqual({ actorId: guichet.id, action: 'Vente au guichet' });
    });
    it('montant reçu insuffisant : vente refusée, rien n\'est enregistré', async () => {
      const r = await walkin(c, guichet.token, w.tripId, ['A3'], { amountReceived: 1000 });
      expect([r.status, r.body.code]).toEqual([400, 'AMOUNT_INSUFFICIENT']);
      expect((await seatRows(c, w.tripId)).some(s => s.seatNo === 'A3')).toBe(false);
    });
    it('siège déjà vendu ou retenu par un client web : refus net, aucune vente partielle', async () => {
      const web = await hold(c, w.tripId, ['B1']);
      const r = await walkin(c, guichet.token, w.tripId, ['A4', 'B1']);
      expect([r.status, r.body.code]).toEqual([409, 'SEAT_TAKEN']);
      const sold = await walkin(c, guichet.token, w.tripId, ['A1']);
      expect(sold.status).toBe(409);
      expect((await seatRows(c, w.tripId)).some(s => s.seatNo === 'A4')).toBe(false);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM bookings WHERE trip_id = $1`, [w.tripId])).n).toBe(1);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${web.body.token}`);
    });
    it('le guichet retient les sièges comme un client, puis vend avec son verrou', async () => {
      const h = await hold(c, w.tripId, ['B1', 'B2'], undefined, guichet.token);
      expect((await hold(c, w.tripId, ['B2'])).body.code).toBe('SEAT_TAKEN');          // le client web voit le siège pris
      const r = await walkin(c, guichet.token, w.tripId, ['B1', 'B2'], { holdToken: h.body.token });
      expect(r.status).toBe(201);
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM seat_holds WHERE token = $1', [h.body.token])).n).toBe(0);
    });
    it('double clic sur « Encaisser » : une seule vente', async () => {
      const idem = key();
      const [a, b] = await Promise.all([walkin(c, guichet.token, w.tripId, ['B3'], {}, idem), walkin(c, guichet.token, w.tripId, ['B3'], {}, idem)]);
      expect(a.body.booking.reference).toBe(b.body.booking.reference);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id WHERE b.trip_id = $1 AND p.seat_no = 'B3'`, [w.tripId])).n).toBe(1);
    });
    it('paiement mobile au guichet : réservation en attente puis confirmation par l\'opérateur', async () => {
      const h = await hold(c, w.tripId, ['C1'], undefined, guichet.token);
      const r = await walkin(c, guichet.token, w.tripId, ['C1'], { holdToken: h.body.token, paymentMethod: 'mvola', payerPhone: '0340000222' });
      expect(r.body.booking.status).toBe('pending_payment');
      expect(r.body.payment.status).toBe('pending');
      expect(await settle(c, r.body.payment.id)).toBe('confirmed');
      const noHold = await walkin(c, guichet.token, w.tripId, ['C2'], { paymentMethod: 'mvola' });
      expect(noHold.body.code).toBe('HOLD_REQUIRED');
    });
    it('création du compte client au guichet : sans mot de passe, le client le choisira lui-même', async () => {
      const r = await walkin(c, guichet.token, w.tripId, ['C2'], { createAccount: true, contact: { name: 'Nouveau Client', phone: '0346660002', email: 'nouveau@test.local' } });
      expect(r.status).toBe(201);
      const u = await c.db.one<any>(`SELECT id, password_hash, kind FROM users WHERE email = 'nouveau@test.local'`);
      expect(u).toMatchObject({ passwordHash: null, kind: 'customer' });
      expect((await c.api('POST', '/auth/login', { body: { email: 'nouveau@test.local', password: 'Guichet00002', scope: 'customer' } })).status).toBe(401);   // plus de mot de passe devinable
    });
    it('manifeste des passagers et invariant', async () => {
      const m = await c.api('GET', `/admin/trips/${w.tripId}/manifest`, { token: guichet.token });
      expect(m.body.passengers.map((p: any) => p.seatNo)).toEqual(['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2']);
      expect(m.body.trip.seatsAvailable).toBe(9);
      await assertNoDoubleSale(c, w.tripId);
    });
  });

  describe('Annulation et remboursement', () => {
    let w: Awaited<ReturnType<typeof world>>;
    beforeAll(async () => { w = await world(c, admin, { from: 'Fianarantsoa', to: 'Manakara', layout: 'minibus16', price: 20000 }); });
    it('annulation totale par le client : billets remboursés, frais de service conservés (politique par défaut)', async () => {
      const p = await purchase(c, w.tripId, ['A1', 'A2']);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: {} });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'cancelled', cancelReason: 'customer', seats: [] });
      expect(r.body.payment).toMatchObject({ status: 'refund_pending', paidAmount: 42000, refundPendingAmount: 40000 });
      expect(await seatRows(c, w.tripId)).toEqual([]);                                       // sièges de nouveau en vente
      expect((await hold(c, w.tripId, ['A1'])).status).toBe(200);
      await c.db.q('DELETE FROM trip_seats WHERE trip_id = $1', [w.tripId]); await c.db.q('DELETE FROM seat_holds');
      const again = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: {} });
      expect(again.body.code).toBe('BOOKING_NOT_CANCELLABLE');                               // pas de double remboursement
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1', [p.booking.id])).n).toBe(1);
    });
    it('annulation d\'un seul passager : remboursement partiel, les autres billets restent valables', async () => {
      const p = await purchase(c, w.tripId, ['B1', 'B2', 'B3']);
      const v = await getBooking(c, p.booking);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { passengerIds: [v.passengers[1].id] } });
      expect(r.body.status).toBe('confirmed');
      expect(r.body.seats).toEqual(['B1', 'B3']);
      expect(r.body.payment).toMatchObject({ status: 'refund_pending', refundPendingAmount: 20000 });
      expect((await seatRows(c, w.tripId)).map(s => s.seatNo)).toEqual(['B1', 'B3']);
      await c.payments.processRefunds();
      expect((await getBooking(c, p.booking)).payment).toMatchObject({ status: 'partially_refunded', refundedAmount: 20000 });
      const unknown = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { passengerIds: ['00000000-0000-4000-8000-000000000000'] } });
      expect(unknown.status).toBe(404);
    });
    it('délai d\'annulation dépassé : refus pour le client, toujours possible au guichet', async () => {
      const p = await purchase(c, w.tripId, ['C1']);
      await c.db.q(`UPDATE trips SET departure_at = now() + interval '90 minutes', arrival_at = now() + interval '5 hours' WHERE id = $1`, [w.tripId]);
      expect((await getBooking(c, p.booking)).canCancel).toBe(false);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: {} });
      expect([r.status, r.body.code]).toEqual([409, 'CANCELLATION_DEADLINE_PASSED']);
      const s = await c.api('POST', `/admin/bookings/${p.booking.id}/cancel`, { token: admin, body: { reason: 'geste commercial', refundPercent: 50 } });
      expect(s.body.payment.refundPendingAmount).toBe(10000);
      await c.db.q(`UPDATE trips SET departure_at = now() + interval '2 days', arrival_at = now() + interval '2 days 4 hours' WHERE id = $1`, [w.tripId]);
    });
    it('seul un compte habilité peut imposer un pourcentage de remboursement', async () => {
      const sup = await staff(c, admin, 'superviseur');   // gère les réservations mais ne rembourse pas
      const p = await purchase(c, w.tripId, ['C2']);
      const r = await c.api('POST', `/admin/bookings/${p.booking.id}/cancel`, { token: sup.token, body: { refundPercent: 100 } });
      expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect((await getBooking(c, p.booking)).status).toBe('confirmed');
      expect((await c.api('POST', `/admin/bookings/${p.booking.id}/cancel`, { token: sup.token, body: { reason: 'demande client' } })).status).toBe(200);
    });
    it('un passager déjà embarqué ne peut pas être annulé', async () => {
      const p = await purchase(c, w.tripId, ['C3']);
      await c.db.q(`UPDATE booking_passengers SET status = 'boarded', boarded_at = now() WHERE booking_id = $1`, [p.booking.id]);
      const r = await c.api('POST', `/admin/bookings/${p.booking.id}/cancel`, { token: admin, body: {} });
      expect(r.body.code).toBe('PASSENGER_BOARDED');
    });
    it('politique paramétrable : annulation en ligne désactivée, ou remboursement à 80 % frais compris', async () => {
      const s = (await c.api('GET', '/admin/settings', { token: admin })).body.settings.booking;
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: { ...s, cancellation: { enabled: false, deadlineHours: 2, refundPercent: 100, refundServiceFee: false } } });
      const p = await purchase(c, w.tripId, ['D1']);
      const off = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: {} });
      expect(off.body.code).toBe('CANCELLATION_DISABLED');
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: { ...s, cancellation: { enabled: true, deadlineHours: 2, refundPercent: 80, refundServiceFee: true } } });
      const on = await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: {} });
      expect(on.body.payment.refundPendingAmount).toBe(17600);   // 80 % de (20 000 + 2 000)
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: s });
    });
    it('abandon avant paiement : annulation sans remboursement, sièges libérés', async () => {
      const h = await hold(c, w.tripId, ['D2']);
      const b = await book(c, w.tripId, h.body.token, ['D2']);
      const r = await c.api('POST', `/bookings/${b.body.reference}/cancel`, { headers: { 'x-booking-token': b.body.accessToken }, body: {} });
      expect(r.body.status).toBe('cancelled');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1', [b.body.id])).n).toBe(0);
      expect((await seatRows(c, w.tripId)).some(s => s.seatNo === 'D2')).toBe(false);
    });
  });

  describe('Modification d\'une réservation', () => {
    let w: Awaited<ReturnType<typeof world>>, later: any, vip: any;
    beforeAll(async () => {
      w = await world(c, admin, { from: 'Mahajanga', to: 'Maevatanana', layout: 'minibus16', price: 20000, time: '07:00' });
      const v2 = await vehicle(c, admin, 'minibus16'), v3 = await vehicle(c, admin, 'minibus10');
      later = await trip(c, admin, { routeId: w.route.id, vehicleId: v2.id, time: '14:00' });
      vip = await trip(c, admin, { routeId: w.route.id, vehicleId: v3.id, time: '16:00', price: 35000, date: day(3) });
    });
    it('changement de siège sur le même départ : l\'ancien siège est libéré, le nouveau billet est renvoyé', async () => {
      const p = await purchase(c, w.tripId, ['A1']);
      const v = await getBooking(c, p.booking);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { seats: [{ passengerId: v.passengers[0].id, seatNo: 'D4' }] } });
      expect(r.status).toBe(200);
      expect(r.body.seats).toEqual(['D4']);
      expect((await seatRows(c, w.tripId)).map(s => s.seatNo)).toEqual(['D4']);
      expect(r.body.total).toBe(22000);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'booking_changed' AND vars->>'reference' = $1`, [p.booking.reference])).n).toBe(1);
    });
    it('siège visé déjà pris : refus, la réservation d\'origine reste intacte', async () => {
      const a = await purchase(c, w.tripId, ['A1']);
      const b = await purchase(c, w.tripId, ['A2']);
      const v = await getBooking(c, b.booking);
      const r = await c.api('POST', `/bookings/${b.booking.reference}/change`, { headers: { 'x-booking-token': b.booking.accessToken }, body: { seats: [{ passengerId: v.passengers[0].id, seatNo: 'A1' }] } });
      expect([r.status, r.body.code]).toEqual([409, 'SEAT_TAKEN']);
      expect((await getBooking(c, b.booking)).seats).toEqual(['A2']);
      expect((await getBooking(c, a.booking)).seats).toEqual(['A1']);
      expect((await seatRows(c, w.tripId)).find(s => s.seatNo === 'A2').bookingId).toBe(b.booking.id);
    });
    it('deux passagers d\'une même réservation échangent leurs sièges', async () => {
      const p = await purchase(c, w.tripId, ['B1', 'B2']);
      const v = await getBooking(c, p.booking);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken },
        body: { seats: [{ passengerId: v.passengers[0].id, seatNo: 'B2' }, { passengerId: v.passengers[1].id, seatNo: 'B1' }] } });
      expect(r.status).toBe(200);
      expect(r.body.passengers.map((x: any) => [x.firstName, x.seatNo]).sort()).toEqual([['Passager0', 'B2'], ['Passager1', 'B1']]);
    });
    it('changement de départ au même prix : sièges pris sur le nouveau, rendus sur l\'ancien', async () => {
      const p = await purchase(c, w.tripId, ['C1']);
      const v = await getBooking(c, p.booking);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { tripId: later.id, seats: [{ passengerId: v.passengers[0].id, seatNo: 'A1' }] } });
      expect(r.status).toBe(200);
      expect(r.body.trip).toMatchObject({ tripId: later.id, departure: '14:00' });
      expect((await seatRows(c, w.tripId)).some(s => s.seatNo === 'C1')).toBe(false);
      expect((await seatRows(c, later.id)).map(s => [s.seatNo, s.status])).toEqual([['A1', 'booked']]);
      await assertNoDoubleSale(c, later.id);
    });
    it('départ plus cher : le client est renvoyé au guichet, qui encaisse le complément', async () => {
      const p = await purchase(c, w.tripId, ['C2']);
      const v = await getBooking(c, p.booking);
      const body = { tripId: vip.id, seats: [{ passengerId: v.passengers[0].id, seatNo: 'A1' }] };
      const r = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken }, body });
      expect([r.status, r.body.code, r.body.details.difference]).toEqual([409, 'PRICE_DIFFERENCE', 15000]);
      const s = await c.api('POST', `/admin/bookings/${p.booking.id}/change`, { token: admin, body: { ...body, collectDifference: true } });
      expect(s.status).toBe(200);
      expect(s.body.total).toBe(37000);
      expect(s.body.payment.paidAmount).toBe(37000);
    });
    it('départ moins cher : la différence est remboursée', async () => {
      const p = await purchase(c, vip.id, ['B1']);
      const v = await getBooking(c, p.booking);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { tripId: later.id, seats: [{ passengerId: v.passengers[0].id, seatNo: 'B1' }] } });
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(22000);
      expect(r.body.payment.refundPendingAmount).toBe(15000);
    });
    it('le client ne peut pas changer d\'itinéraire ni modifier après le délai', async () => {
      const other = await world(c, admin, { from: 'Sambava', to: 'Antalaha', layout: 'minibus16', price: 20000 });
      const p = await purchase(c, w.tripId, ['C3']);
      const v = await getBooking(c, p.booking);
      const r = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { tripId: other.tripId, seats: [{ passengerId: v.passengers[0].id, seatNo: 'A1' }] } });
      expect(r.body.code).toBe('CHANGE_ROUTE_NOT_ALLOWED');
      await c.db.q(`UPDATE trips SET departure_at = now() + interval '1 hour', arrival_at = now() + interval '5 hours' WHERE id = $1`, [w.tripId]);
      const late = await c.api('POST', `/bookings/${p.booking.reference}/change`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { seats: [{ passengerId: v.passengers[0].id, seatNo: 'C4' }] } });
      expect(late.body.code).toBe('CHANGE_DEADLINE_PASSED');
      await assertNoDoubleSale(c, w.tripId);
    });
  });

  describe('Annulation d\'un voyage', () => {
    it('toutes les réservations sont annulées et intégralement remboursées, les passagers prévenus, les sièges fermés', async () => {
      const w = await world(c, admin, { from: 'Toliara', to: 'Sakaraha', layout: 'minibus16', price: 10000 });
      const a = await purchase(c, w.tripId, ['A1', 'A2']);
      const b = await purchase(c, w.tripId, ['B1']);
      const h = await hold(c, w.tripId, ['C1']);
      const unpaid = await book(c, w.tripId, h.body.token, ['C1']);
      const r = await c.api('POST', `/admin/trips/${w.tripId}/cancel`, { token: admin, body: { reason: 'Panne du véhicule' } });
      expect(r.body).toEqual({ cancelledBookings: 3, confirmedBookings: 2, refundedAmount: 34000 });   // frais de service compris
      for (const x of [a, b]) {
        const v = await getBooking(c, x.booking);
        expect(v).toMatchObject({ status: 'cancelled', cancelReason: 'trip_cancelled' });
        expect(v.payment.refundPendingAmount).toBe(v.total);
      }
      expect((await getBooking(c, unpaid.body)).status).toBe('cancelled');
      expect(await seatRows(c, w.tripId)).toEqual([]);
      const mails = await c.db.q<any>(`SELECT vars FROM notifications_outbox WHERE template = 'trip_cancelled' ORDER BY created_at`);
      expect(mails).toHaveLength(2);
      expect(mails[0].vars.cancel_reason).toBe('Panne du véhicule');
      // plus rien n'est vendable sur ce voyage
      expect((await hold(c, w.tripId, ['D1'])).body.code).toBe('TRIP_CANCELLED');
      expect((await c.api('GET', `/search?from=Toliara&to=Sakaraha&date=${day(2)}`)).body.status).toBe('no_trips');
      expect((await pay(c, unpaid.body)).body.code).toBe('BOOKING_EXPIRED');
      expect((await c.api('POST', `/admin/trips/${w.tripId}/cancel`, { token: admin, body: { reason: 'encore' } })).body.code).toBe('TRIP_ALREADY_CANCELLED');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds')).n).toBeGreaterThanOrEqual(2);
      // le créneau du véhicule est libéré : un voyage de remplacement peut être créé
      expect((await c.api('POST', '/admin/trips', { token: admin, body: { routeId: w.route.id, vehicleId: w.vehicle.id, date: day(2), departureTime: '08:00' } })).status).toBe(201);
    });
    it('un voyage commencé ne peut plus être annulé', async () => {
      const w = await world(c, admin, { from: 'Morondava', to: 'Miandrivazo' });
      await c.db.q(`UPDATE trips SET status = 'in_progress' WHERE id = $1`, [w.tripId]);
      expect((await c.api('POST', `/admin/trips/${w.tripId}/cancel`, { token: admin, body: { reason: 'x' } })).body.code).toBe('TRIP_ALREADY_STARTED');
    });
  });

  describe('Remplacement du véhicule (plan de sièges différent)', () => {
    it('bus 48 → minibus 16 : sièges communs conservés, les autres replacés, passagers prévenus', async () => {
      const w = await world(c, admin, { from: 'Antsirabe', to: 'Ambositra', layout: 'bus', price: 12000 });
      const keep = await purchase(c, w.tripId, ['A1', 'B2']);      // existent dans le minibus
      const move = await purchase(c, w.tripId, ['H3', 'K4']);      // n'existent pas dans le minibus
      const webHold = await hold(c, w.tripId, ['C1']);
      const small = await vehicle(c, admin, 'minibus16');
      const r = await c.api('POST', `/admin/trips/${w.tripId}/replace-vehicle`, { token: admin, body: { vehicleId: small.id } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ kept: 2, droppedHolds: 1, unseated: [] });
      expect(r.body.moved.map((m: any) => m.from).sort()).toEqual(['H3', 'K4']);
      const kv = await getBooking(c, keep.booking), mv = await getBooking(c, move.booking);
      expect(kv.seats).toEqual(['A1', 'B2']);
      expect(mv.status).toBe('confirmed');
      const valid = new Set((await c.api('GET', `/trips/${w.tripId}/seats`)).body.layout.rows.flatMap((x: any) => x.seats));
      expect(mv.seats.every((s: string) => valid.has(s))).toBe(true);
      expect(new Set([...kv.seats, ...mv.seats]).size).toBe(4);
      expect((await c.api('GET', `/trips/${w.tripId}/seats`)).body.layout.code).toBe('minibus16');
      const mail = await c.db.one<any>(`SELECT vars, attach_booking_id FROM notifications_outbox WHERE template = 'seat_changed'`);
      expect(mail.vars.reference).toBe(move.booking.reference);
      expect(mail.vars.changes).toMatch(/H3 → /);
      expect(mail.attachBookingId).toBe(move.booking.id);          // nouveau billet joint
      // le client qui était en train de choisir doit recommencer
      expect((await c.api('PATCH', `/trips/${w.tripId}/holds`, { body: { holdToken: webHold.body.token } })).body.code).toBe('HOLD_EXPIRED');
      await assertNoDoubleSale(c, w.tripId);
    });
    it('véhicule trop petit : les passagers sans siège sont signalés « à traiter », jamais supprimés en silence', async () => {
      const w = await world(c, admin, { from: 'Ambositra', to: 'Ambohimahasoa', layout: 'minibus16' });
      const all = ['F1', 'F2', 'A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];
      const guichet = await staff(c, admin, 'employe');
      const sale = await walkin(c, guichet.token, w.tripId, all);
      expect(sale.status).toBe(201);
      const tiny = await vehicle(c, admin, 'minibus10');
      const r = await c.api('POST', `/admin/trips/${w.tripId}/replace-vehicle`, { token: admin, body: { vehicleId: tiny.id } });
      expect(r.body.kept + r.body.moved.length).toBe(10);
      expect(r.body.unseated).toHaveLength(2);
      const v = await c.api('GET', `/admin/bookings/${sale.body.booking.id}`, { token: admin });
      expect(v.body.needsAttention).toBe(true);
      expect(v.body.attentionNote).toMatch(/plus de siège/);
      expect((await c.api('GET', '/admin/bookings?attention=true', { token: admin })).body.total).toBe(1);
      expect((await seatRows(c, w.tripId)).filter(s => s.status === 'booked')).toHaveLength(10);
      expect((await c.api('POST', `/admin/bookings/${sale.body.booking.id}/resolve`, { token: admin })).body.needsAttention).toBe(false);
    });
    it('véhicule déjà pris sur le créneau, en maintenance ou inconnu : refus, rien ne change', async () => {
      const w = await world(c, admin, { from: 'Ihosy', to: 'Ranohira', layout: 'minibus16' });
      const p = await purchase(c, w.tripId, ['A1']);
      const busy = await vehicle(c, admin, 'minibus16');
      await trip(c, admin, { routeId: w.route.id, vehicleId: busy.id, time: '09:00' });           // chevauche 08:00–11:00
      const r = await c.api('POST', `/admin/trips/${w.tripId}/replace-vehicle`, { token: admin, body: { vehicleId: busy.id } });
      expect([r.status, r.body.code]).toEqual([409, 'VEHICLE_SCHEDULE_CONFLICT']);
      const broken = await vehicle(c, admin, 'minibus16');
      await c.api('PATCH', `/admin/vehicles/${broken.id}`, { token: admin, body: { status: 'maintenance' } });
      expect((await c.api('POST', `/admin/trips/${w.tripId}/replace-vehicle`, { token: admin, body: { vehicleId: broken.id } })).body.code).toBe('VEHICLE_UNAVAILABLE');
      expect((await c.api('POST', `/admin/trips/${w.tripId}/replace-vehicle`, { token: admin, body: { vehicleId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
      expect((await getBooking(c, p.booking)).trip.vehicleId).toBe(w.vehicle.id);
      expect((await seatRows(c, w.tripId)).map(s => s.seatNo)).toEqual(['A1']);
    });
  });

  describe('Itinéraire suspendu, chauffeur absent', () => {
    it('suspension : ventes fermées, billets déjà vendus conservés ; réactivation : ventes rouvertes', async () => {
      const w = await world(c, admin, { from: 'Antsiranana', to: 'Ambilobe', layout: 'minibus16' });
      const p = await purchase(c, w.tripId, ['A1']);
      const h = await hold(c, w.tripId, ['A2']);
      const pendingBooking = await book(c, w.tripId, h.body.token, ['A2']);
      const s = await c.api('POST', `/admin/routes/${w.route.id}/suspend`, { token: admin, body: { reason: 'Pont effondré', until: day(10) } });
      expect(s.status).toBe(200);
      const search = await c.api('GET', `/search?from=Antsiranana&to=Ambilobe&date=${day(2)}`);
      expect(search.body).toMatchObject({ status: 'suspended', reason: 'Pont effondré', until: day(10), slots: [] });
      expect((await hold(c, w.tripId, ['A3'])).body.code).toBe('ROUTE_SUSPENDED');
      expect((await c.api('GET', '/cities')).body).not.toContain('Ambilobe');
      expect((await getBooking(c, p.booking)).status).toBe('confirmed');                          // le billet vendu reste valable
      expect((await c.db.one<any>('SELECT status FROM trips WHERE id = $1', [w.tripId])).status).toBe('scheduled');
      // un paiement lancé juste avant la suspension est honoré (le siège était retenu)
      const pp = await pay(c, pendingBooking.body);
      expect(pp.status).toBe(200);
      expect(await settle(c, pp.body.id)).toBe('confirmed');
      expect((await c.api('POST', `/admin/routes/${w.route.id}/reactivate`, { token: admin })).status).toBe(200);
      expect((await hold(c, w.tripId, ['A3'])).status).toBe(200);
    });
    it('fin de suspension automatique à la date prévue', async () => {
      const w = await world(c, admin, { from: 'Farafangana', to: 'Vangaindrano' });
      await c.api('POST', `/admin/routes/${w.route.id}/suspend`, { token: admin, body: { reason: 'Cyclone', until: day(3) } });
      await c.db.q(`UPDATE routes SET suspended_until = $2 WHERE id = $1`, [w.route.id, day(-1)]);
      await c.scheduler.runJob('generate-trips');
      expect((await c.db.one<any>('SELECT status, suspend_reason FROM routes WHERE id = $1', [w.route.id]))).toEqual({ status: 'active', suspendReason: null });
    });
    it('chauffeur en congé : alerte sur ses voyages, les voyages restent vendus et les passagers ne sont pas impactés', async () => {
      const d = await c.api('POST', '/admin/drivers', { token: admin, body: { firstName: 'Fidy', lastName: 'Rakotobe', phone: '0341010101', licenseNumber: 'PERMIS-001' } });
      expect(d.status).toBe(201);
      const v = await vehicle(c, admin, 'minibus16');
      const r = await route(c, admin, 'Moramanga', 'Ambatondrazaka', 14000, 240);
      const t = await trip(c, admin, { routeId: r.id, vehicleId: v.id, driverId: d.body.id });
      const p = await purchase(c, t.id, ['A1']);
      const up = await c.api('PATCH', `/admin/drivers/${d.body.id}`, { token: admin, body: { status: 'leave', leaveUntil: day(7), leaveReason: 'Maladie' } });
      expect(up.status).toBe(200);
      expect(up.body.affectedTrips.map((x: any) => x.id)).toEqual([t.id]);
      const tv = await c.api('GET', `/admin/trips/${t.id}`, { token: admin });
      expect(tv.body).toMatchObject({ status: 'scheduled', driverStatus: 'leave', driverName: 'Fidy Rakotobe' });
      expect((await getBooking(c, p.booking)).status).toBe('confirmed');
      expect((await hold(c, t.id, ['A2'])).status).toBe(200);                                     // toujours en vente
      // réaffectation d'un autre chauffeur
      const d2 = await c.api('POST', '/admin/drivers', { token: admin, body: { firstName: 'Solo', lastName: 'Rabe', phone: '0342020202', licenseNumber: 'PERMIS-002' } });
      const ch = await c.api('PATCH', `/admin/trips/${t.id}`, { token: admin, body: { driverId: d2.body.id } });
      expect(ch.body.driverName).toBe('Solo Rabe');
      // retour de congé automatique
      await c.db.q('UPDATE drivers SET leave_until = $2 WHERE id = $1', [d.body.id, day(-1)]);
      await c.scheduler.runJob('generate-trips');
      expect((await c.db.one<any>('SELECT status FROM drivers WHERE id = $1', [d.body.id])).status).toBe('active');
    });
    it('planning chauffeur : un chauffeur ne voit que ses propres voyages', async () => {
      const acc = await staff(c, admin, 'chauffeur', 'fidy@test.local');
      const d = await c.api('POST', '/admin/drivers', { token: admin, body: { firstName: 'Fidy', lastName: 'Compte', phone: '0343030303', licenseNumber: 'PERMIS-003', userId: acc.id } });
      const v = await vehicle(c, admin, 'minibus16');
      const r = await route(c, admin, 'Ambanja', 'Ambilobe-Nord', 9000, 120);
      const mine = await trip(c, admin, { routeId: r.id, vehicleId: v.id, driverId: d.body.id });
      const sched = await c.api('GET', '/admin/driver-schedule', { token: acc.token });
      expect(sched.body.driver.id).toBe(d.body.id);
      expect(sched.body.trips.map((t: any) => t.id)).toEqual([mine.id]);
      expect((await c.api('GET', '/admin/trips', { token: acc.token })).status).toBe(403);
    });
  });

  describe('Voyages programmés, récurrence et conflits de véhicule', () => {
    it('modèle quotidien : génère un voyage par jour sur l\'horizon de vente, sans doublon si on régénère', async () => {
      const v = await vehicle(c, admin, 'minibus16');
      const r = await route(c, admin, 'Tsiroanomandidy', 'Maintirano', 30000, 300);
      const t = await c.api('POST', '/admin/trip-templates', { token: admin, body: { routeId: r.id, vehicleId: v.id, departureTime: '06:00', recurrence: 'daily', startDate: day(1), endDate: day(10) } });
      expect(t.status).toBe(201);
      expect(t.body.generation.created).toBe(10);
      const again = await c.api('POST', '/admin/trips/generate', { token: admin });
      expect(again.body.created).toBe(0);
      const rows = await c.db.q<any>('SELECT service_date, price FROM trips WHERE template_id = $1 ORDER BY service_date', [t.body.id]);
      expect(rows.map(x => x.serviceDate)).toEqual(Array.from({ length: 10 }, (_, i) => day(i + 1)));
      expect(rows.every(x => x.price === 30000)).toBe(true);
    });
    it('jours ouvrés uniquement, tarif propre au type de véhicule', async () => {
      const v = await vehicle(c, admin, 'minibus10');
      const r = await c.api('POST', '/admin/routes', { token: admin, body: { fromCity: 'Nosy Be', toCity: 'Ankify', durationMin: 90, basePrice: 20000, priceByLayout: { minibus10: 45000 }, durationByLayout: { minibus10: 60 } } });
      const t = await c.api('POST', '/admin/trip-templates', { token: admin, body: { routeId: r.body.id, vehicleId: v.id, departureTime: '09:00', recurrence: 'weekdays', startDate: day(1), endDate: day(14) } });
      const rows = await c.db.q<any>('SELECT service_date, price, departure_at, arrival_at FROM trips WHERE template_id = $1', [t.body.id]);
      expect(rows.length).toBe(10);
      for (const x of rows) {
        expect([6, 7]).not.toContain(DateTime.fromISO(x.serviceDate).weekday);
        expect(x.price).toBe(45000);
        expect(new Date(x.arrivalAt).getTime() - new Date(x.departureAt).getTime()).toBe(60 * 60000);
      }
    });
    it('un véhicule ne peut pas faire deux voyages qui se chevauchent (garanti par la base)', async () => {
      const v = await vehicle(c, admin, 'minibus16');
      const r = await route(c, admin, 'Vohemar', 'Iharana', 8000, 180);
      const a = await trip(c, admin, { routeId: r.id, vehicleId: v.id, time: '08:00' });             // 08:00 → 11:00
      for (const time of ['08:00', '10:59', '06:00']) {
        const clash = await c.api('POST', '/admin/trips', { token: admin, body: { routeId: r.id, vehicleId: v.id, date: day(2), departureTime: time } });
        expect([time, clash.status, clash.body.code]).toEqual([time, 409, 'VEHICLE_SCHEDULE_CONFLICT']);
      }
      expect((await c.api('POST', '/admin/trips', { token: admin, body: { routeId: r.id, vehicleId: v.id, date: day(2), departureTime: '11:00' } })).status).toBe(201);   // dos à dos : autorisé
      // insertion directe en base : la contrainte d'exclusion refuse aussi
      await expect(c.db.q(`INSERT INTO trips (route_id, vehicle_id, layout_id, service_date, departure_at, arrival_at, price) SELECT route_id, vehicle_id, layout_id, service_date, departure_at + interval '30 minutes', arrival_at, price FROM trips WHERE id = $1`, [a.id]))
        .rejects.toMatchObject({ code: '23P01' });
    });
    it('voyage de nuit qui passe minuit : rattaché à la date de départ, le véhicule est bloqué jusqu\'à l\'arrivée le lendemain', async () => {
      const v = await vehicle(c, admin, 'bus');
      const r = await route(c, admin, 'Antananarivo-Nuit', 'Toliara-Nuit', 55000, 510);          // 8 h 30
      const t = await trip(c, admin, { routeId: r.id, vehicleId: v.id, date: day(4), time: '21:00' });
      expect(t.serviceDate).toBe(day(4));
      const s = await c.api('GET', `/search?from=Antananarivo-Nuit&to=Toliara-Nuit&date=${day(4)}`);
      expect(s.body.slots[0]).toMatchObject({ departure: '21:00', arrival: '05:30', arrivalDate: day(5), duration: '8h30', serviceDate: day(4) });
      expect((await c.api('GET', `/search?from=Antananarivo-Nuit&to=Toliara-Nuit&date=${day(5)}`)).body.status).toBe('no_trips');   // pas de doublon le lendemain
      const dep = DateTime.fromISO(t.departureAt, { zone: ZONE });
      expect(dep.toFormat('yyyy-MM-dd HH:mm')).toBe(`${day(4)} 21:00`);
      expect(new Date(t.departureAt).toISOString()).toBe(DateTime.fromISO(`${day(4)}T21:00`, { zone: ZONE }).toUTC().toISO());   // stocké en UTC (18:00Z)
      const early = await c.api('POST', '/admin/trips', { token: admin, body: { routeId: r.id, vehicleId: v.id, date: day(5), departureTime: '04:00' } });
      expect(early.body.code).toBe('VEHICLE_SCHEDULE_CONFLICT');
      expect((await c.api('POST', '/admin/trips', { token: admin, body: { routeId: r.id, vehicleId: v.id, date: day(5), departureTime: '06:00' } })).status).toBe(201);
      const p = await purchase(c, t.id, ['A1']);
      const mail = await c.db.one<any>(`SELECT vars FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1`, [p.booking.reference]);
      expect(mail.vars).toMatchObject({ date: day(4), departure_time: '21:00' });
    });
    it('modification d\'un modèle : les voyages déjà vendus sont conservés, les autres recréés', async () => {
      const v = await vehicle(c, admin, 'minibus16');
      const r = await route(c, admin, 'Betioky', 'Ampanihy', 11000, 120);
      const t = await c.api('POST', '/admin/trip-templates', { token: admin, body: { routeId: r.id, vehicleId: v.id, departureTime: '07:00', recurrence: 'daily', startDate: day(1), endDate: day(5) } });
      const sold = await c.db.one<any>('SELECT id FROM trips WHERE template_id = $1 AND service_date = $2', [t.body.id, day(3)]);
      const p = await purchase(c, sold.id, ['A1']);
      const up = await c.api('PATCH', `/admin/trip-templates/${t.body.id}`, { token: admin, body: { departureTime: '09:30', price: 13000 } });
      expect(up.status).toBe(200);
      expect(up.body.keptSoldTrips).toBe(1);
      const rows = await c.db.q<any>(`SELECT service_date, price, to_char(departure_at AT TIME ZONE 'Indian/Antananarivo', 'HH24:MI') AS dep FROM trips WHERE template_id = $1 ORDER BY service_date`, [t.body.id]);
      expect(rows.find(x => x.serviceDate === day(3))).toMatchObject({ dep: '07:00', price: 11000 });   // le billet vendu garde son horaire
      expect(rows.filter(x => x.serviceDate !== day(3)).every(x => x.dep === '09:30' && x.price === 13000)).toBe(true);
      expect((await getBooking(c, p.booking)).trip.departure).toBe('07:00');
      // arrêt du modèle : les voyages vendus restent, les autres disparaissent
      const stop = await c.api('POST', `/admin/trip-templates/${t.body.id}/cancel`, { token: admin, body: { reason: 'ligne arrêtée' } });
      expect(stop.body.soldTrips.map((x: any) => x.serviceDate)).toEqual([day(3)]);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM trips WHERE template_id = $1 AND status = 'scheduled'`, [t.body.id])).n).toBe(1);
      // suppression du modèle : le voyage vendu et son billet survivent (l'historique n'est jamais effacé)
      expect((await c.api('DELETE', `/admin/trip-templates/${t.body.id}`, { token: admin })).status).toBe(204);
      expect((await c.db.one<any>('SELECT template_id, status FROM trips WHERE id = $1', [sold.id]))).toEqual({ templateId: null, status: 'scheduled' });
      expect((await getBooking(c, p.booking)).status).toBe('confirmed');
    });
    it('véhicule en maintenance : pas de nouveaux voyages générés, conflit signalé', async () => {
      const v = await vehicle(c, admin, 'minibus16');
      const r = await route(c, admin, 'Mananjary', 'Nosy Varika', 7000, 90);
      await c.api('PATCH', `/admin/vehicles/${v.id}`, { token: admin, body: { status: 'maintenance', maintenanceNote: 'Freins' } });
      const t = await c.api('POST', '/admin/trip-templates', { token: admin, body: { routeId: r.id, vehicleId: v.id, departureTime: '07:00', recurrence: 'daily', startDate: day(1), endDate: day(3) } });
      expect(t.body.generation.created).toBe(0);
      expect(t.body.generation.conflicts.every((x: any) => x.reason === 'VEHICLE_UNAVAILABLE')).toBe(true);
    });
  });

  describe('Absence (no-show) et clôture des voyages', () => {
    it('no-show marqué au guichet : pas de remboursement par défaut', async () => {
      const w = await world(c, admin, { from: 'Maroantsetra', to: 'Mananara' });
      const p = await purchase(c, w.tripId, ['A1', 'A2']);
      const v = await getBooking(c, p.booking);
      const one = await c.api('POST', `/admin/bookings/${p.booking.id}/no-show`, { token: admin, body: { passengerIds: [v.passengers[0].id] } });
      expect(one.body.status).toBe('confirmed');
      expect(one.body.passengers.map((x: any) => x.status)).toEqual(['no_show', 'active']);
      const all = await c.api('POST', `/admin/bookings/${p.booking.id}/no-show`, { token: admin, body: {} });
      expect(all.body.status).toBe('no_show');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1', [p.booking.id])).n).toBe(0);
    });
    it('clôture automatique : départ → en cours (verrous supprimés), arrivée → terminé, réservations terminées', async () => {
      const w = await world(c, admin, { from: 'Ambovombe', to: 'Tsihombe' });
      const p = await purchase(c, w.tripId, ['A1']);
      await hold(c, w.tripId, ['A2']);
      await c.db.q(`UPDATE trips SET departure_at = now() - interval '1 minute', arrival_at = now() + interval '1 hour' WHERE id = $1`, [w.tripId]);
      expect(await c.bookings.closeTrips()).toMatchObject({ started: 1, completed: 0 });
      expect((await seatRows(c, w.tripId)).map(s => s.seatNo)).toEqual(['A1']);
      expect((await hold(c, w.tripId, ['A3'])).body.code).toBe('TRIP_NOT_ON_SALE');
      await c.db.q(`UPDATE trips SET arrival_at = now() - interval '1 second' WHERE id = $1`, [w.tripId]);
      expect(await c.bookings.closeTrips()).toMatchObject({ started: 0, completed: 1, noShows: 0 });
      expect((await getBooking(c, p.booking)).status).toBe('completed');
      expect(await c.bookings.closeTrips()).toEqual({ started: 0, completed: 0, noShows: 0 });   // rejouable sans effet
    });
    it('rappel avant le départ : envoyé une seule fois aux réservations confirmées', async () => {
      const w = await world(c, admin, { from: 'Bekily', to: 'Betroka' });
      const p = await purchase(c, w.tripId, ['A1']);
      await c.db.q(`UPDATE trips SET departure_at = now() + interval '2 hours', arrival_at = now() + interval '5 hours' WHERE id = $1`, [w.tripId]);
      await c.db.q(`UPDATE trips SET reminder_sent_at = now() WHERE id <> $1`, [w.tripId]);   // les autres voyages de ce fichier ne comptent pas
      expect(await c.scheduler.runJob('trip-reminders')).toBe(1);
      expect(await c.scheduler.runJob('trip-reminders')).toBe(0);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'trip_reminder' AND vars->>'reference' = $1`, [p.booking.reference])).n).toBe(1);
    });
  });
});
