import { SMTPServer } from 'smtp-server';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import { CONTACT, Ctx, book, boot, customer, day, getBooking, hold, key, pax, purchase, setup, sleep, staff, uuid, world } from '../helpers';

/** Petit serveur SMTP local : les e-mails sont réellement transmis par le protocole SMTP, puis lus ici. */
function smtpServer(opts: { reject?: boolean } = {}) {
  const mails: Array<{ from: string; to: string[]; data: string; user?: string }> = [];
  const server = new SMTPServer({
    authOptional: false, disabledCommands: ['STARTTLS'],
    onAuth(auth, _s, cb) { if (opts.reject || auth.password !== 'smtp-secret-123') return cb(new Error('Identifiants refusés')); cb(null, { user: auth.username }); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => { mails.push({ from: (session.envelope.mailFrom as any).address, to: session.envelope.rcptTo.map(r => r.address), data: Buffer.concat(chunks).toString('utf8'), user: session.user as any }); cb(); });
    },
  });
  return new Promise<{ port: number; mails: typeof mails; close: () => Promise<void> }>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.server.address() as AddressInfo).port, mails, close: () => new Promise<void>(r => server.close(() => r())) })));
}

describe('Administration, notifications, temps réel et protections', () => {
  let c: Ctx, admin: string, w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { c = await boot(); admin = await setup(c); w = await world(c, admin, { layout: 'bus', price: 18000 }); });
  afterAll(async () => { await c.close(); });

  describe('Journal d\'audit inaltérable', () => {
    it('les actions sensibles sont journalisées avec leur auteur et le détail avant/après', async () => {
      const v = await c.api('PATCH', `/admin/vehicles/${w.vehicle.id}`, { token: admin, body: { name: 'Bus Renommé' } });
      expect(v.status).toBe(200);
      const log = await c.api('GET', '/admin/audit?category=fleet', { token: admin });
      const e = log.body.items.find((x: any) => x.targetId === w.vehicle.id && x.diff);
      expect(e.actorName).toBe('Ada Admin');
      expect(e.actorPublicId).toMatch(/^USR-/);
      expect(e.diff).toEqual([expect.objectContaining({ field: 'name', after: 'Bus Renommé' })]);
    });
    it('impossible de modifier, supprimer ou vider le journal, même en SQL direct', async () => {
      await expect(c.db.q(`UPDATE audit_log SET action = 'falsifié' WHERE id = 1`)).rejects.toThrow(/ajout seul/);
      await expect(c.db.q(`DELETE FROM audit_log WHERE id = 1`)).rejects.toThrow(/ajout seul/);
      await expect(c.db.q(`TRUNCATE audit_log`)).rejects.toThrow(/ajout seul/);
      expect((await c.api('DELETE', '/admin/audit', { token: admin })).status).toBe(404);          // aucune route de suppression n'existe
      expect((await c.api('DELETE', '/admin/audit/1', { token: admin })).status).toBe(404);
    });
    it('chaîne de hachage : intacte par défaut, une falsification en contournant les déclencheurs est détectée', async () => {
      const ok = await c.api('GET', '/admin/audit/verify', { token: admin });
      expect(ok.body.intact).toBe(true);
      expect(ok.body.entries).toBeGreaterThan(3);
      await c.db.tx(async t => {   // un attaquant ayant les droits de super-utilisateur sur la base
        await t.q(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`);
        await t.q(`UPDATE audit_log SET details = 'trace effacée' WHERE id = 2`);
        await t.q(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`);
      });
      const broken = await c.api('GET', '/admin/audit/verify', { token: admin });
      expect(broken.body).toMatchObject({ intact: false, firstBrokenId: 2 });
    });
    it('chaque employé consulte ses propres actions, pas celles des autres', async () => {
      const g = await staff(c, admin, 'employe');
      const mine = await c.api('GET', '/admin/audit/mine', { token: g.token });
      expect(mine.status).toBe(200);
      expect(mine.body.items.every((e: any) => e.action === 'Connexion réussie')).toBe(true);
      expect((await c.api('GET', '/admin/audit', { token: g.token })).status).toBe(403);
    });
  });

  describe('E-mails réels (SMTP) et SMS', () => {
    it('sans serveur configuré : les messages sont marqués « simulés », rien n\'est perdu', async () => {
      const p = await purchase(c, w.tripId, ['A1']);
      await c.notifications.processOutbox(50);
      const m = await c.db.one<any>(`SELECT status, subject FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1`, [p.booking.reference]);
      expect(m.status).toBe('simulated');
      expect(m.subject).toContain(p.booking.reference);
    });
    it('envoi réel par SMTP : e-mail au nom de la société, billet PDF en pièce jointe, mot de passe SMTP chiffré', async () => {
      const smtp = await smtpServer();
      try {
        const n = (await c.api('GET', '/admin/settings', { token: admin })).body.settings.notifications;
        await c.api('PUT', '/admin/settings/notifications', { token: admin, body: { ...n, email: { enabled: true, host: '127.0.0.1', port: smtp.port, secure: false, user: 'billets', fromName: 'Trans Test Billets', fromEmail: 'billets@transtest.mg', replyTo: '' } } });
        await c.api('PUT', '/admin/secrets', { token: admin, body: { key: 'smtp.password', value: 'smtp-secret-123' } });
        const test = await c.api('POST', '/admin/settings/test-email', { token: admin, body: { to: 'admin@transtest.mg' } });
        expect(test.status).toBe(200);
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0]).toMatchObject({ from: 'billets@transtest.mg', to: ['admin@transtest.mg'], user: 'billets' });

        const p = await purchase(c, w.tripId, ['A2', 'A3']);
        expect(await c.notifications.processOutbox(50)).toBeGreaterThanOrEqual(1);
        const mail = smtp.mails.find(m => m.to[0] === 'clara@test.local')!;
        expect(mail).toBeDefined();
        expect(mail.data).toMatch(/From: "?Trans Test Billets"? <billets@transtest\.mg>/);
        expect(mail.data).toContain(p.booking.reference);
        expect(mail.data).toMatch(/Content-Type: application\/pdf/);
        expect(mail.data).toContain(`billet-${p.booking.reference}.pdf`);
        expect(mail.data.toLowerCase()).not.toContain('soatrans');
        expect((await c.db.one<any>(`SELECT status FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1`, [p.booking.reference])).status).toBe('sent');
        const log = await c.api('GET', '/admin/notifications?status=sent', { token: admin });
        expect(log.body.total).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(await c.api('GET', '/admin/settings', { token: admin }))).not.toContain('smtp-secret-123');
      } finally { await smtp.close(); }
    });
    it('serveur SMTP en panne : nouvel essai automatique avec délai croissant, abandon après 5 essais, relance manuelle', async () => {
      const p = await purchase(c, w.tripId, ['A4']);   // le serveur SMTP du test précédent est arrêté
      const id = (await c.db.one<any>(`SELECT id FROM notifications_outbox WHERE template = 'booking_confirmed' AND vars->>'reference' = $1`, [p.booking.reference])).id;
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        await c.db.q(`UPDATE notifications_outbox SET next_attempt_at = now() WHERE id = $1`, [id]);
        await c.notifications.processOutbox(50);
        const m = await c.db.one<any>(`SELECT status, attempts, last_error, extract(epoch from next_attempt_at - now()) AS s FROM notifications_outbox WHERE id = $1`, [id]);
        delays.push(Math.round(Number(m.s)));
        expect(m.attempts).toBe(i + 1);
        expect(m.status).toBe(i < 4 ? 'pending' : 'failed');
        expect(m.lastError).toBeTruthy();
      }
      expect(delays.slice(0, 4)).toEqual([30, 120, 480, 1920]);
      expect((await getBooking(c, p.booking)).status).toBe('confirmed');   // un e-mail en échec n'annule jamais la vente
      expect((await c.api('POST', `/admin/notifications/${id}/retry`, { token: admin })).status).toBe(200);
      expect((await c.db.one<any>('SELECT status, attempts FROM notifications_outbox WHERE id = $1', [id]))).toEqual({ status: 'pending', attempts: 0 });
    });
    it('test SMTP avec de mauvais identifiants : message d\'erreur lisible', async () => {
      const smtp = await smtpServer({ reject: true });
      try {
        const r = await c.api('POST', '/admin/settings/test-email', { token: admin, body: { to: 'x@test.local', smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'u', password: 'faux', fromEmail: 'a@b.mg' } } });
        expect([r.status, r.body.code]).toEqual([400, 'SMTP_TEST_FAILED']);
        expect(r.body.message).toMatch(/refusé/i);
      } finally { await smtp.close(); }
      const n = (await c.api('GET', '/admin/settings', { token: admin })).body.settings.notifications;
      await c.api('PUT', '/admin/settings/notifications', { token: admin, body: { ...n, email: { ...n.email, enabled: false } } });
    });
    it('SMS : mode simulé tant qu\'aucune passerelle n\'est configurée', async () => {
      const n = (await c.api('GET', '/admin/settings', { token: admin })).body.settings.notifications;
      await c.api('PUT', '/admin/settings/notifications', { token: admin, body: { ...n, sendTicketBySms: true, sms: { ...n.sms, enabled: true, provider: 'none' } } });
      const p = await purchase(c, w.tripId, ['B1']);
      await c.notifications.processOutbox(50);
      const sms = await c.db.one<any>(`SELECT status, body, recipient FROM notifications_outbox WHERE channel = 'sms' AND vars->>'reference' = $1`, [p.booking.reference]);
      expect(sms.status).toBe('simulated');
      expect(sms.recipient).toBe('0341234567');
      expect(sms.body).toContain(p.booking.reference);
      expect(sms.body.length).toBeLessThanOrEqual(320);
      await c.api('PUT', '/admin/settings/notifications', { token: admin, body: n });
    });
  });

  describe('Temps réel (Socket.IO)', () => {
    let url = '';
    const sockets: Socket[] = [];
    const connect = (auth: any = {}) => new Promise<Socket>((resolve, reject) => {
      const s = io(url, { path: '/socket.io', transports: ['websocket'], auth, reconnection: false });
      sockets.push(s); s.on('connect', () => resolve(s)); s.on('connect_error', reject);
    });
    const next = (s: Socket, event: string, ms = 3000) => new Promise<any>((resolve, reject) => { const t = setTimeout(() => reject(new Error('aucun événement ' + event)), ms); s.once(event, d => { clearTimeout(t); resolve(d); }); });
    const silent = (s: Socket, event: string, ms = 400) => new Promise<boolean>(resolve => { const h = () => resolve(false); s.once(event, h); setTimeout(() => { s.off(event, h); resolve(true); }, ms); });
    const emit = (s: Socket, ev: string, data: any) => new Promise<any>(r => s.emit(ev, data, r));
    beforeAll(async () => { await c.app.listen(0, '127.0.0.1'); const a: any = c.app.getHttpServer().address(); url = `http://127.0.0.1:${a.port}`; });
    afterAll(() => { for (const s of sockets) s.close(); });

    it('tous les écrans qui regardent un voyage (client, guichet, admin) voient le siège changer en direct', async () => {
      const g = await staff(c, admin, 'employe');
      const [client, guichet, adminScreen, elsewhere] = await Promise.all([connect(), connect({ token: g.token }), connect({ token: admin }), connect()]);
      for (const s of [client, guichet, adminScreen]) expect((await emit(s, 'trip.join', { tripId: w.tripId })).ok).toBe(true);
      const other = await world(c, admin, { from: 'Autre', to: 'Voyage', layout: 'minibus10' });
      await emit(elsewhere, 'trip.join', { tripId: other.tripId });

      const held = Promise.all([client, guichet, adminScreen].map(s => next(s, 'seat.held')));
      const quiet = silent(elsewhere, 'seat.held');
      const h = await hold(c, w.tripId, ['C1', 'C2']);
      for (const e of await held) expect(e).toMatchObject({ tripId: w.tripId, seats: ['C1', 'C2'] });
      expect(await quiet).toBe(true);   // un écran qui regarde un autre voyage ne reçoit rien

      const released = Promise.all([client, guichet].map(s => next(s, 'seat.released')));
      await hold(c, w.tripId, ['C2'], h.body.token);
      for (const e of await released) expect(e.seats).toEqual(['C1']);

      const booked = Promise.all([client, guichet, adminScreen].map(s => next(s, 'seat.booked')));
      const staffNotified = next(adminScreen, 'booking.updated');
      const b = await book(c, w.tripId, h.body.token, ['C2']);
      const p = await c.api('POST', '/payments', { headers: { 'idempotency-key': key(), 'x-booking-token': b.body.accessToken }, body: { reference: b.body.reference, method: 'mvola', payerPhone: '0340000111' } });
      await c.payments.checkOne(p.body.id);
      for (const e of await booked) expect(e.seats).toEqual(['C2']);
      expect((await staffNotified).reference).toBe(b.body.reference);
    });
    it('expiration d\'un verrou : diffusée à tous par la tâche de nettoyage', async () => {
      const s = await connect();
      await emit(s, 'trip.join', { tripId: w.tripId });
      const h = await hold(c, w.tripId, ['D1']);
      await c.db.q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second' WHERE hold_token = $1`, [h.body.token]);
      const ev = next(s, 'seat.released');
      await c.seats.sweepExpiredHolds();
      expect((await ev).seats).toEqual(['D1']);
    });
    it('l\'invité suit sa réservation avec son jeton ; sans jeton il ne reçoit rien', async () => {
      const h = await hold(c, w.tripId, ['D2']);
      const b = await book(c, w.tripId, h.body.token, ['D2']);
      const owner = await connect(), spy = await connect();
      expect((await emit(owner, 'booking.join', { reference: b.body.reference, token: b.body.accessToken })).ok).toBe(true);
      expect((await emit(spy, 'booking.join', { reference: b.body.reference, token: 'faux' })).ok).toBe(false);
      expect((await emit(spy, 'booking.join', { reference: b.body.reference })).ok).toBe(false);
      const pay = next(owner, 'payment.updated'), conf = next(owner, 'booking.confirmed'), quiet = silent(spy, 'booking.confirmed', 800);
      const p = await c.api('POST', '/payments', { headers: { 'idempotency-key': key(), 'x-booking-token': b.body.accessToken }, body: { reference: b.body.reference, method: 'mvola', payerPhone: '0340000111' } });
      expect((await pay).status).toBe('pending');
      await c.payments.checkOne(p.body.id);
      expect((await conf)).toMatchObject({ reference: b.body.reference, status: 'confirmed' });
      expect(await quiet).toBe(true);
    });
    it('les alertes du back-office ne partent pas vers les clients ; un jeton invalide n\'ouvre aucun salon privé', async () => {
      const cust = await customer(c);
      const visitor = await connect(), client = await connect({ token: cust.token }), fake = await connect({ token: 'jeton.bidon.xyz' }), back = await connect({ token: admin });
      const got = next(back, 'booking.created');
      const quiet = Promise.all([visitor, client, fake].map(s => silent(s, 'booking.created', 800)));
      const h = await hold(c, w.tripId, ['D3']);
      await book(c, w.tripId, h.body.token, ['D3']);
      expect((await got).status).toBe('pending_payment');
      expect(await quiet).toEqual([true, true, true]);
    });
    it('changement de rôle et révocation de session poussés en direct vers le compte concerné', async () => {
      const s = await staff(c, admin, 'superviseur');
      const sock = await connect({ token: s.token });
      const perm = next(sock, 'permissions.changed');
      await c.api('POST', `/admin/staff/${s.id}/role`, { token: admin, body: { role: 'employe' } });
      expect((await perm).role).toBe('employe');
      const rev = next(sock, 'session.revoked');
      await c.api('PATCH', `/admin/staff/${s.id}`, { token: admin, body: { status: 'suspended' } });
      await rev;
    });
    it('reprise après coupure : à la reconnexion, l\'état complet est relu par l\'API (les événements ne sont pas la source de vérité)', async () => {
      const s = await connect();
      await emit(s, 'trip.join', { tripId: w.tripId });
      const h = await hold(c, w.tripId, ['E1']);
      s.close();                                                    // coupure réseau du client
      await hold(c, w.tripId, ['E1', 'E2'], h.body.token);          // changements manqués pendant la coupure
      const s2 = await connect();
      await emit(s2, 'trip.join', { tripId: w.tripId });
      const map = await c.api('GET', `/trips/${w.tripId}/seats?holdToken=${h.body.token}`);
      expect(map.body.hold.seats).toEqual(['E1', 'E2']);            // le client retrouve sa sélection et le temps restant
      expect(new Date(map.body.hold.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(map.body.serverTime).toBeDefined();
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
  });

  describe('Publicités, tableau de bord, rapports', () => {
    it('publicités : planification par dates et par page, statistiques de vues et de clics', async () => {
      const ad = await c.api('POST', '/admin/ads', { token: admin, body: { title: 'Promo Noël', description: '-10 %', linkUrl: 'https://exemple.mg/promo', pages: ['/'], startDate: day(-1), endDate: day(5), priority: 9 } });
      expect(ad.status).toBe(201);
      await c.api('POST', '/admin/ads', { token: admin, body: { title: 'À venir', startDate: day(3), endDate: day(9) } });
      await c.api('POST', '/admin/ads', { token: admin, body: { title: 'En pause', status: 'paused', startDate: day(-1), endDate: day(9) } });
      expect((await c.api('GET', '/ads?page=/')).body.map((a: any) => a.title)).toEqual(['Promo Noël']);
      expect((await c.api('GET', '/ads?page=/buses')).body).toEqual([]);
      await c.api('POST', `/ads/${ad.body.id}/view`); await c.api('POST', `/ads/${ad.body.id}/view`); await c.api('POST', `/ads/${ad.body.id}/click`);
      const list = (await c.api('GET', '/admin/ads', { token: admin })).body;
      const items = list.items ?? list;
      expect(items.find((a: any) => a.id === ad.body.id)).toMatchObject({ views: 2, clicks: 1, effectiveStatus: 'active' });
      expect(items.map((a: any) => a.effectiveStatus).sort()).toEqual(['active', 'paused', 'scheduled']);
      const xss = await c.api('POST', '/admin/ads', { token: admin, body: { title: 'x', linkUrl: 'javascript:alert(1)', startDate: day(0), endDate: day(1) } });
      expect(xss.status).toBe(400);
      const img = await c.api('POST', '/admin/ads', { token: admin, body: { title: 'x', imageUrl: 'data:text/html;base64,PHNjcmlwdD4=', startDate: day(0), endDate: day(1) } });
      expect(img.status).toBe(400);
    });
    it('tableau de bord et rapport de revenus cohérents avec les encaissements réels (remboursements déduits)', async () => {
      const collected = await c.db.one<any>(`SELECT coalesce(sum(amount - refunded_amount),0)::int AS s FROM payments WHERE succeeded_at IS NOT NULL`);
      const d = await c.api('GET', '/admin/dashboard', { token: admin });
      expect(d.status).toBe(200);
      expect(d.body.todayRevenue).toBe(collected.s);
      expect(d.body.totalRevenue).toBe(collected.s);
      const r = await c.api('GET', '/admin/reports/revenue', { token: admin });
      expect(r.body.total).toBe(collected.s);
      expect(r.body.daily).toHaveLength(30);
      expect(r.body.byMethod[0]).toMatchObject({ method: 'mvola' });
      expect(r.body.byRoute[0]).toMatchObject({ fromCity: 'Antananarivo', toCity: 'Antsirabe' });
      expect((await c.api('GET', `/admin/reports/revenue?from=${day(-500)}&to=${day(0)}`, { token: admin })).body.code).toBe('INVALID_PERIOD');
    });
    it('un compte sans droit sur les finances voit le tableau de bord sans les montants', async () => {
      const roles = (await c.api('GET', '/admin/roles', { token: admin })).body;
      const perms = Object.fromEntries(Object.keys(roles[0].permissions).map(k => [k, k === 'canViewDashboard']));
      const role = await c.api('POST', '/admin/roles', { token: admin, body: { name: 'Accueil', permissions: perms } });
      const s = await staff(c, admin, role.body.slug);
      const d = await c.api('GET', '/admin/dashboard', { token: s.token });
      expect(d.status).toBe(200);
      expect(d.body.todayRevenue ?? null).toBeNull();
      expect(d.body.totalRevenue ?? null).toBeNull();
    });
    it('export CSV : neutralise les formules de tableur (injection CSV)', async () => {
      const h = await hold(c, w.tripId, ['F1']);
      const b = await book(c, w.tripId, h.body.token, ['F1'], { contact: { name: '=HYPERLINK("http://evil","clic")', phone: '0341234567', email: 'evil@test.local' } });
      const p = await c.api('POST', '/payments', { headers: { 'idempotency-key': key(), 'x-booking-token': b.body.accessToken }, body: { reference: b.body.reference, method: 'mvola', payerPhone: '0340000111' } });
      await c.payments.checkOne(p.body.id);
      const csv = await c.api('GET', '/admin/reports/export.csv', { token: admin });
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const text = csv.raw.toString('utf8');
      expect(text).toContain(b.body.reference);
      expect(text).toContain(`"'=HYPERLINK(""http://evil"",""clic"")"`);
      expect(text).not.toMatch(/;"=HYPERLINK/);
    });
  });

  describe('Pagination partout', () => {
    it('toutes les listes sont paginées et plafonnées', async () => {
      // listes d'activité : 100 par page ; listes de référence (planning, flotte, itinéraires…) : 500 au plus
      const caps: Record<string, number> = { '/admin/bookings': 100, '/admin/customers': 100, '/admin/staff': 100, '/admin/audit': 100, '/admin/notifications': 100, '/admin/refunds': 100,
        '/admin/trips': 500, '/admin/trip-templates': 500, '/admin/vehicles': 500, '/admin/routes': 500, '/admin/drivers': 500 };
      for (const [url, cap] of Object.entries(caps)) {
        const r = await c.api('GET', `${url}?limit=100000&page=1`, { token: admin });
        expect([url, r.status]).toEqual([url, 200]);
        expect([url, typeof r.body.total, r.body.limit <= cap, Array.isArray(r.body.items)]).toEqual([url, 'number', true, true]);
      }
      const p2 = await c.api('GET', '/admin/bookings?limit=2&page=2', { token: admin });
      const p1 = await c.api('GET', '/admin/bookings?limit=2&page=1', { token: admin });
      expect(p1.body.items).toHaveLength(2);
      expect(p2.body.page).toBe(2);
      expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
      const weird = await c.api('GET', '/admin/bookings?limit=-5&page=abc', { token: admin });
      expect([weird.status, weird.body.page, weird.body.limit >= 1]).toEqual([200, 1, true]);
    });
    it('recherche et filtres des réservations', async () => {
      const all = await c.api('GET', '/admin/bookings?status=confirmed', { token: admin });
      expect(all.body.items.every((b: any) => b.status === 'confirmed')).toBe(true);
      const ref = all.body.items[0].reference;
      expect((await c.api('GET', `/admin/bookings?search=${ref.toLowerCase()}`, { token: admin })).body.total).toBe(1);
      expect((await c.api('GET', `/admin/bookings?tripId=${w.tripId}&channel=counter`, { token: admin })).body.total).toBe(0);
      expect((await c.api('GET', `/admin/bookings?from=${day(40)}`, { token: admin })).body.total).toBe(0);
    });
  });

  describe('Données invalides et attaques courantes', () => {
    it('injection SQL : traitée comme du texte, aucune table touchée', async () => {
      const evil = `' OR 1=1; DROP TABLE bookings; --`;
      const before = (await c.db.one<any>('SELECT count(*)::int AS n FROM bookings')).n;
      expect((await c.api('GET', `/admin/bookings?search=${encodeURIComponent(evil)}`, { token: admin })).body.total).toBe(0);
      expect((await c.api('GET', `/admin/customers?search=${encodeURIComponent(evil)}`, { token: admin })).status).toBe(200);
      expect((await c.api('GET', `/search?from=${encodeURIComponent(evil)}&to=x&date=${day(2)}`)).body.status).toBe('not_found');
      expect((await c.api('POST', '/auth/login', { body: { email: `a@b.mg' OR '1'='1`, password: 'x', scope: 'customer' } })).status).toBe(400);
      expect((await c.api('POST', '/bookings/lookup', { body: { reference: evil, phone: '0341234567' } })).status).toBe(404);
      expect((await c.api('GET', `/admin/bookings?status=${encodeURIComponent("confirmed' --")}`, { token: admin })).body.total).toBe(0);
      expect((await c.api('GET', `/admin/audit?category=${encodeURIComponent("x'; DELETE FROM audit_log;--")}`, { token: admin })).body.total).toBe(0);
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM bookings')).n).toBe(before);
    });
    it('XSS stocké : un nom contenant du HTML est stocké tel quel, renvoyé en JSON, et échappé dans les e-mails et le PDF', async () => {
      const name = `<script>alert('x')</script><img src=x onerror=alert(1)>`;
      const h = await hold(c, w.tripId, ['F2']);
      const b = await c.api('POST', '/bookings', { headers: { 'idempotency-key': key() }, body: { tripId: w.tripId, holdToken: h.body.token, passengers: [{ ...pax('F2'), firstName: name.slice(0, 60) }], contact: { ...CONTACT, name } } });
      expect(b.status).toBe(201);
      expect(b.headers['content-type']).toMatch(/application\/json/);
      expect(b.headers['x-content-type-options']).toBe('nosniff');
      const html = (await c.notifications.render('booking_confirmed', 'fr', { customer_name: name, ticket_number: 'T' })).html;
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
      await c.api('DELETE', `/trips/${w.tripId}/holds?holdToken=${h.body.token}`);
    });
    it('champs inconnus, mauvais types, valeurs hors bornes : 400 avec le détail du champ fautif', async () => {
      const r = await c.api('POST', '/admin/routes', { token: admin, body: { fromCity: 'A', toCity: 'B', durationMin: -5, basePrice: 'gratuit', isAdmin: true } });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      const paths = r.body.details.map((d: any) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['durationMin', 'basePrice']));
      expect((await c.api('POST', '/admin/routes', { token: admin, body: { fromCity: 'A', toCity: 'A', durationMin: 60, basePrice: 1 } })).status).toBeGreaterThanOrEqual(400);   // départ = arrivée
      expect((await c.api('POST', '/admin/vehicles', { token: admin, body: { name: 'x', layoutId: 'pas-un-uuid', plateNumber: 'P' } })).status).toBe(400);
      expect((await c.api('GET', '/admin/bookings/pas-un-uuid', { token: admin })).status).toBe(400);
      expect((await c.api('POST', '/admin/trips', { token: admin, body: { routeId: w.route.id, vehicleId: w.vehicle.id, date: '2026-02-30', departureTime: '25:00' } })).status).toBe(400);
    });
    it('doublons refusés proprement : immatriculation, itinéraire, permis', async () => {
      const dup = await c.api('POST', '/admin/vehicles', { token: admin, body: { name: 'Clone', layoutId: w.vehicle.layoutId, plateNumber: w.vehicle.plateNumber } });
      expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE']);
      const r = await c.api('POST', '/admin/routes', { token: admin, body: { fromCity: 'Antananarivo', toCity: 'Antsirabe', durationMin: 100, basePrice: 1 } });
      expect(r.status).toBe(409);
    });
    it('JSON mal formé, corps trop volumineux, méthode ou route inconnue', async () => {
      const bad = await c.api('POST', '/auth/login', { headers: { 'content-type': 'application/json' }, body: '{"email": ' as any });
      expect(bad.status).toBe(400);
      const huge = await c.api('POST', '/auth/login', { body: { email: 'a@b.mg', password: 'x'.repeat(2_000_000), scope: 'customer' } });
      expect(huge.status).toBe(413);
      expect((await c.api('GET', '/nimporte/quoi')).status).toBe(404);
      expect((await c.api('PUT', '/auth/login', { body: {} })).status).toBe(404);
      const err = await c.api('GET', '/admin/bookings/00000000-0000-4000-8000-000000000000', { token: admin });
      expect(err.status).toBe(404);
      expect(JSON.stringify(err.body)).not.toMatch(/at .*\.ts|node_modules|SELECT /);   // aucune trace technique dans les réponses d'erreur
    });
    it('envoi de fichier : le type est vérifié sur le contenu ; SVG, HTML et exécutables refusés ; pas de traversée de chemin', async () => {
      const boundary = 'x' + uuid();
      const part = (filename: string, type: string, content: Buffer) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const up = (filename: string, type: string, content: Buffer, token: string | undefined = admin) =>
        c.api('POST', '/admin/files?kind=logo', { token, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: part(filename, type, content) as any });
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const ok = await up('../../../etc/passwd.png', 'image/png', png);
      expect(ok.status).toBe(201);
      expect(ok.body.mime).toBe('image/png');
      const stored = await c.db.one<any>('SELECT path FROM files WHERE id = $1', [ok.body.id]);
      expect(stored.path).toMatch(/^[0-9a-f]{32}\.png$/);                    // nom régénéré : le nom fourni n'est jamais utilisé
      expect(ok.body.url).toBe(`/api/v1/files/${ok.body.id}`);
      const get = await c.api('GET', `/files/${ok.body.id}`);
      expect(get.status).toBe(200);
      expect(get.headers['content-type']).toBe('image/png');
      expect(get.headers['x-content-type-options']).toBe('nosniff');
      expect(get.raw.equals(png)).toBe(true);
      for (const [name, type, content] of [
        ['logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
        ['logo.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')],            // faux PNG
        ['virus.exe', 'image/jpeg', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff')],
      ] as Array<[string, string, Buffer]>) {
        const r = await up(name, type, content);
        expect([name, r.status, r.body.code]).toEqual([name, 400, 'FILE_TYPE_NOT_ALLOWED']);
      }
      expect((await up('gros.png', 'image/png', Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]))).status).toBe(413);
      expect((await up('logo.png', 'image/png', png, (await customer(c)).token)).status).toBe(403);
      expect((await c.api('GET', '/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
    });
    it('en-têtes de sécurité présents, aucune mise en cache des réponses de l\'API', async () => {
      const r = await c.api('GET', '/public/config');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBeDefined();
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect((await c.api('GET', '/auth/me', { token: admin })).headers['cache-control']).toBe('no-store');
    });
    it('réponses compressées (gzip/brotli) pour les listes volumineuses', async () => {
      const r = await c.api('GET', '/admin/audit?limit=100', { token: admin, headers: { 'accept-encoding': 'br, gzip' } });
      expect(['br', 'gzip']).toContain(r.headers['content-encoding']);
    });
  });

  describe('Supervision', () => {
    it('contrôles de santé', async () => {
      expect((await c.api('GET', '/health/live')).body).toMatchObject({ status: 'ok' });
      expect((await c.api('GET', '/health/ready')).body).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
    });
    it('métriques Prometheus protégées par un jeton', async () => {
      expect((await c.api('GET', '/metrics')).status).toBe(404);
      process.env.METRICS_TOKEN = 'jeton-metriques-test';
      try {
        expect((await c.api('GET', '/metrics', { headers: { authorization: 'Bearer faux' } })).status).toBe(404);
        const m = await c.api('GET', '/metrics', { headers: { authorization: 'Bearer jeton-metriques-test' } });
        expect(m.status).toBe(200);
        const text = m.raw.toString();
        for (const name of ['http_request_duration_seconds_bucket', 'db_pool_total', 'db_pool_waiting', 'ws_connections', 'process_cpu_user_seconds_total']) expect(text).toContain(name);
      } finally { delete process.env.METRICS_TOKEN; }
    });
    it('tâches planifiées : une seule instance exécute une tâche à la fois (verrou), et elles sont rejouables', async () => {
      const runs = await Promise.all(Array.from({ length: 6 }, () => c.db.withAdvisoryLock(9999, async () => { await sleep(150); return 'fait'; })));
      expect(runs.filter(r => r === 'fait')).toHaveLength(1);
      expect(runs.filter(r => r === undefined)).toHaveLength(5);
      for (const j of c.scheduler.jobs.map(x => x.name)) { await c.scheduler.runJob(j); await c.scheduler.runJob(j); }
      const hk = await c.db.one<any>(`SELECT ok, info FROM jobs_log WHERE job = 'housekeeping' ORDER BY id DESC LIMIT 1`);
      expect(hk.ok).toBe(true);
    });
    it('purge : les données techniques périmées sont supprimées, les anciennes réservations anonymisées après la durée de conservation', async () => {
      const p = await purchase(c, w.tripId, ['G1'], { contact: { name: 'Ancien Client', phone: '0349998887', email: 'ancien@test.local' } });
      await c.db.q(`UPDATE bookings SET status = 'completed', updated_at = now() - interval '40 months' WHERE id = $1`, [p.booking.id]);
      await c.db.q(`INSERT INTO idempotency_keys (scope, key, request_hash, expires_at) VALUES ('t','vieille-cle','h', now() - interval '1 day')`);
      await c.db.q(`INSERT INTO login_attempts (identifier, success, created_at) VALUES ('vieux', false, now() - interval '60 days')`);
      await c.scheduler.runJob('housekeeping');
      const b = await c.db.one<any>('SELECT contact_name, contact_phone, contact_email, total FROM bookings WHERE id = $1', [p.booking.id]);
      expect(b).toMatchObject({ contactName: 'Donnée supprimée', contactPhone: '', contactEmail: null, total: 20000 });   // le montant reste (comptabilité)
      expect((await c.db.one<any>('SELECT last_name FROM booking_passengers WHERE booking_id = $1', [p.booking.id])).lastName).toBe('supprimé');
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'vieille-cle'`)).n).toBe(0);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM login_attempts WHERE identifier = 'vieux'`)).n).toBe(0);
    });
  });
});
