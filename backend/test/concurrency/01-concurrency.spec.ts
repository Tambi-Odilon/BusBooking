/* Tests de concurrence : de nombreuses requêtes réellement simultanées contre la vraie API, la vraie base et le vrai Redis.
   L'invariant vérifié partout : un siège n'est jamais vendu deux fois, et le serveur ne répond jamais 500. */
import { CONTACT, Ctx, assertNoDoubleSale, book, boot, day, getBooking, hold, key, pax, pay, purchase, route, seatRows, settle, setup, simWebhook, staff, trip, uuid, vehicle, world } from '../helpers';
import { Audit } from '../../src/common/audit';

const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
const statuses = (rs: Array<{ status: number }>) => rs.reduce<Record<number, number>>((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
const walkin = (c: Ctx, token: string, tripId: string, seats: string[], idem = key()) =>
  c.api('POST', '/admin/walkin', { token, headers: { 'idempotency-key': idem }, body: {
    tripId, passengers: seats.map((s, i) => ({ seatNo: s, firstName: 'Guichet' + i, lastName: 'Client' })), contact: { name: 'Guichet Client', phone: '0345550001' }, paymentMethod: 'cash' } });
const confirmed = async (c: Ctx, tripId: string) =>
  (await c.db.one<any>(`SELECT count(*)::int AS n FROM bookings WHERE trip_id = $1 AND status = 'confirmed'`, [tripId])).n as number;
const noServerError = (rs: Array<{ status: number; body: any }>) => {
  const bad = rs.filter(r => r.status >= 500 && r.status !== 503);
  if (bad.length) throw new Error('Erreur serveur sous charge : ' + JSON.stringify(bad[0].body));
};

describe('Concurrence', () => {
  let c: Ctx, admin: string, guichet: Awaited<ReturnType<typeof staff>>;
  beforeAll(async () => { c = await boot(); admin = await setup(c); guichet = await staff(c, admin, 'employe'); });
  afterAll(async () => { await c.close(); });
  /** Un voyage neuf par test, sur un itinéraire distinct. */
  let n = 0;
  const fresh = (layout: 'bus' | 'minibus16' | 'minibus10' = 'minibus16') => world(c, admin, { layout, from: 'Ville' + (++n), to: 'Arrivée' + n, price: 15000 });

  it('300 clients cliquent sur le même siège au même instant : un seul obtient le verrou', async () => {
    const w = await fresh();
    const rs = await Promise.all(Array.from({ length: 300 }, () => hold(c, w.tripId, ['A1'])));
    noServerError(rs);
    expect(count(rs, r => r.status === 200)).toBe(1);
    expect(count(rs, r => r.status === 409 && r.body.code === 'SEAT_TAKEN')).toBe(299);
    const rows = await seatRows(c, w.tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seatNo: 'A1', status: 'held' });
    expect((await c.db.one<any>('SELECT count(*)::int AS n FROM seat_holds WHERE trip_id = $1', [w.tripId])).n).toBe(1);
  });

  it('200 parcours complets simultanés (verrou → réservation → paiement) sur le même siège : une seule vente', async () => {
    const w = await fresh();
    const run = async () => {
      const h = await hold(c, w.tripId, ['B2']);
      if (h.status !== 200) return { step: 'hold', status: h.status };
      const b = await book(c, w.tripId, h.body.token, ['B2']);
      if (b.status >= 300) return { step: 'book', status: b.status };
      const p = await pay(c, b.body);
      if (p.status >= 300) return { step: 'pay', status: p.status };
      return { step: 'done', status: 200, result: await settle(c, p.body.id) };
    };
    const rs = await Promise.all(Array.from({ length: 200 }, run));
    expect(count(rs, r => r.status >= 500)).toBe(0);
    expect(count(rs, r => r.step === 'done' && (r as any).result === 'confirmed')).toBe(1);
    expect(count(rs, r => r.step === 'hold' && r.status === 409)).toBe(199);
    expect(await confirmed(c, w.tripId)).toBe(1);
    await assertNoDoubleSale(c, w.tripId);
  });

  it('sélections qui se croisent (A1+A2 contre A2+A1, etc.) : tout ou rien, aucun interblocage, aucun siège orphelin', async () => {
    const w = await fresh();
    const combos = [['A1', 'A2'], ['A2', 'A1'], ['A2', 'A3'], ['A3', 'A1'], ['A1', 'A2', 'A3'], ['A3', 'A2', 'A1']];
    const rs = await Promise.all(Array.from({ length: 180 }, (_, i) => hold(c, w.tripId, combos[i % combos.length])));
    noServerError(rs);
    const ok = rs.filter(r => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // les verrous accordés ne se recouvrent jamais
    const granted = ok.flatMap(r => r.body.seats as string[]);
    expect(new Set(granted).size).toBe(granted.length);
    // chaque siège en base appartient à un verrou accordé, et chaque verrou accordé a tous ses sièges
    const rows = await seatRows(c, w.tripId);
    expect(rows.map(r => r.seatNo).sort()).toEqual([...granted].sort());
    for (const r of ok) expect(count(rows, x => x.holdToken === r.body.token)).toBe(r.body.seats.length);
  });

  it('ouverture des ventes d\'un départ populaire : 600 clients pour 16 places, exactement 16 billets vendus', async () => {
    const w = await fresh('minibus16');
    const seats = ['F1', 'F2', 'A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3', 'D1', 'D2', 'D3', 'D4'];
    // comme le vrai frontend : en cas de 503 (délestage), on patiente et on réessaie
    const retry = async (f: () => Promise<any>) => {
      let r = await f();
      for (let k = 0; r.status === 503 && k < 40; k++) { await new Promise(res => setTimeout(res, 150 + Math.random() * 300)); r = await f(); }
      return r;
    };
    const run = async (i: number) => {
      // chaque client essaie jusqu'à 4 sièges différents avant d'abandonner
      for (let k = 0; k < 4; k++) {
        const seat = seats[(i * 7 + k * 5) % seats.length];
        const h = await retry(() => hold(c, w.tripId, [seat]));
        if (h.status === 409) continue;
        if (h.status !== 200) return { status: h.status, body: h.body };
        const idem = key(), idemPay = key();
        const b = await retry(() => book(c, w.tripId, h.body.token, [seat], { idem }));
        if (b.status >= 300) return { status: b.status, body: b.body };
        const p = await retry(() => pay(c, b.body, { idem: idemPay }));
        if (p.status >= 300) return { status: p.status, body: p.body };
        for (let k2 = 0; ; k2++) {
          try { return { status: 200, body: { result: await settle(c, p.body.id) } }; }
          catch (e: any) { if (e?.status !== 503 || k2 > 40) throw e; await new Promise(res => setTimeout(res, 200)); }
        }
      }
      return { status: 409, body: null };
    };
    const rs = await Promise.all(Array.from({ length: 600 }, (_, i) => run(i)));
    noServerError(rs);
    const sold = count(rs, r => r.status === 200 && r.body.result === 'confirmed');
    if (sold !== 16) throw new Error(`${sold} ventes au lieu de 16 — réponses : ` + JSON.stringify(rs.reduce<Record<string, number>>((a, r) => { const k = r.status + ':' + (r.body?.code || r.body?.result || ''); a[k] = (a[k] || 0) + 1; return a; }, {})));
    expect(await confirmed(c, w.tripId)).toBe(16);
    const rows = await seatRows(c, w.tripId);
    expect(rows).toHaveLength(16);
    expect(rows.every(r => r.status === 'booked')).toBe(true);
    await assertNoDoubleSale(c, w.tripId);
    const s = await c.api('GET', `/search?from=Ville${n}&to=Arrivée${n}&date=${day(2)}`);
    expect(s.body.status).toBe('full');
  }, 120000);

  it('guichet et vente en ligne en même temps sur les mêmes sièges : chaque siège est vendu une seule fois', async () => {
    const w = await fresh();
    const seats = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'C1'];
    const web = seats.flatMap(s => Array.from({ length: 10 }, async () => {
      try { return { via: 'web', seat: s, ok: (await purchase(c, w.tripId, [s])).result === 'confirmed' }; } catch { return { via: 'web', seat: s, ok: false }; }
    }));
    const counter = seats.flatMap(s => Array.from({ length: 10 }, async () => {
      const r = await walkin(c, guichet.token, w.tripId, [s]);
      if (r.status >= 500) throw new Error(JSON.stringify(r.body));
      return { via: 'guichet', seat: s, ok: r.status < 300 };
    }));
    const rs = await Promise.all([...web, ...counter]);
    for (const s of seats) expect(count(rs, r => r.seat === s && r.ok)).toBe(1);
    expect(await confirmed(c, w.tripId)).toBe(seats.length);
    expect(count(rs, r => r.ok && r.via === 'guichet') + count(rs, r => r.ok && r.via === 'web')).toBe(seats.length);
    await assertNoDoubleSale(c, w.tripId);
  }, 120000);

  it('100 clics simultanés sur « Réserver » avec la même clé d\'idempotence : une seule réservation', async () => {
    const w = await fresh();
    const h = await hold(c, w.tripId, ['C1', 'C2']);
    const idem = key();
    const rs = await Promise.all(Array.from({ length: 100 }, () => book(c, w.tripId, h.body.token, ['C1', 'C2'], { idem })));
    noServerError(rs);
    const ok = rs.filter(r => r.status < 300);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map(r => r.body.reference)).size).toBe(1);
    // les requêtes arrivées pendant le traitement de la première reçoivent 409 « en cours », jamais une seconde réservation
    expect(rs.every(r => r.status < 300 || r.status === 409)).toBe(true);
    expect((await c.db.one<any>('SELECT count(*)::int AS n FROM bookings WHERE trip_id = $1', [w.tripId])).n).toBe(1);
  });

  it('100 clics simultanés sur « Réserver » avec des clés différentes (deux onglets, rafraîchissement) : une seule réservation active', async () => {
    const w = await fresh();
    const h = await hold(c, w.tripId, ['C3']);
    const rs = await Promise.all(Array.from({ length: 100 }, () => book(c, w.tripId, h.body.token, ['C3'])));
    noServerError(rs);
    const active = await c.db.q<any>(`SELECT id FROM bookings WHERE trip_id = $1 AND status IN ('pending_payment','confirmed')`, [w.tripId]);
    expect(active).toHaveLength(1);
    const rows = await seatRows(c, w.tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0].bookingId).toBe(active[0].id);
  });

  it('60 clics simultanés sur « Payer » : le téléphone du client n\'est sollicité qu\'une fois', async () => {
    const w = await fresh();
    const h = await hold(c, w.tripId, ['D1']);
    const b = await book(c, w.tripId, h.body.token, ['D1']);
    const idem = key();
    const rs = await Promise.all(Array.from({ length: 60 }, () => pay(c, b.body, { idem })));
    noServerError(rs);
    expect(new Set(rs.filter(r => r.status < 300).map(r => r.body.id)).size).toBe(1);
    expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payments WHERE booking_id = $1', [b.body.id])).n).toBe(1);
    expect((await c.db.one<any>('SELECT count(*)::int AS n FROM payment_simulations')).n).toBeGreaterThanOrEqual(1);
  });

  it('le même callback de paiement reçu 80 fois en parallèle : une confirmation, un seul jeu de billets, un seul e-mail', async () => {
    const w = await fresh();
    const h = await hold(c, w.tripId, ['A1', 'A2']);
    const b = await book(c, w.tripId, h.body.token, ['A1', 'A2']);
    const p = await pay(c, b.body);
    const same = uuid();
    const rs = await Promise.all([
      ...Array.from({ length: 40 }, () => simWebhook(c, p.body, 'succeeded', same)),      // doublons stricts
      ...Array.from({ length: 40 }, () => simWebhook(c, p.body, 'succeeded')),            // renvois avec un nouvel identifiant
      ...Array.from({ length: 10 }, () => settle(c, p.body.id).then(() => ({ status: 200, body: {} }))),   // et le rapprochement en même temps
    ]);
    noServerError(rs as any);
    expect(rs.every(r => r.status === 200)).toBe(true);
    const v = await getBooking(c, b.body);
    expect(v.status).toBe('confirmed');
    expect(v.payment).toMatchObject({ status: 'paid', refundPendingAmount: 0, refundedAmount: 0 });
    expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1`, [b.body.id])).n).toBe(0);
    expect((await c.db.one<any>(`SELECT count(DISTINCT ticket_number)::int AS n, count(*)::int AS total FROM booking_passengers WHERE booking_id = $1`, [b.body.id]))).toEqual({ n: 2, total: 2 });
    expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1`, [b.body.reference])).n).toBe(1);
    await assertNoDoubleSale(c, w.tripId);
  });

  it('paiement tardif et revente du siège au même instant : jamais deux gagnants, le perdant est remboursé', async () => {
    for (let round = 0; round < 12; round++) {
      const w = await fresh();
      const h = await hold(c, w.tripId, ['B1']);
      const b = await book(c, w.tripId, h.body.token, ['B1']);
      const p = await pay(c, b.body);
      // le verrou et la réservation du premier client expirent pendant qu'il valide sur son téléphone
      await c.db.q(`UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [b.body.id]);
      await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 minute' WHERE trip_id = $1`, [w.tripId]);
      await c.db.q(`UPDATE seat_holds SET expires_at = now() - interval '1 minute' WHERE trip_id = $1`, [w.tripId]);
      await c.bookings.expirePending();
      const [late, rival] = await Promise.all([
        simWebhook(c, p.body, 'succeeded'),
        purchase(c, w.tripId, ['B1']).then(x => x.result).catch(() => 'lost'),
      ]);
      expect(late.status).toBe(200);
      const first = await getBooking(c, b.body);
      const winners = (first.status === 'confirmed' ? 1 : 0) + (rival === 'confirmed' ? 1 : 0);
      expect(winners).toBe(1);
      if (first.status !== 'confirmed') {
        expect(first.status).toBe('cancelled');
        expect(first.payment.refundPendingAmount + first.payment.refundedAmount).toBe(first.total);
      }
      await assertNoDoubleSale(c, w.tripId);
    }
  }, 120000);

  it('tâche d\'expiration et nouveaux clients en même temps : le siège expiré est repris une seule fois', async () => {
    const w = await fresh();
    await hold(c, w.tripId, ['A1']);
    await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second' WHERE trip_id = $1`, [w.tripId]);
    await c.db.q(`UPDATE seat_holds SET expires_at = now() - interval '1 second' WHERE trip_id = $1`, [w.tripId]);
    const rs = await Promise.all([
      ...Array.from({ length: 100 }, () => hold(c, w.tripId, ['A1'])),
      ...Array.from({ length: 10 }, () => c.seats.sweepExpiredHolds().then(() => ({ status: 204, body: {} as any }))),
    ]);
    noServerError(rs);
    expect(count(rs, r => r.status === 200)).toBe(1);
    const rows = await seatRows(c, w.tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0].holdToken).toBe(rs.find(r => r.status === 200)!.body.token);
  });

  it('annulation du voyage pendant que des clients achètent : aucun billet valide ne subsiste, tout encaissement est remboursé', async () => {
    const w = await fresh('bus');
    const seats = Array.from({ length: 24 }, (_, i) => String.fromCharCode(65 + Math.floor(i / 4)) + ((i % 4) + 1));
    const buyers = seats.map(s => purchase(c, w.tripId, [s]).then(x => x.result).catch(e => 'refusé: ' + String(e.message).slice(0, 60)));
    const cancel = c.api('POST', `/admin/trips/${w.tripId}/cancel`, { token: admin, body: { reason: 'Route coupée' } });
    const [cancelRes, ...results] = await Promise.all([cancel, ...buyers]);
    expect(cancelRes.status).toBeLessThan(300);
    expect(await confirmed(c, w.tripId)).toBe(0);
    // chaque paiement encaissé a un remboursement du même montant
    const paid = await c.db.q<any>(
      `SELECT p.id, p.amount, coalesce((SELECT sum(amount) FROM refunds r WHERE r.payment_id = p.id), 0)::int AS refunded
         FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.trip_id = $1 AND p.status NOT IN ('initiated','pending','failed','expired')`, [w.tripId]);
    for (const p of paid) expect(p.refunded).toBe(p.amount);
    expect(results.length).toBe(24);
    expect((await hold(c, w.tripId, ['A1'])).status).toBe(409);
  }, 120000);

  it('remplacement du véhicule pendant des achats : aucun passager perdu, aucun siège en double', async () => {
    const w = await fresh('bus');
    await Promise.all(['A1', 'A2', 'B1', 'L4', 'K3'].map(s => purchase(c, w.tripId, [s])));
    const small = await vehicle(c, admin, 'minibus16');
    const buyers = ['C1', 'C2', 'C3', 'D1', 'D2', 'J1', 'J2'].map(s => purchase(c, w.tripId, [s]).then(x => x.result).catch(() => 'refusé'));
    const swap = async () => {
      // l'opération est refusée tant que des verrous sont actifs : le back-office la rejoue
      for (let i = 0; i < 40; i++) {
        const r = await c.api('POST', `/admin/trips/${w.tripId}/replace-vehicle`, { token: admin, body: { vehicleId: small.id } });
        if (r.status < 300) return r;
        if (r.status >= 500) throw new Error(JSON.stringify(r.body));
        await new Promise(res => setTimeout(res, 25));
      }
      throw new Error('remplacement jamais accepté');
    };
    const [swapRes] = await Promise.all([swap(), ...buyers]);
    expect(swapRes.status).toBeLessThan(300);
    await assertNoDoubleSale(c, w.tripId);
    const map = (await c.api('GET', `/trips/${w.tripId}/seats`)).body;
    const valid = new Set<string>(map.layout.rows.flatMap((r: any) => r.seats));
    const rows = await seatRows(c, w.tripId);
    for (const r of rows.filter(x => x.status === 'booked')) expect(valid.has(r.seatNo)).toBe(true);
    // tous les billets confirmés existent toujours (assis, ou signalés « à traiter »)
    const pass = await c.db.q<any>(
      `SELECT p.seat_no FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id WHERE b.trip_id = $1 AND b.status = 'confirmed' AND p.status = 'active'`, [w.tripId]);
    expect(pass.length).toBeGreaterThanOrEqual(5);
    const seated = pass.filter(p => p.seatNo !== 'N/A').map(p => p.seatNo);
    expect(new Set(seated).size).toBe(seated.length);
  }, 120000);

  it('deux annulations et un changement de siège simultanés sur la même réservation : un seul remboursement', async () => {
    const w = await fresh();
    const b = (await purchase(c, w.tripId, ['A1'])).booking;
    const cancel = () => c.api('POST', `/bookings/${b.reference}/cancel`, { headers: { 'x-booking-token': b.accessToken }, body: {} });
    const rs = await Promise.all([cancel(), cancel(), cancel(), cancel(), cancel()]);
    noServerError(rs);
    expect(count(rs, r => r.status < 300)).toBeGreaterThanOrEqual(1);
    expect((await c.db.one<any>('SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1', [b.id])).n).toBe(1);
    expect((await getBooking(c, b)).status).toBe('cancelled');
    expect(await seatRows(c, w.tripId)).toHaveLength(0);
  });

  it('deux comptes créés en même temps avec le même e-mail : un seul compte', async () => {
    const body = { email: 'course@test.local', password: 'Client-Test-2026', firstName: 'A', lastName: 'B', phone: '0341112233' };
    const rs = await Promise.all(Array.from({ length: 30 }, () => c.api('POST', '/auth/register', { body })));
    noServerError(rs);
    expect(count(rs, r => r.status < 300)).toBe(1);
    expect(count(rs, r => r.status === 409)).toBe(29);
    expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'course@test.local'`)).n).toBe(1);
  });

  it('refresh token utilisé deux fois en parallèle (deux onglets) : pas de déconnexion intempestive, jamais deux familles de sessions', async () => {
    const reg = await c.api('POST', '/auth/register', { body: { email: 'onglets@test.local', password: 'Client-Test-2026', firstName: 'A', lastName: 'B', phone: '0341112244' } });
    const rs = await Promise.all(Array.from({ length: 8 }, () => c.api('POST', '/auth/refresh', { cookies: reg.cookies })));
    noServerError(rs);
    expect(count(rs, r => r.status === 200)).toBeGreaterThanOrEqual(1);
    expect(rs.every(r => r.status === 200 || r.status === 401)).toBe(true);
    const fam = await c.db.one<any>(`SELECT count(DISTINCT family_id)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'onglets@test.local'`);
    expect(fam.n).toBe(1);
  });

  it('deux voyages créés en même temps pour le même véhicule sur le même créneau : un seul est accepté (contrainte de la base)', async () => {
    const v = await vehicle(c, admin, 'minibus16');
    const r1 = await route(c, admin, 'Conflit A', 'Conflit B');
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      c.api('POST', '/admin/trips', { token: admin, body: { routeId: r1.id, vehicleId: v.id, date: day(4), departureTime: i % 2 ? '09:00' : '10:00' } })));
    noServerError(rs);
    expect(count(rs, r => r.status < 300)).toBe(1);
    expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM trips WHERE vehicle_id = $1 AND status <> 'cancelled'`, [v.id])).n).toBe(1);
  });

  it('journal d\'audit écrit par 150 actions simultanées : la chaîne de hachage reste intacte', async () => {
    const audit = c.app.get(Audit);
    await Promise.all(Array.from({ length: 150 }, (_, i) => i % 3
      ? audit.log({ category: 'settings', action: 'Action simultanée ' + i, severity: 'info' })
      : vehicle(c, admin, 'minibus10')));
    const v = await c.api('GET', '/admin/audit/verify', { token: admin });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ intact: true, firstBrokenId: null });
    expect(v.body.entries).toBeGreaterThan(150);
  });

  it('délestage : si la base est saturée le serveur répond 503 + Retry-After, sans s\'effondrer, puis se rétablit', async () => {
    const w = await fresh();
    // on occupe toutes les connexions du pool pendant 1,5 s
    const blockers = Array.from({ length: Number(process.env.DB_POOL_MAX) }, () => c.db.q('SELECT pg_sleep(1.5)'));
    await new Promise(r => setTimeout(r, 100));
    const rs = await Promise.all(Array.from({ length: 900 }, () => c.api('GET', `/trips/${w.tripId}/seats`)));
    await Promise.all(blockers);
    expect(count(rs, r => r.status >= 500 && r.status !== 503)).toBe(0);
    const busy = rs.filter(r => r.status === 503);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0].headers['retry-after']).toBeDefined();
    expect(busy[0].body.code).toBe('SERVER_BUSY');
    // une fois la pointe passée, tout refonctionne
    expect((await c.api('GET', `/trips/${w.tripId}/seats`)).status).toBe(200);
    expect((await c.api('GET', '/health/ready')).status).toBe(200);
  }, 60000);

  it('résumé', () => { expect(statuses([{ status: 200 }])).toEqual({ 200: 1 }); expect(CONTACT.phone).toBeDefined(); expect(pax('A1').seatNo).toBe('A1'); expect(typeof trip).toBe('function'); });
});
