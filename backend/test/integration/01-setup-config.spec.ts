import { ADMIN, Ctx, boot, login, setup } from '../helpers';

describe('Assistant de première configuration et marque blanche', () => {
  let c: Ctx;
  beforeAll(async () => { c = await boot(); });
  afterAll(async () => { await c.close(); });

  it('base vide : l\'application se déclare non configurée, avec un nom neutre', async () => {
    const r = await c.api('GET', '/public/config');
    expect(r.status).toBe(200);
    expect(r.body.setupCompleted).toBe(false);
    expect(r.body.identity.name).toBe('Ma Compagnie');
    expect(r.body.storagePrefix).toBe('bb_');
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain('soatrans');
  });
  it('l\'état de l\'assistant fournit une valeur par défaut pour chaque groupe et les moyens de paiement', async () => {
    const r = await c.api('GET', '/setup/status');
    expect(r.body.status).toBe('pending');
    expect(Object.keys(r.body.defaults).sort()).toEqual(['booking', 'contact', 'identity', 'legal', 'locale', 'notifications', 'security', 'ticket']);
    expect(r.body.defaults.locale.enabledLangs).toEqual(['fr', 'en', 'mg', 'zh']);
    expect(r.body.paymentMethods.map((m: any) => m.code).sort()).toEqual(['airtel_money', 'cash', 'mvola', 'orange_money']);
    expect(r.body.paymentMethods.find((m: any) => m.code === 'mvola').secretFields).toEqual(['consumerKey', 'consumerSecret']);
  });
  it('tant que l\'installation n\'est pas faite, aucun compte ne peut se connecter au back-office', async () => {
    const r = await c.api('POST', '/auth/login', { body: { email: 'admin@soatrans.mg', password: 'Admin@2025', scope: 'staff' } });
    expect(r.status).toBe(401);   // les comptes de démonstration du frontend d'origine n'existent pas
  });
  it('sauvegarde automatique du brouillon, SANS aucun secret', async () => {
    const draft = { step: 5, identity: { name: 'Trans Sud' }, admin: { email: 'a@b.mg', password: 'NePasGarder1' }, payments: [{ code: 'mvola', secrets: { consumerKey: 'CK', consumerSecret: 'CS' } }], smtpPassword: 'x' };
    expect((await c.api('PUT', '/setup/draft', { body: { draft } })).status).toBe(200);
    const st = await c.api('GET', '/setup/status');
    expect(st.body.status).toBe('draft');
    expect(st.body.draft.step).toBe(5);
    expect(st.body.draft.identity.name).toBe('Trans Sud');
    const txt = JSON.stringify(st.body.draft);
    for (const leak of ['NePasGarder1', 'CK', 'CS', 'smtpPassword', 'consumerSecret']) expect(txt).not.toContain(leak);
    const raw = await c.db.one<any>('SELECT draft::text AS d FROM setup_state');
    expect(raw.d).not.toContain('NePasGarder1');
  });
  it('seuls le nom de la société et le compte administrateur sont obligatoires', async () => {
    const noAdmin = await c.api('POST', '/setup/complete', { body: { identity: { name: 'X' } } });
    expect(noAdmin.status).toBe(400);
    const weak = await c.api('POST', '/setup/complete', { body: { identity: { name: 'X' }, admin: { ...ADMIN, password: 'faible' } } });
    expect(weak.status).toBe(400);
    expect(JSON.stringify(weak.body.details)).toContain('admin.password');
    const noName = await c.api('POST', '/setup/complete', { body: { identity: { name: '' }, admin: ADMIN } });
    expect(noName.status).toBe(400);
    expect((await c.api('GET', '/setup/status')).body.completed).toBe(false);
  });
  it('validation de l\'assistant : société personnalisée, clés de paiement chiffrées, administrateur créé', async () => {
    const r = await c.api('POST', '/setup/complete', { body: {
      identity: { name: 'Trans Sud Express', slogan: 'Voyagez serein', primaryColor: '#0f766e', accentColor: '#f97316' },
      contact: { email: 'contact@transsud.mg', phones: ['+261 34 00 000 00'], city: 'Fianarantsoa' },
      legal: { registrationNumbers: [{ label: 'NIF', value: '1234567890' }], taxEnabled: true, taxRatePercent: 20, taxIncluded: true },
      locale: { currencyCode: 'MGA', currencySymbol: 'Ar', timezone: 'Indian/Antananarivo', defaultLang: 'fr', enabledLangs: ['fr', 'mg'] },
      booking: { seatHoldMinutes: 8, serviceFee: 1000 },
      payments: [{ code: 'mvola', enabled: true, mode: 'test', publicConfig: { merchantNumber: '0340000000' }, secrets: { consumerKey: 'CK-SECRET-123456', consumerSecret: 'CS-SECRET-654321', hacker: 'x' } }],
      secrets: { smtpPassword: 'smtp-pass-987654' },
      admin: ADMIN, seed: 'demo' } });
    expect(r.status).toBe(200);
    expect(r.body.loginUrl).toBe('/admin/login');

    const cfg = (await c.api('GET', '/public/config')).body;
    expect(cfg.setupCompleted).toBe(true);
    expect(cfg.identity).toMatchObject({ name: 'Trans Sud Express', slogan: 'Voyagez serein', primaryColor: '#0f766e', referencePrefix: 'TSE' });
    expect(cfg.locale.enabledLangs).toEqual(['fr', 'mg']);
    expect(cfg.booking).toMatchObject({ seatHoldMinutes: 8, serviceFee: 1000, maxPassengers: 6 });   // non saisi → valeur par défaut
    expect(cfg.payments.map((p: any) => p.code).sort()).toEqual(['cash', 'mvola']);

    // les secrets sont chiffrés en base et absents de toute réponse publique
    const sec = await c.db.q<any>('SELECT key, hint, ciphertext FROM app_secrets ORDER BY key');
    expect(sec.map(s => s.key)).toEqual(['mvola.consumerKey', 'mvola.consumerSecret', 'smtp.password']);   // « hacker » ignoré
    for (const s of sec) expect(Buffer.from(s.ciphertext).toString('utf8')).not.toMatch(/SECRET|smtp-pass/);
    expect(JSON.stringify(cfg)).not.toMatch(/SECRET|smtp-pass|consumerKey/);
    expect(await c.settings.getSecret('mvola.consumerKey')).toBe('CK-SECRET-123456');
    // le mot de passe administrateur est haché (Argon2id), jamais stocké en clair
    const u = await c.db.one<any>(`SELECT password_hash, kind FROM users WHERE email = $1`, [ADMIN.email]);
    expect(u.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect((await c.db.one<any>('SELECT draft::text AS d FROM setup_state')).d).toBe('{}');
  });
  it('données de départ « exemple » : villes, itinéraires, véhicules et départs vendables', async () => {
    expect((await c.api('GET', '/cities')).body).toEqual(['Antananarivo', 'Antsirabe', 'Toamasina']);
    const n = await c.db.one<any>(`SELECT count(*)::int AS n FROM trips WHERE status = 'scheduled'`);
    expect(n.n).toBeGreaterThan(50);
  });
  it('une fois terminé, l\'assistant est fermé définitivement', async () => {
    const again = await c.api('POST', '/setup/complete', { body: { identity: { name: 'Pirate' }, admin: { ...ADMIN, email: 'pirate@evil.test' } } });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('SETUP_ALREADY_COMPLETED');
    expect((await c.api('PUT', '/setup/draft', { body: { draft: { x: 1 } } })).status).toBe(403);
    expect((await c.api('POST', '/setup/test-email', { body: { to: 'a@b.mg' } })).status).toBe(403);
    expect((await c.api('POST', '/setup/upload')).status).toBe(403);
    expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM users WHERE kind = 'staff'`)).n).toBe(1);
    expect((await c.api('GET', '/public/config')).body.identity.name).toBe('Trans Sud Express');
    expect((await c.api('GET', '/setup/status')).body).toMatchObject({ completed: true, draft: {} });
  });
  it('tout reste modifiable ensuite dans Paramètres par un administrateur, et la modification est tracée', async () => {
    const { token } = await login(c, ADMIN.email, ADMIN.password, 'staff');
    const all = await c.api('GET', '/admin/settings', { token });
    expect(all.status).toBe(200);
    expect(all.body.secrets['mvola.consumerKey']).toBe('••••3456');          // masqué
    expect(JSON.stringify(all.body)).not.toContain('CK-SECRET-123456');
    const up = await c.api('PUT', '/admin/settings/identity', { token, body: { ...all.body.settings.identity, name: 'Trans Sud', primaryColor: '#7c3aed' } });
    expect(up.status).toBe(200);
    const cfg = (await c.api('GET', '/public/config')).body;
    expect(cfg.identity).toMatchObject({ name: 'Trans Sud', primaryColor: '#7c3aed' });
    const bad = await c.api('PUT', '/admin/settings/identity', { token, body: { name: 'X', primaryColor: 'violet' } });
    expect(bad.status).toBe(400);
    expect((await c.api('PUT', '/admin/settings/inconnu', { token, body: {} })).status).toBe(404);
    const audit = await c.api('GET', '/admin/audit?category=settings', { token });
    expect(audit.body.items.some((e: any) => e.action.includes('identity') && JSON.stringify(e.diff).includes('Trans Sud'))).toBe(true);
  });
  it('un secret peut être remplacé ou effacé, jamais relu ; le passage en production exige les clés', async () => {
    const { token } = await login(c, ADMIN.email, ADMIN.password, 'staff');
    expect((await c.api('PUT', '/admin/secrets', { token, body: { key: 'users.passwordHash', value: 'x' } })).status).toBe(400);
    expect((await c.api('PUT', '/admin/payment-methods/orange_money', { token, body: { enabled: true, mode: 'live' } })).status).toBe(409);
    for (const [k, v] of [['orange_money.clientId', 'id-000111222'], ['orange_money.clientSecret', 'sec-000111222'], ['orange_money.merchantKey', 'mk-000111222']])
      expect((await c.api('PUT', '/admin/secrets', { token, body: { key: k, value: v } })).status).toBe(200);
    expect((await c.api('PUT', '/admin/payment-methods/orange_money', { token, body: { enabled: true, mode: 'live' } })).status).toBe(200);
    const del = await c.api('PUT', '/admin/secrets', { token, body: { key: 'orange_money.merchantKey', value: '' } });
    expect(del.body.hints['orange_money.merchantKey']).toBeUndefined();
  });
  it('langue ajoutée et textes personnalisés servis au frontend', async () => {
    const { token } = await login(c, ADMIN.email, ADMIN.password, 'staff');
    const s = (await c.api('GET', '/admin/settings', { token })).body.settings.locale;
    const up = await c.api('PUT', '/admin/settings/locale', { token, body: { ...s, enabledLangs: ['fr', 'mg', 'es'], customLangs: [{ code: 'es', name: 'Español', baseLang: 'fr' }] } });
    expect(up.status).toBe(200);
    expect((await c.api('PUT', '/admin/i18n/es', { token, body: { entries: { 'search.title': 'Reserve su viaje', 'common.pay': 'Pagar' } } })).status).toBe(200);
    expect((await c.api('GET', '/public/i18n/es')).body).toEqual({ 'search.title': 'Reserve su viaje', 'common.pay': 'Pagar' });
    expect((await c.api('GET', '/public/config')).body.locale.customLangs[0].name).toBe('Español');
  });
  it('modèle d\'e-mail personnalisable avec variables, HTML assaini', async () => {
    const { token } = await login(c, ADMIN.email, ADMIN.password, 'staff');
    const list = await c.api('GET', '/admin/email-templates', { token });
    expect(list.body.find((t: any) => t.code === 'booking_confirmed').variables).toEqual(expect.arrayContaining(['ticket_number', 'customer_name']));
    const r = await c.api('PUT', '/admin/email-templates/booking_confirmed/fr', { token, body: {
      subject: '{{company_name}} — billet {{ticket_number}}', bodyHtml: '<p onclick="x()">Bonjour {{customer_name}}</p><script>alert(1)</script>' } });
    expect(r.status).toBe(200);
    expect(r.body.preview.subject).toBe('Trans Sud — billet [ticket_number]');
    expect(r.body.preview.html).toContain('Bonjour [customer_name]');
    expect(r.body.preview.html).not.toMatch(/<script|onclick/);
    const xss = await c.notifications.render('booking_confirmed', 'fr', { customer_name: '<img src=x onerror=alert(1)>', ticket_number: 'T1' });
    expect(xss.html).toContain('&lt;img');
    expect(xss.html).not.toContain('<img src=x');
  });
});

describe('Assistant protégé par un code d\'installation (variable SETUP_TOKEN)', () => {
  let c: Ctx;
  beforeAll(async () => {
    process.env.SETUP_TOKEN = 'code-installation-123';
    require('../../src/common/env').resetEnvCache();
    c = await boot();
  });
  afterAll(async () => { delete process.env.SETUP_TOKEN; require('../../src/common/env').resetEnvCache(); await c.close(); });
  it('sans le code : refus ; avec le code : accepté', async () => {
    expect((await c.api('GET', '/setup/status')).body.tokenRequired).toBe(true);
    expect((await c.api('PUT', '/setup/draft', { body: { draft: { a: 1 } } })).status).toBe(401);
    expect((await c.api('POST', '/setup/complete', { body: { identity: { name: 'X' }, admin: ADMIN } })).status).toBe(401);
    expect((await c.api('POST', '/setup/complete', { headers: { 'x-setup-token': 'faux' }, body: { identity: { name: 'X' }, admin: ADMIN } })).status).toBe(401);
    const ok = await c.api('POST', '/setup/complete', { headers: { 'x-setup-token': 'code-installation-123' }, body: { identity: { name: 'X' }, admin: ADMIN } });
    expect(ok.status).toBe(200);
  });
});
