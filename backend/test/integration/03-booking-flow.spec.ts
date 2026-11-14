import { CONTACT, Ctx, assertNoDoubleSale, book, boot, customer, day, getBooking, hold, key, pax, pay, purchase, seatRows, settle, setup, staff, trip, vehicle, route, world } from '../helpers';
import { qrPayload } from '../../src/modules/tickets/tickets.service';

describe('Parcours de réservation', () => {
  let c: Ctx, admin: string, w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { c = await boot(); admin = await setup(c); w = await world(c, admin, { layout: 'minibus16', price: 15000 }); });
  afterAll(async () => { await c.close(); });

  describe('Recherche', () => {
    it('ne propose que des voyages réellement programmés (plus d\'horaires fictifs)', async () => {
      const r = await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=${day(2)}&passengers=2`);
      expect(r.body.status).toBe('available');
      expect(r.body.slots).toHaveLength(1);
      expect(r.body.slots[0]).toMatchObject({ tripId: w.tripId, departure: '08:00', arrival: '11:00', duration: '3h', price: 15000, capacity: 16, seatsAvailable: 16, vehicleLayout: 'minibus16' });
      const none = await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=${day(5)}`);
      expect(none.body).toMatchObject({ status: 'no_trips', slots: [] });
      const unknown = await c.api('GET', `/search?from=Antananarivo&to=Atlantide&date=${day(2)}`);
      expect(unknown.body.status).toBe('not_found');
    });
    it('la recherche est insensible à la casse et valide ses paramètres', async () => {
      expect((await c.api('GET', `/search?from=antananarivo&to=ANTSIRABE&date=${day(2)}`)).body.status).toBe('available');
      expect((await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=demain`)).status).toBe(400);
      expect((await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=${day(2)}&passengers=0`)).status).toBe(400);
      expect((await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=${day(2)}&passengers=7`)).body.code).toBe('TOO_MANY_PASSENGERS');
    });
    it('villes et itinéraires populaires viennent de la base', async () => {
      expect((await c.api('GET', '/cities')).body).toEqual(['Antananarivo', 'Antsirabe']);
      expect((await c.api('GET', '/routes/popular')).body[0]).toMatchObject({ fromCity: 'Antananarivo', toCity: 'Antsirabe', price: 15000 });
    });
    it('plan de sièges servi par le serveur', async () => {
      const m = await c.api('GET', `/trips/${w.tripId}/seats`);
      expect(m.body.layout.code).toBe('minibus16');
      expect(m.body.layout.rows.flatMap((r: any) => r.seats)).toHaveLength(16);
      expect(m.body.seats).toEqual([]);
      expect((await c.api('GET', '/trips/pas-un-uuid/seats')).status).toBe(400);
      expect((await c.api('GET', '/trips/00000000-0000-4000-8000-000000000000/seats')).status).toBe(404);
    });
  });

  describe('Verrou temporaire des sièges', () => {
    it('sélection : le siège passe « retenu » pour les autres, « à moi » pour son propriétaire', async () => {
      const h = await hold(c, w.tripId, ['A1', 'A2']);
      expect(h.status).toBe(200);
      expect(h.body.seats).toEqual(['A1', 'A2']);
      expect(h.body.extensionsLeft).toBe(1);
      const ttl = (new Date(h.body.expiresAt).getTime() - Date.now()) / 60000;
      expect(ttl).toBeGreaterThan(9.8); expect(ttl).toBeLessThanOrEqual(10);
      const others = (await c.api('GET', `/trips/${w.tripId}/seats`)).body;
      expect(others.seats.map((s: any) => [s.seat, s.status, s.mine])).toEqual([['A1', 'held', false], ['A2', 'held', false]]);
      const mine = (await c.api('GET', `/trips/${w.tripId}/seats?holdToken=${h.body.token}`)).body;
      expect(mine.seats.every((s: any) => s.mine)).toBe(true);
      expect(mine.hold.seats).toEqual(['A1', 'A2']);
      expect((await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=${day(2)}`)).body.slots[0].seatsAvailable).toBe(14);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('un autre client ne peut pas prendre un siège retenu ; tout ou rien sur une sélection multiple', async () => {
      const a = await hold(c, w.tripId, ['B1']);
      const b = await hold(c, w.tripId, ['B1', 'B2']);
      expect(b.status).toBe(409);
      expect(b.body).toMatchObject({ code: 'SEAT_TAKEN', details: { seats: ['B1'] } });
      expect((await seatRows(c, w.tripId)).map(r => r.seatNo)).toEqual(['B1']);   // B2 n'a pas été pris « à moitié »
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${a.body.token}`);
    });
    it('modifier sa sélection libère les sièges retirés et garde le même délai', async () => {
      const h1 = await hold(c, w.tripId, ['C1', 'C2']);
      const h2 = await hold(c, w.tripId, ['C2', 'C3'], h1.body.token);
      expect(h2.body.token).toBe(h1.body.token);
      expect(h2.body.expiresAt).toBe(h1.body.expiresAt);
      expect((await seatRows(c, w.tripId)).map(r => r.seatNo)).toEqual(['C2', 'C3']);
      expect((await hold(c, w.tripId, ['C1'])).status).toBe(200);   // C1 est de nouveau libre pour un autre
      const empty = await hold(c, w.tripId, [], h1.body.token);
      expect(empty.body.seats).toEqual([]);
      await c.db.q('DELETE FROM trip_seats WHERE trip_id = $1', [w.tripId]); await c.db.q('DELETE FROM seat_holds');
    });
    it('prolongation : une fois (paramétrable), puis refusée', async () => {
      const h = await hold(c, w.tripId, ['D1']);
      const e1 = await c.api('PATCH', `/trips/${w.tripId}/holds`, { body: { holdToken: h.body.token } });
      expect(e1.status).toBe(200);
      expect(new Date(e1.body.expiresAt).getTime() - new Date(h.body.expiresAt).getTime()).toBe(10 * 60000);
      expect(e1.body.extensionsLeft).toBe(0);
      const e2 = await c.api('PATCH', `/trips/${w.tripId}/holds`, { body: { holdToken: h.body.token } });
      expect([e2.status, e2.body.code]).toEqual([409, 'HOLD_EXTENSION_LIMIT']);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('abandon explicite et fermeture de page (sendBeacon) libèrent immédiatement', async () => {
      const a = await hold(c, w.tripId, ['D2']);
      expect((await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${a.body.token}`)).body.released).toEqual(['D2']);
      const b = await hold(c, w.tripId, ['D2']);
      expect((await c.api('POST', `/trips/${w.tripId}/holds/release?holdToken=${b.body.token}`)).body.released).toEqual(['D2']);
      expect(await seatRows(c, w.tripId)).toEqual([]);
      // rejouer la libération ne casse rien
      expect((await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${b.body.token}`)).body.released).toEqual([]);
    });
    it('expiration automatique : un verrou expiré est libre tout de suite, même avant le passage de la tâche de nettoyage', async () => {
      const a = await hold(c, w.tripId, ['D3']);
      await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second' WHERE hold_token = $1`, [a.body.token]);
      await c.db.q(`UPDATE seat_holds SET expires_at = now() - interval '1 second' WHERE token = $1`, [a.body.token]);
      expect((await c.api('GET', `/trips/${w.tripId}/seats`)).body.seats).toEqual([]);          // déjà affiché libre
      const b = await hold(c, w.tripId, ['D3']);                                                  // et déjà prenable
      expect(b.status).toBe(200);
      // l'ancien propriétaire ne peut plus rien faire avec son jeton périmé
      expect((await c.api('PATCH', `/trips/${w.tripId}/holds`, { body: { holdToken: a.body.token } })).body.code).toBe('HOLD_EXPIRED');
      expect((await book(c, w.tripId, a.body.token, ['D3'])).body.code).toBe('HOLD_EXPIRED');
      expect((await seatRows(c, w.tripId))[0].holdToken).toBe(b.body.token);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${b.body.token}`);
    });
    it('la tâche de nettoyage supprime les verrous expirés et seulement eux', async () => {
      const dead = await hold(c, w.tripId, ['D4']);
      const alive = await hold(c, w.tripId, ['F1']);
      await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '5 seconds' WHERE hold_token = $1`, [dead.body.token]);
      expect(await c.seats.sweepExpiredHolds()).toBe(1);
      expect((await seatRows(c, w.tripId)).map(r => r.seatNo)).toEqual(['F1']);
      expect(await c.seats.sweepExpiredHolds()).toBe(0);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${alive.body.token}`);
    });
    it('refuse un siège qui n\'existe pas dans ce véhicule et une sélection trop grande', async () => {
      expect((await hold(c, w.tripId, ['Z9'])).body.code).toBe('SEAT_UNKNOWN');
      expect((await hold(c, w.tripId, ['E1'])).body.code).toBe('SEAT_UNKNOWN');           // la rangée E n'existe que dans le bus 48 places
      expect((await hold(c, w.tripId, ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3'])).body.code).toBe('TOO_MANY_SEATS');
      expect((await hold(c, w.tripId, ["A1'; DROP TABLE trip_seats;--"])).status).toBe(400);
      expect(await seatRows(c, w.tripId)).toEqual([]);
    });
  });

  describe('Réservation et paiement', () => {
    it('parcours invité complet : le prix est calculé par le serveur, le billet est émis après paiement', async () => {
      const h = await hold(c, w.tripId, ['A1', 'A2']);
      const b = await book(c, w.tripId, h.body.token, ['A1', 'A2']);
      expect(b.status).toBe(201);
      expect(b.body).toMatchObject({ status: 'pending_payment', subtotal: 30000, serviceFee: 2000, total: 32000, currency: 'MGA', seats: ['A1', 'A2'], customerId: null });
      expect(b.body.reference).toMatch(/^TRA-[A-Z2-9]{7}$/);   // préfixe déduit du nom de la société « Trans Test »
      expect(b.body.payment.status).toBe('unpaid');
      expect(b.body.passengers.every((p: any) => p.ticketNumber === null)).toBe(true);   // pas de billet avant paiement

      const p = await pay(c, b.body);
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({ status: 'pending', simulated: true, amount: 32000, method: 'mvola' });
      expect(p.body.clientAction.type).toBe('ussd_push');
      expect((await getBooking(c, b.body)).status).toBe('pending_payment');              // rien n'est confirmé tant que l'opérateur n'a pas répondu
      expect(await settle(c, p.body.id)).toBe('confirmed');

      const v = await getBooking(c, b.body);
      expect(v).toMatchObject({ status: 'confirmed', expiresAt: null, canCancel: true });
      expect(v.payment).toMatchObject({ status: 'paid', method: 'mvola', paidAmount: 32000 });
      expect(v.passengers.map((x: any) => x.ticketNumber)).toEqual([`${v.reference}-1`, `${v.reference}-2`]);
      expect((await seatRows(c, w.tripId)).map(r => [r.seatNo, r.status, r.holdToken])).toEqual([['A1', 'booked', null], ['A2', 'booked', null]]);
      const mail = await c.db.one<any>(`SELECT recipient, attach_booking_id, vars FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1`, [v.reference]);
      expect(mail.recipient).toBe('clara@test.local');
      expect(mail.attachBookingId).toBe(v.id);
      expect(mail.vars).toMatchObject({ from: 'Antananarivo', to: 'Antsirabe', departure_time: '08:00', seats: 'A1, A2', total: 32000 });
      await assertNoDoubleSale(c, w.tripId);
    });
    it('le client ne peut pas imposer un prix, un statut ou un identifiant (champs inconnus refusés)', async () => {
      const h = await hold(c, w.tripId, ['A3']);
      const r = await c.api('POST', '/bookings', { headers: { 'idempotency-key': key() }, body: { tripId: w.tripId, holdToken: h.body.token, passengers: [pax('A3')], contact: CONTACT, total: 1, status: 'confirmed' } });
      expect(r.status).toBe(400);
      const r2 = await c.api('POST', '/bookings', { headers: { 'idempotency-key': key() }, body: { tripId: w.tripId, holdToken: h.body.token, passengers: [{ ...pax('A3'), price: 1 }], contact: CONTACT } });
      expect(r2.status).toBe(400);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('les passagers doivent correspondre exactement aux sièges retenus', async () => {
      const h = await hold(c, w.tripId, ['A3', 'A4']);
      expect((await book(c, w.tripId, h.body.token, ['A3'])).body.code).toBe('HOLD_MISMATCH');
      expect((await book(c, w.tripId, h.body.token, ['A3', 'B1'])).body.code).toBe('HOLD_MISMATCH');
      expect((await book(c, w.tripId, h.body.token, ['A3', 'A3'])).body.code).toBe('HOLD_MISMATCH');
      expect((await book(c, w.tripId, '00000000-0000-4000-8000-000000000000', ['A3', 'A4'])).body.code).toBe('HOLD_EXPIRED');
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('retour en arrière puis nouvelle validation : l\'ancienne réservation en attente est remplacée, pas dupliquée', async () => {
      const h = await hold(c, w.tripId, ['B1']);
      const b1 = await book(c, w.tripId, h.body.token, ['B1']);
      const b2 = await book(c, w.tripId, h.body.token, ['B1'], { contact: { ...CONTACT, name: 'Nom Corrigé' } });
      expect(b2.status).toBe(201);
      expect(b2.body.reference).not.toBe(b1.body.reference);
      expect((await getBooking(c, b1.body)).status).toBe('cancelled');
      const rows = await seatRows(c, w.tripId);
      expect(rows.find(r => r.seatNo === 'B1').bookingId).toBe(b2.body.id);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
      expect((await getBooking(c, b2.body)).status).toBe('cancelled');   // abandon : sièges rendus, réservation annulée
      expect((await seatRows(c, w.tripId)).some(r => r.seatNo === 'B1')).toBe(false);
    });
    it('client connecté : la réservation est rattachée à son compte et apparaît dans son historique', async () => {
      const u = await customer(c, 'histo@test.local', '0349990001');
      const p = await purchase(c, w.tripId, ['B2'], { token: u.token });
      expect(p.booking.customerId).toBe(u.user.id);
      const mine = await c.api('GET', '/bookings/mine', { token: u.token });
      expect(mine.body.total).toBe(1);
      expect(mine.body.items[0]).toMatchObject({ reference: p.booking.reference, status: 'confirmed' });
      const other = await customer(c);
      expect((await c.api('GET', '/bookings/mine', { token: other.token })).body.total).toBe(0);
    });
    it('réservation faite en invité rattachée au compte créé ensuite avec le même e-mail', async () => {
      const p = await purchase(c, w.tripId, ['B3'], { contact: { name: 'Futur Client', phone: '0348880002', email: 'futur@test.local' } });
      const u = await customer(c, 'futur@test.local', '0348880002');
      const mine = await c.api('GET', '/bookings/mine', { token: u.token });
      expect(mine.body.items.map((b: any) => b.reference)).toEqual([p.booking.reference]);
    });
    it('paiement refusé par l\'opérateur : la réservation reste payable, un nouvel essai réussit', async () => {
      const h = await hold(c, w.tripId, ['C1']);
      const b = await book(c, w.tripId, h.body.token, ['C1']);
      const p1 = await pay(c, b.body, { phone: '0340000000' });   // numéro se terminant par 0000 → refus simulé
      expect(await settle(c, p1.body.id)).toBe('failed');
      const v = await getBooking(c, b.body);
      expect(v.status).toBe('pending_payment');
      expect(v.payment).toMatchObject({ status: 'unpaid', lastPaymentStatus: 'failed' });
      expect((await seatRows(c, w.tripId)).find(r => r.seatNo === 'C1').status).toBe('held');   // le siège reste réservé au client pour réessayer
      const p2 = await pay(c, b.body, { method: 'orange_money' });
      expect(p2.body.id).not.toBe(p1.body.id);
      expect(await settle(c, p2.body.id)).toBe('confirmed');
      expect((await getBooking(c, b.body)).payment).toMatchObject({ status: 'paid', method: 'orange_money' });
    });
    it('le lancement du paiement prolonge le verrou : le siège ne peut pas être repris pendant la validation sur le téléphone', async () => {
      const h = await hold(c, w.tripId, ['C2']);
      const b = await book(c, w.tripId, h.body.token, ['C2']);
      await c.db.q(`UPDATE bookings SET expires_at = now() + interval '20 seconds' WHERE id = $1`, [b.body.id]);
      await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() + interval '20 seconds' WHERE booking_id = $1`, [b.body.id]);
      const p = await pay(c, b.body);
      const row = await c.db.one<any>(`SELECT extract(epoch from hold_expires_at - now()) AS s FROM trip_seats WHERE booking_id = $1`, [b.body.id]);
      expect(Number(row.s)).toBeGreaterThan(290);   // 5 minutes de délai de paiement
      expect((await hold(c, w.tripId, ['C2'])).body.code).toBe('SEAT_TAKEN');
      expect((await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`)).body.released).toEqual([]);   // un abandon pendant le paiement ne libère pas le siège
      expect(await settle(c, p.body.id)).toBe('confirmed');
    });
    it('moyen de paiement désactivé, inconnu ou réservé au guichet : refusé', async () => {
      const h = await hold(c, w.tripId, ['C3']);
      const b = await book(c, w.tripId, h.body.token, ['C3']);
      for (const method of ['airtel_money', 'cash', 'bitcoin']) expect((await pay(c, b.body, { method })).body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payments WHERE booking_id = $1', [b.body.id])).n).toBe(0);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('réservation déjà payée ou expirée : aucun nouveau paiement possible', async () => {
      const p = await purchase(c, w.tripId, ['D1']);
      expect((await pay(c, p.booking)).body.code).toBe('BOOKING_ALREADY_PAID');
      const h = await hold(c, w.tripId, ['D2']);
      const b = await book(c, w.tripId, h.body.token, ['D2']);
      await c.db.q(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.body.id]);
      expect((await pay(c, b.body)).body.code).toBe('BOOKING_EXPIRED');
      await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second' WHERE booking_id = $1`, [b.body.id]);
      expect(await c.bookings.expirePending()).toBe(1);
      await c.seats.sweepExpiredHolds();
      expect((await getBooking(c, b.body)).status).toBe('expired');
      expect((await seatRows(c, w.tripId)).some(r => r.seatNo === 'D2')).toBe(false);
    });
  });

  describe('Accès à une réservation', () => {
    let p: Awaited<ReturnType<typeof purchase>>;
    beforeAll(async () => { p = await purchase(c, w.tripId, ['D3'], { contact: { name: 'Secret Client', phone: '+261 34 55 666 77', email: 'secret@test.local' } }); });
    it('sans jeton, avec un mauvais jeton ou depuis un autre compte : 404 (pas d\'énumération des références)', async () => {
      const other = await customer(c);
      expect((await c.api('GET', `/bookings/${p.booking.reference}`)).status).toBe(404);
      expect((await c.api('GET', `/bookings/${p.booking.reference}`, { headers: { 'x-booking-token': 'x'.repeat(32) } })).status).toBe(404);
      expect((await c.api('GET', `/bookings/${p.booking.reference}`, { token: other.token })).status).toBe(404);
      expect((await c.api('GET', `/bookings/TRA-INCONNU`)).status).toBe(404);
      expect((await c.api('GET', `/bookings/${p.booking.reference}/ticket.pdf`)).status).toBe(404);
      expect((await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { body: {} })).status).toBe(404);
    });
    it('« retrouver mon billet » : référence + téléphone de contact, quel que soit le format du numéro', async () => {
      const ok = await c.api('POST', '/bookings/lookup', { body: { reference: p.booking.reference.toLowerCase(), phone: '034 55 666 77' } });
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toBe(p.booking.accessToken);
      expect((await c.api('POST', '/bookings/lookup', { body: { reference: p.booking.reference, phone: '0340000000' } })).status).toBe(404);
    });
    it('billet PDF généré par le serveur, avec le nom de la société configurée', async () => {
      const r = await c.api('GET', `/bookings/${p.booking.reference}/ticket.pdf?t=${p.booking.accessToken}`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(r.raw.subarray(0, 5).toString()).toBe('%PDF-');
      expect(r.raw.length).toBeGreaterThan(3000);
      const { execFileSync } = require('child_process');
      require('fs').writeFileSync('/tmp/bb-ticket-test.pdf', r.raw);
      let text = '';
      try { text = execFileSync('pdftotext', ['-layout', '/tmp/bb-ticket-test.pdf', '-']).toString(); } catch { return; }   // pdftotext absent : contrôle du contenu ignoré
      expect(text).toContain('Trans Test');
      expect(text).toContain(p.booking.reference);
      expect(text).toContain('Antananarivo');
      expect(text).toContain('D3');
      expect(text.toLowerCase()).not.toContain('soatrans');
    });
    it('QR codes générés par le serveur (plus de service externe)', async () => {
      const r = await c.api('GET', `/bookings/${p.booking.reference}/qr`, { headers: { 'x-booking-token': p.booking.accessToken } });
      expect(r.body).toHaveLength(1);
      expect(r.body[0]).toMatchObject({ ticketNumber: `${p.booking.reference}-1`, seatNo: 'D3' });
      expect(r.body[0].qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    });
    it('renvoi du billet par e-mail à une autre adresse', async () => {
      const r = await c.api('POST', `/bookings/${p.booking.reference}/resend`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { email: 'autre@test.local' } });
      expect(r.status).toBe(202);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE recipient = 'autre@test.local' AND attach_booking_id = $1`, [p.booking.id])).n).toBe(1);
    });
  });

  describe('Contrôle des billets à l\'embarquement', () => {
    it('billet valide → embarqué ; second scan → déjà utilisé ; faux QR → rejeté', async () => {
      const guichet = await staff(c, admin, 'employe');
      const p = await purchase(c, w.tripId, ['D4']);
      const ticket = `${p.booking.reference}-1`;
      const qr = qrPayload(ticket, 'signed');
      const v = await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code: qr, tripId: w.tripId } });
      expect(v.body).toMatchObject({ valid: true, reason: 'OK', seatNo: 'D4', fromCity: 'Antananarivo' });
      const b1 = await c.api('POST', '/tickets/board', { token: guichet.token, body: { code: qr } });
      expect(b1.body).toMatchObject({ valid: true, status: 'boarded' });
      const b2 = await c.api('POST', '/tickets/board', { token: guichet.token, body: { code: qr } });
      expect(b2.body).toMatchObject({ valid: false, reason: 'ALREADY_BOARDED' });
      const forged = qr.slice(0, -3) + 'AAA';
      expect((await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code: forged } })).body).toMatchObject({ valid: false, reason: 'FORGED' });
      expect((await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code: 'TRA-ZZZZZZZ-1' } })).body.reason).toBe('UNKNOWN');
      expect((await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code: ticket.toLowerCase() } })).body.reason).toBe('ALREADY_BOARDED');   // saisie manuelle du numéro
    });
    it('billet d\'un autre départ, billet annulé, réservation non payée', async () => {
      const guichet = await staff(c, admin, 'employe');
      const v2 = await vehicle(c, admin, 'minibus10');
      const t2 = await trip(c, admin, { routeId: w.route.id, vehicleId: v2.id, time: '15:00' });
      const p = await purchase(c, t2.id, ['A1', 'A2']);
      const code = qrPayload(`${p.booking.reference}-1`, 'signed');
      expect((await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code, tripId: w.tripId } })).body.reason).toBe('WRONG_TRIP');
      const paxId = (await getBooking(c, p.booking)).passengers[0].id;
      await c.api('POST', `/bookings/${p.booking.reference}/cancel`, { headers: { 'x-booking-token': p.booking.accessToken }, body: { passengerIds: [paxId] } });
      expect((await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code } })).body.reason).toBe('CANCELLED');
      expect((await c.api('POST', '/tickets/verify', { token: guichet.token, body: { code: qrPayload(`${p.booking.reference}-2`, 'signed') } })).body.valid).toBe(true);
    });
    it('un client ne peut pas valider des billets', async () => {
      const u = await customer(c);
      expect((await c.api('POST', '/tickets/board', { token: u.token, body: { code: 'TRA-AAAAAAA-1' } })).status).toBe(403);
      expect((await c.api('POST', '/tickets/board', { body: { code: 'TRA-AAAAAAA-1' } })).status).toBe(401);
    });
  });

  describe('Règles de vente', () => {
    it('vente en ligne fermée 30 min avant le départ ; le guichet vend jusqu\'au départ', async () => {
      const v = await vehicle(c, admin, 'minibus10');
      const r = await route(c, admin, 'Toamasina', 'Fenoarivo', 9000, 60);
      const t = await trip(c, admin, { routeId: r.id, vehicleId: v.id, date: day(1), time: '10:00' });
      await c.db.q(`UPDATE trips SET departure_at = now() + interval '20 minutes', arrival_at = now() + interval '80 minutes', service_date = (now() AT TIME ZONE 'Indian/Antananarivo')::date WHERE id = $1`, [t.id]);
      const today = (await c.db.one<any>(`SELECT service_date FROM trips WHERE id = $1`, [t.id])).serviceDate;
      expect((await c.api('GET', `/search?from=Toamasina&to=Fenoarivo&date=${today}`)).body.status).toBe('no_trips');
      expect((await hold(c, t.id, ['A1'])).body.code).toBe('SALES_CLOSED');
      const guichet = await staff(c, admin, 'employe');
      expect((await hold(c, t.id, ['A1'], undefined, guichet.token)).status).toBe(200);
      await c.db.q(`UPDATE trips SET departure_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
      expect((await hold(c, t.id, ['A2'], undefined, guichet.token)).body.code).toBe('SALES_CLOSED');
    });
    it('ouverture programmée des ventes d\'un départ', async () => {
      const v = await vehicle(c, admin, 'minibus10');
      const t = await trip(c, admin, { routeId: w.route.id, vehicleId: v.id, date: day(9), time: '09:00' });
      const opens = new Date(Date.now() + 3600000).toISOString();
      expect((await c.api('PATCH', `/admin/trips/${t.id}`, { token: admin, body: { salesOpenAt: opens } })).status).toBe(200);
      expect((await c.api('GET', `/search?from=Antananarivo&to=Antsirabe&date=${day(9)}`)).body.status).toBe('no_trips');
      const h = await hold(c, t.id, ['A1']);
      expect([h.status, h.body.code]).toEqual([409, 'SALES_NOT_OPEN']);
      await c.db.q(`UPDATE trips SET sales_open_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
      expect((await hold(c, t.id, ['A1'])).status).toBe(200);
    });
    it('réservation sans compte désactivable dans les paramètres', async () => {
      const s = (await c.api('GET', '/admin/settings', { token: admin })).body.settings.booking;
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: { ...s, allowGuestCheckout: false } });
      const h = await hold(c, w.tripId, ['F1']);
      expect((await book(c, w.tripId, h.body.token, ['F1'])).body.code).toBe('LOGIN_REQUIRED');
      const u = await customer(c);
      expect((await book(c, w.tripId, h.body.token, ['F1'], { token: u.token })).status).toBe(201);
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: s });
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('tarification configurable : frais par siège, tarif enfant, taxe en sus', async () => {
      const b0 = (await c.api('GET', '/admin/settings', { token: admin })).body.settings;
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: { ...b0.booking, serviceFee: 500, serviceFeeMode: 'per_seat', child: { enabled: true, maxAge: 11, discountPercent: 50 } } });
      await c.api('PUT', '/admin/settings/legal', { token: admin, body: { ...b0.legal, taxEnabled: true, taxRatePercent: 20, taxIncluded: false } });
      const h = await hold(c, w.tripId, ['F1', 'F2']);
      const r = await c.api('POST', '/bookings', { headers: { 'idempotency-key': key() }, body: { tripId: w.tripId, holdToken: h.body.token, contact: CONTACT,
        passengers: [pax('F1'), { ...pax('F2'), category: 'child' }] } });
      expect(r.body).toMatchObject({ subtotal: 22500, serviceFee: 1000, taxAmount: 4700, total: 28200 });   // (15000 + 7500) + 2×500, +20 %
      expect(r.body.passengers.map((p: any) => p.price)).toEqual([15000, 7500]);
      await c.api('PUT', '/admin/settings/legal', { token: admin, body: { ...b0.legal, taxEnabled: true, taxRatePercent: 20, taxIncluded: true } });
      const r2 = await book(c, w.tripId, h.body.token, ['F1', 'F2']);
      expect(r2.body).toMatchObject({ subtotal: 30000, serviceFee: 1000, taxAmount: 5167, total: 31000 });   // taxe incluse : le total ne change pas
      await c.api('PUT', '/admin/settings/booking', { token: admin, body: b0.booking });
      await c.api('PUT', '/admin/settings/legal', { token: admin, body: b0.legal });
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('invariant final : aucun siège vendu deux fois sur le voyage de test', async () => { await assertNoDoubleSale(c, w.tripId); });
  });
});
