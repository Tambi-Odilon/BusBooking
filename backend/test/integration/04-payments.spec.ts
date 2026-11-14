import { Ctx, assertNoDoubleSale, book, boot, getBooking, hold, key, pay, purchase, seatRows, settle, setup, simWebhook, staff, uuid, world } from '../helpers';
import { webhookSignature } from '../../src/modules/payments/payments.service';

/** Réservation en attente de paiement, paiement lancé, rien de confirmé. */
async function pending(c: Ctx, tripId: string, seats: string[], phone = '0340000111') {
  const h = await hold(c, tripId, seats);
  const b = await book(c, tripId, h.body.token, seats);
  const p = await pay(c, b.body, { phone });
  return { hold: h.body, booking: b.body, payment: p.body };
}
/** Fait expirer le verrou et la réservation, comme si le client avait mis trop longtemps à valider sur son téléphone. */
async function expire(c: Ctx, bookingId: string) {
  await c.db.q(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [bookingId]);
  await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second' WHERE booking_id = $1 AND status = 'held'`, [bookingId]);
  await c.db.q(`UPDATE seat_holds SET expires_at = now() - interval '1 second' WHERE token IN (SELECT hold_token FROM trip_seats WHERE booking_id = $1)`, [bookingId]);
}

describe('Paiements : idempotence, callbacks et rapprochement', () => {
  let c: Ctx, admin: string, w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { c = await boot(); admin = await setup(c); w = await world(c, admin, { layout: 'bus', price: 20000 }); });
  afterAll(async () => { await assertNoDoubleSale(c, w.tripId); await c.close(); });

  describe('Idempotence (clics multiples, rafraîchissement, nouvel essai réseau)', () => {
    it('l\'en-tête Idempotency-Key est obligatoire sur la réservation et le paiement', async () => {
      const h = await hold(c, w.tripId, ['A1']);
      const r = await c.api('POST', '/bookings', { body: { tripId: w.tripId, holdToken: h.body.token, passengers: [{ seatNo: 'A1', firstName: 'a', lastName: 'b' }], contact: { name: 'a', phone: '0340000001' } } });
      expect([r.status, r.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      const short = await c.api('POST', '/bookings', { headers: { 'idempotency-key': 'abc' }, body: {} });
      expect(short.status).toBe(400);
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('même clé + même contenu → la même réservation, créée une seule fois', async () => {
      const h = await hold(c, w.tripId, ['A1', 'A2']);
      const idem = key();
      const r1 = await book(c, w.tripId, h.body.token, ['A1', 'A2'], { idem });
      const r2 = await book(c, w.tripId, h.body.token, ['A1', 'A2'], { idem });
      const r3 = await book(c, w.tripId, h.body.token, ['A1', 'A2'], { idem });
      expect(r2.body.reference).toBe(r1.body.reference);
      expect(r3.body.id).toBe(r1.body.id);
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM bookings WHERE trip_id = $1', [w.tripId])).n).toBe(1);
    });
    it('même clé + contenu différent → 422', async () => {
      const h = await hold(c, w.tripId, ['A3']);
      const idem = key();
      expect((await book(c, w.tripId, h.body.token, ['A3'], { idem })).status).toBe(201);
      const other = await book(c, w.tripId, h.body.token, ['A3'], { idem, contact: { name: 'Autre', phone: '0340000009' } });
      expect([other.status, other.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    });
    it('une requête en échec ne bloque pas la clé : le nouvel essai est rejoué', async () => {
      const idem = key();
      const bad = await book(c, w.tripId, uuid(), ['A4'], { idem });
      expect(bad.body.code).toBe('HOLD_EXPIRED');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [idem])).n).toBe(0);
    });
    it('paiement : le double clic ne sollicite pas deux fois le téléphone du client', async () => {
      const h = await hold(c, w.tripId, ['B1']);
      const b = await book(c, w.tripId, h.body.token, ['B1']);
      const idem = key();
      const p1 = await pay(c, b.body, { idem });
      const p2 = await pay(c, b.body, { idem });                 // même clé
      const p3 = await pay(c, b.body);                           // autre clé (rafraîchissement de page), même moyen de paiement
      expect(p2.body.id).toBe(p1.body.id);
      expect(p3.body.id).toBe(p1.body.id);
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payments WHERE booking_id = $1', [b.body.id])).n).toBe(1);
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payment_simulations')).n).toBe(1);
      expect(await settle(c, p1.body.id)).toBe('confirmed');
    });
    it('changer de moyen de paiement remplace la demande précédente', async () => {
      const h = await hold(c, w.tripId, ['B2']);
      const b = await book(c, w.tripId, h.body.token, ['B2']);
      const p1 = await pay(c, b.body, { method: 'mvola' });
      const p2 = await pay(c, b.body, { method: 'orange_money' });
      expect(p2.body.id).not.toBe(p1.body.id);
      expect((await c.db.one<any>('SELECT status FROM payments WHERE id = $1', [p1.body.id])).status).toBe('expired');
      expect(await settle(c, p2.body.id)).toBe('confirmed');
    });
  });

  describe('Callbacks des opérateurs', () => {
    it('callback de succès signé → réservation confirmée, billets émis', async () => {
      const x = await pending(c, w.tripId, ['C1']);
      const r = await simWebhook(c, x.payment, 'succeeded');
      expect(r.status).toBe(200);
      expect(r.body.result).toBe('confirmed');
      expect((await getBooking(c, x.booking)).status).toBe('confirmed');
    });
    it('callback reçu en double (même événement) → traité une seule fois, réponse 200', async () => {
      const x = await pending(c, w.tripId, ['C2']);
      const ev = uuid();
      const a = await simWebhook(c, x.payment, 'succeeded', ev);
      const b = await simWebhook(c, x.payment, 'succeeded', ev);
      const d = await simWebhook(c, x.payment, 'succeeded', ev);
      expect(a.body.result).toBe('confirmed');
      expect([b.status, b.body.duplicate]).toEqual([200, true]);
      expect(d.body.duplicate).toBe(true);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1 AND channel = 'email'`, [x.booking.reference])).n).toBe(1);
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payment_events WHERE payment_id = $1', [x.payment.id])).n).toBe(1);
    });
    it('deux callbacks de succès distincts (l\'opérateur renvoie) → une seule confirmation, aucun remboursement', async () => {
      const x = await pending(c, w.tripId, ['C3']);
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('confirmed');
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('already_final');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1', [x.booking.id])).n).toBe(0);
    });
    it('callbacks dans le désordre : un « échec » ou « en attente » arrivé APRÈS le succès ne défait rien', async () => {
      const x = await pending(c, w.tripId, ['C4']);
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('confirmed');
      expect((await simWebhook(c, x.payment, 'failed')).body.result).toBe('already_final');
      expect((await simWebhook(c, x.payment, 'pending')).body.result).toBe('already_final');
      const v = await getBooking(c, x.booking);
      expect(v.status).toBe('confirmed');
      expect(v.payment.status).toBe('paid');
      expect((await seatRows(c, w.tripId)).find(r => r.seatNo === 'C4').status).toBe('booked');
    });
    it('callbacks dans le désordre : un succès arrivé APRÈS un échec est honoré (l\'argent a été débité)', async () => {
      const x = await pending(c, w.tripId, ['D1']);
      expect((await simWebhook(c, x.payment, 'failed')).body.result).toBe('failed');
      expect((await getBooking(c, x.booking)).status).toBe('pending_payment');
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('confirmed');
      expect((await getBooking(c, x.booking)).payment.status).toBe('paid');
    });
    it('callback non signé, signature d\'URL fausse, paiement inconnu, référence incohérente : rejetés sans effet', async () => {
      const x = await pending(c, w.tripId, ['D2']);
      const p = await c.db.one<any>('SELECT * FROM payments WHERE id = $1', [x.payment.id]);
      const url = `/payments/webhooks/mvola/${p.id}/${webhookSignature('mvola', p.id)}`;
      const noSig = await c.api('POST', url, { body: { providerRef: p.providerRef, status: 'succeeded', eventId: uuid() } });
      expect(noSig.status).toBe(401);
      const badUrl = await c.api('POST', `/payments/webhooks/mvola/${p.id}/${'0'.repeat(32)}`, { body: { providerRef: p.providerRef, status: 'succeeded', eventId: uuid() } });
      expect(badUrl.status).toBe(401);
      const otherMethod = await c.api('POST', `/payments/webhooks/orange_money/${p.id}/${webhookSignature('orange_money', p.id)}`, { body: {} });
      expect(otherMethod.status).toBe(404);
      const unknown = uuid();
      expect((await c.api('POST', `/payments/webhooks/mvola/${unknown}/${webhookSignature('mvola', unknown)}`, { body: {} })).status).toBe(404);
      expect((await c.api('POST', `/payments/webhooks/mvola/pas-un-uuid/x`, { body: {} })).status).toBe(400);
      expect((await getBooking(c, x.booking)).status).toBe('pending_payment');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payment_events WHERE payment_id = $1', [p.id])).n).toBe(0);
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('confirmed');
    });
    it('le statut d\'un paiement n\'est visible que par le titulaire de la réservation', async () => {
      const x = await pending(c, w.tripId, ['D3']);
      const ok = await c.api('GET', `/payments/${x.payment.id}?reference=${x.booking.reference}`, { headers: { 'x-booking-token': x.booking.accessToken } });
      expect(ok.body).toMatchObject({ id: x.payment.id, status: 'pending' });
      expect(JSON.stringify(ok.body)).not.toMatch(/providerRef|payerPhone|raw/);
      expect((await c.api('GET', `/payments/${x.payment.id}?reference=${x.booking.reference}`)).status).toBe(404);
      const y = await pending(c, w.tripId, ['D4']);
      const cross = await c.api('GET', `/payments/${x.payment.id}?reference=${y.booking.reference}`, { headers: { 'x-booking-token': y.booking.accessToken } });
      expect(cross.status).toBe(404);
      await settle(c, x.payment.id); await settle(c, y.payment.id);
    });
  });

  describe('Callback jamais reçu : rapprochement périodique', () => {
    it('la tâche de rapprochement interroge l\'opérateur et confirme', async () => {
      const x = await pending(c, w.tripId, ['E1']);
      await c.db.q(`UPDATE payments SET next_check_at = now() - interval '1 second' WHERE id = $1`, [x.payment.id]);
      const r = await c.payments.reconcile();
      expect(r).toMatchObject({ checked: 1, changed: 1 });
      expect((await getBooking(c, x.booking)).status).toBe('confirmed');
      expect(await c.payments.reconcile()).toMatchObject({ checked: 0 });   // plus rien à faire
    });
    it('opérateur muet : nouvelles tentatives espacées (15 s, 30 s, 1 min, 2 min, 5 min, puis 15 min), abandon après 24 h', async () => {
      const x = await pending(c, w.tripId, ['E2'], '0340000001');   // …0001 : l'opérateur ne répond jamais
      const waits: number[] = [];
      for (let i = 0; i < 7; i++) {
        await c.db.q(`UPDATE payments SET next_check_at = now() - interval '1 second' WHERE id = $1`, [x.payment.id]);
        expect(await c.payments.reconcile()).toMatchObject({ checked: 1, changed: 0 });
        waits.push(Math.round(Number((await c.db.one<any>(`SELECT extract(epoch from next_check_at - now()) AS s FROM payments WHERE id = $1`, [x.payment.id])).s)));
      }
      expect(waits).toEqual([15, 30, 60, 120, 300, 900, 900]);
      expect((await getBooking(c, x.booking)).status).toBe('pending_payment');
      await c.db.q(`UPDATE payments SET created_at = now() - interval '25 hours', next_check_at = now() - interval '1 second' WHERE id = $1`, [x.payment.id]);
      expect(await c.payments.reconcile()).toMatchObject({ checked: 1, changed: 1 });
      expect((await c.db.one<any>('SELECT status, next_check_at FROM payments WHERE id = $1', [x.payment.id]))).toMatchObject({ status: 'expired', nextCheckAt: null });
    });
    it('serveur arrêté entre l\'enregistrement et l\'appel à l\'opérateur : le paiement jamais transmis est clos', async () => {
      const h = await hold(c, w.tripId, ['E3']);
      const b = await book(c, w.tripId, h.body.token, ['E3']);
      await c.db.q(`INSERT INTO payments (booking_id, method, mode, amount, currency, status, next_check_at, created_at) VALUES ($1,'mvola','simulated',22000,'MGA','initiated', now() - interval '1 second', now() - interval '5 minutes')`, [b.body.id]);
      expect(await c.payments.reconcile()).toMatchObject({ checked: 1, changed: 1 });
      expect((await c.db.one<any>('SELECT status, failure_reason FROM payments WHERE booking_id = $1', [b.body.id]))).toMatchObject({ status: 'expired', failureReason: 'paiement non transmis' });
      expect((await pay(c, b.body)).status).toBe(200);   // le client peut relancer
    });
    it('panne de l\'opérateur pendant le rapprochement : rien n\'est perdu, nouvel essai dans 60 s', async () => {
      const x = await pending(c, w.tripId, ['E4']);
      const sim = (c.payments as any).simulator;
      const original = sim.status.bind(sim);
      sim.status = async () => { throw new Error('ECONNRESET'); };
      try {
        await c.db.q(`UPDATE payments SET next_check_at = now() - interval '1 second' WHERE id = $1`, [x.payment.id]);
        expect(await c.payments.reconcile()).toMatchObject({ checked: 1, changed: 0 });
        const p = await c.db.one<any>(`SELECT status, extract(epoch from next_check_at - now()) AS s FROM payments WHERE id = $1`, [x.payment.id]);
        expect(p.status).toBe('pending');
        expect(Math.round(Number(p.s))).toBe(60);
      } finally { sim.status = original; }
      expect(await settle(c, x.payment.id)).toBe('confirmed');
    });
    it('panne de l\'opérateur au lancement du paiement : message clair, siège conservé, nouvel essai possible', async () => {
      const h = await hold(c, w.tripId, ['F1']);
      const b = await book(c, w.tripId, h.body.token, ['F1']);
      const sim = (c.payments as any).simulator;
      const original = sim.initiate.bind(sim);
      sim.initiate = async () => { throw new Error('socket hang up'); };
      let r;
      try { r = await pay(c, b.body); } finally { sim.initiate = original; }
      expect([r.status, r.body.code]).toEqual([502, 'PAYMENT_PROVIDER_ERROR']);
      expect(r.body.message).not.toMatch(/socket|hang/);   // pas de détail technique exposé au client
      expect((await c.db.one<any>('SELECT status FROM payments WHERE booking_id = $1', [b.body.id])).status).toBe('failed');
      expect((await seatRows(c, w.tripId)).find(s => s.seatNo === 'F1').status).toBe('held');
      const retry = await pay(c, b.body);
      expect(retry.status).toBe(200);
      expect(await settle(c, retry.body.id)).toBe('confirmed');
    });
  });

  describe('Paiement confirmé APRÈS l\'expiration du verrou', () => {
    it('siège encore libre → la réservation est confirmée quand même', async () => {
      const x = await pending(c, w.tripId, ['G1', 'G2']);
      await expire(c, x.booking.id);
      await c.bookings.expirePending(); await c.seats.sweepExpiredHolds();
      expect((await getBooking(c, x.booking)).status).toBe('expired');
      expect((await seatRows(c, w.tripId)).some(s => s.seatNo === 'G1')).toBe(false);
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('confirmed');
      const v = await getBooking(c, x.booking);
      expect(v.status).toBe('confirmed');
      expect(v.seats).toEqual(['G1', 'G2']);
      expect((await seatRows(c, w.tripId)).filter(s => ['G1', 'G2'].includes(s.seatNo)).every(s => s.status === 'booked' && s.bookingId === x.booking.id)).toBe(true);
    });
    it('siège encore retenu par un verrou expiré non nettoyé → confirmé aussi', async () => {
      const x = await pending(c, w.tripId, ['G3']);
      await expire(c, x.booking.id);   // la tâche de nettoyage n'est pas encore passée
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('confirmed');
    });
    it('siège revendu entre-temps → JAMAIS de double vente : remboursement automatique et notification', async () => {
      const late = await pending(c, w.tripId, ['H1', 'H2']);
      await expire(c, late.booking.id);
      await c.bookings.expirePending(); await c.seats.sweepExpiredHolds();
      const winner = await purchase(c, w.tripId, ['H2']);          // un autre client achète H2
      expect(winner.result).toBe('confirmed');

      const r = await simWebhook(c, late.payment, 'succeeded');     // le paiement du premier client aboutit enfin
      expect(r.body.result).toBe('refunded_seat_lost');
      const v = await getBooking(c, late.booking);
      expect(v.status).toBe('cancelled');
      expect(v.cancelReason).toBe('seat_lost');
      expect(v.payment).toMatchObject({ status: 'refund_pending', paidAmount: 42000, refundPendingAmount: 42000 });
      // tout ou rien : H1 était libre mais n'est pas attribué à une réservation qu'on ne peut pas honorer en entier
      const rows = await seatRows(c, w.tripId);
      expect(rows.find(s => s.seatNo === 'H1')).toBeUndefined();
      expect(rows.find(s => s.seatNo === 'H2').bookingId).toBe(winner.booking.id);
      expect((await c.db.one<any>(`SELECT amount, reason, status FROM refunds WHERE booking_id = $1`, [late.booking.id]))).toEqual({ amount: 42000, reason: 'seat_lost', status: 'pending' });
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'payment_refund' AND vars->>'reference' = $1`, [late.booking.reference])).n).toBeGreaterThanOrEqual(1);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'Paiement tardif remboursé' AND target_id = $1`, [late.booking.id])).n).toBe(1);
      await assertNoDoubleSale(c, w.tripId);

      // le remboursement est exécuté par la tâche planifiée
      expect(await c.payments.processRefunds()).toBe(1);
      const after = await getBooking(c, late.booking);
      expect(after.payment).toMatchObject({ status: 'refunded', refundedAmount: 42000, refundPendingAmount: 0 });
      // rejouer le callback ne rembourse pas une seconde fois
      expect((await simWebhook(c, late.payment, 'succeeded')).body.result).toBe('already_final');
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1', [late.booking.id])).n).toBe(1);
    });
    it('voyage annulé pendant que le client payait → remboursement automatique', async () => {
      const w2 = await world(c, admin, { from: 'Toliara', to: 'Ihosy', layout: 'minibus10' });
      const x = await pending(c, w2.tripId, ['A1']);
      expect((await c.api('POST', `/admin/trips/${w2.tripId}/cancel`, { token: admin, body: { reason: 'Route coupée' } })).status).toBe(200);
      expect((await simWebhook(c, x.payment, 'succeeded')).body.result).toBe('refunded_trip_cancelled');
      const v = await getBooking(c, x.booking);
      expect(v).toMatchObject({ status: 'cancelled', cancelReason: 'trip_cancelled' });
      expect(v.payment.refundPendingAmount).toBe(v.total);
    });
    it('client qui paie deux fois (deux moyens de paiement validés) → le doublon est remboursé', async () => {
      const h = await hold(c, w.tripId, ['I1']);
      const b = await book(c, w.tripId, h.body.token, ['I1']);
      const p1 = await pay(c, b.body, { method: 'mvola' });
      const p2 = await pay(c, b.body, { method: 'orange_money' });   // p1 est marqué « remplacé » mais le client valide quand même les deux
      expect(await settle(c, p2.body.id)).toBe('confirmed');
      expect((await simWebhook(c, p1.body, 'succeeded')).body.result).toBe('duplicate_refunded');
      const v = await getBooking(c, b.body);
      expect(v.status).toBe('confirmed');
      expect(v.payment).toMatchObject({ paidAmount: 44000, refundPendingAmount: 22000 });
      await c.payments.processRefunds();
      expect((await getBooking(c, b.body)).payment).toMatchObject({ paidAmount: 44000, refundedAmount: 22000, refundPendingAmount: 0 });
    });
  });

  describe('Remboursements', () => {
    it('espèces : jamais automatique, mis dans la file « à rembourser au guichet » puis clos par un compte habilité', async () => {
      const guichet = await staff(c, admin, 'employe');
      const comptable = await staff(c, admin, 'comptable');
      const sale = await c.api('POST', '/admin/walkin', { token: guichet.token, headers: { 'idempotency-key': key() },
        body: { tripId: w.tripId, passengers: [{ seatNo: 'J1', firstName: 'Cash', lastName: 'Client' }], contact: { name: 'Cash Client', phone: '0341112223' }, paymentMethod: 'cash' } });
      expect(sale.status).toBe(201);
      const id = sale.body.booking.id;
      expect((await c.api('POST', `/admin/bookings/${id}/cancel`, { token: admin, body: { reason: 'erreur de saisie', refundPercent: 100 } })).status).toBe(200);
      await c.payments.processRefunds();
      const list = await c.api('GET', '/admin/refunds?status=manual', { token: comptable.token });
      const r = list.body.items.find((x: any) => x.bookingId === id);
      expect(r).toMatchObject({ amount: 22000, method: 'cash', status: 'manual' });
      expect((await c.api('POST', `/admin/refunds/${r.id}/mark-done`, { token: guichet.token, body: {} })).status).toBe(403);   // le guichet ne peut pas clore un remboursement
      expect((await c.api('POST', `/admin/refunds/${r.id}/mark-done`, { token: comptable.token, body: { providerRef: 'REÇU-0042' } })).status).toBe(200);
      expect((await c.api('POST', `/admin/refunds/${r.id}/mark-done`, { token: comptable.token, body: {} })).status).toBe(200);   // idempotent
      const p = await c.db.one<any>('SELECT status, refunded_amount FROM payments WHERE booking_id = $1', [id]);
      expect(p).toEqual({ status: 'refunded', refundedAmount: 22000 });
    });
    it('on ne rembourse jamais plus que ce qui a été encaissé', async () => {
      const p = await purchase(c, w.tripId, ['K1', 'K2']);
      const id = p.booking.id;
      const v = await getBooking(c, p.booking);
      await c.api('POST', `/admin/bookings/${id}/cancel`, { token: admin, body: { passengerIds: [v.passengers[0].id], refundPercent: 100 } });
      await c.api('POST', `/admin/bookings/${id}/cancel`, { token: admin, body: { refundPercent: 100 } });
      await c.payments.processRefunds();
      const sum = await c.db.one<any>(`SELECT coalesce(sum(amount),0)::int AS s FROM refunds WHERE booking_id = $1 AND status = 'succeeded'`, [id]);
      const paid = await c.db.one<any>(`SELECT amount, refunded_amount, status FROM payments WHERE booking_id = $1`, [id]);
      expect(sum.s).toBe(42000);
      expect(paid).toEqual({ amount: 42000, refundedAmount: 42000, status: 'refunded' });
      expect(await c.db.q('SELECT 1 FROM payments WHERE refunded_amount > amount')).toEqual([]);
    });
    it('opérateur en panne pendant un remboursement : 5 essais, puis traitement manuel', async () => {
      const p = await purchase(c, w.tripId, ['K3']);
      await c.api('POST', `/admin/bookings/${p.booking.id}/cancel`, { token: admin, body: { refundPercent: 100 } });
      const sim = (c.payments as any).simulator;
      const original = sim.refund.bind(sim);
      sim.refund = async () => { throw new Error('ETIMEDOUT'); };
      try {
        for (let i = 1; i <= 4; i++) { await c.payments.processRefunds(); expect((await c.db.one<any>('SELECT status, attempts FROM refunds WHERE booking_id = $1', [p.booking.id]))).toEqual({ status: 'pending', attempts: i }); }
        await c.payments.processRefunds();
        expect((await c.db.one<any>('SELECT status FROM refunds WHERE booking_id = $1', [p.booking.id])).status).toBe('manual');
      } finally { sim.refund = original; }
    });
  });
});
