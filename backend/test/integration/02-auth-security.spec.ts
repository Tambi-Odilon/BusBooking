import * as jwt from 'jsonwebtoken';
import { ADMIN, Ctx, boot, customer, login, setup, sleep, staff, world, purchase } from '../helpers';
import { totpCode } from '../../src/common/crypto';
import { env } from '../../src/common/env';

describe('Authentification, sessions et permissions', () => {
  let c: Ctx, admin: string;
  beforeAll(async () => { c = await boot(); admin = await setup(c); });
  afterAll(async () => { await c.close(); });

  describe('Comptes clients', () => {
    it('inscription : mot de passe haché côté serveur (Argon2id), jamais renvoyé', async () => {
      const r = await c.api('POST', '/auth/register', { body: { email: 'Jean@Test.Local', password: 'Client-Test-2026', firstName: 'Jean', lastName: 'Rakoto', phone: '034 12 345 67' } });
      expect(r.status).toBe(201);
      expect(r.body.user).toMatchObject({ email: 'jean@test.local', kind: 'customer', phone: '0341234567', permissions: null });
      expect(JSON.stringify(r.body)).not.toMatch(/password|argon2|refreshToken/i);
      const row = await c.db.one<any>('SELECT password_hash FROM users WHERE email = $1', ['jean@test.local']);
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      // le refresh token ne voyage que dans un cookie httpOnly limité à /api/v1/auth
      const cookie = String(r.headers['set-cookie']);
      expect(cookie).toMatch(/bb_rt_c=.+HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
    });
    it('refuse un e-mail déjà utilisé (insensible à la casse) et un mot de passe faible', async () => {
      const dup = await c.api('POST', '/auth/register', { body: { email: 'JEAN@test.local', password: 'Client-Test-2026', firstName: 'J', lastName: 'R', phone: '0341234567' } });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('EMAIL_TAKEN');
      const weak = await c.api('POST', '/auth/register', { body: { email: 'x@test.local', password: '123456', firstName: 'J', lastName: 'R', phone: '0341234567' } });
      expect(weak.status).toBe(400);
    });
    it('connexion, profil, modification du profil', async () => {
      const l = await login(c, 'jean@test.local', 'Client-Test-2026');
      const me = await c.api('GET', '/auth/me', { token: l.token });
      expect(me.body.firstName).toBe('Jean');
      const up = await c.api('PATCH', '/auth/me', { token: l.token, body: { firstName: 'Jean-Luc', role: 'admin' } });
      expect(up.status).toBe(400);   // champ inconnu refusé : on ne peut pas s'attribuer un rôle
      expect((await c.api('PATCH', '/auth/me', { token: l.token, body: { firstName: 'Jean-Luc' } })).body.firstName).toBe('Jean-Luc');
    });
    it('mauvais mot de passe et compte inexistant donnent la même réponse (pas d\'énumération)', async () => {
      const a = await c.api('POST', '/auth/login', { body: { email: 'jean@test.local', password: 'mauvais', scope: 'customer' } });
      const b = await c.api('POST', '/auth/login', { body: { email: 'inconnu@test.local', password: 'mauvais', scope: 'customer' } });
      expect([a.status, a.body.code]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect([b.status, b.body.code]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect(a.body.message).toBe(b.body.message);
    });
    it('un compte client ne peut pas se connecter au back-office, ni l\'inverse', async () => {
      expect((await c.api('POST', '/auth/login', { body: { email: 'jean@test.local', password: 'Client-Test-2026', scope: 'staff' } })).status).toBe(401);
      expect((await c.api('POST', '/auth/login', { body: { email: ADMIN.email, password: ADMIN.password, scope: 'customer' } })).status).toBe(401);
    });
    it('mot de passe oublié : même réponse que le compte existe ou non, lien à usage unique, sessions révoquées', async () => {
      const l = await login(c, 'jean@test.local', 'Client-Test-2026');
      expect((await c.api('POST', '/auth/forgot-password', { body: { email: 'inconnu@test.local' } })).status).toBe(202);
      expect((await c.api('POST', '/auth/forgot-password', { body: { email: 'jean@test.local' } })).status).toBe(202);
      const mail = await c.db.one<any>(`SELECT vars FROM notifications_outbox WHERE template = 'password_reset' ORDER BY created_at DESC LIMIT 1`);
      const token = new URL(mail.vars.reset_url).searchParams.get('token')!;
      expect(mail.vars.reset_url.startsWith('http://localhost:4200/reset-password?token=')).toBe(true);
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'password_reset'`)).n).toBe(1);
      expect((await c.api('POST', '/auth/reset-password', { body: { token, password: 'faible' } })).status).toBe(400);
      expect((await c.api('POST', '/auth/reset-password', { body: { token, password: 'Nouveau-Pass-2026' } })).status).toBe(200);
      expect((await c.api('POST', '/auth/reset-password', { body: { token, password: 'Encore-Autre-2026' } })).status).toBe(400);   // déjà utilisé
      expect((await c.api('GET', '/auth/me', { token: l.token })).status).toBe(401);                                              // ancienne session révoquée
      expect((await c.api('POST', '/auth/login', { body: { email: 'jean@test.local', password: 'Client-Test-2026', scope: 'customer' } })).status).toBe(401);
      await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
    });
    it('export et suppression (anonymisation) des données personnelles', async () => {
      const u = await customer(c, 'rgpd@test.local', '0347778899');
      const w = await world(c, admin, { from: 'Toliara', to: 'Morondava' });
      const p = await purchase(c, w.tripId, ['A1'], { token: u.token, contact: { name: 'Rg Pd', phone: '0347778899', email: 'rgpd@test.local' } });
      const exp = await c.api('GET', '/auth/me/export', { token: u.token });
      expect(exp.body.account.email).toBe('rgpd@test.local');
      expect(exp.body.bookings[0].reference).toBe(p.booking.reference);
      expect((await c.api('DELETE', '/auth/me', { token: u.token })).status).toBe(204);
      expect((await c.api('GET', '/auth/me', { token: u.token })).status).toBeGreaterThanOrEqual(401);
      const row = await c.db.one<any>('SELECT email, phone, first_name, status FROM users WHERE id = $1', [u.user.id]);
      expect(row).toMatchObject({ email: null, phone: null, status: 'deleted' });
      // le billet du voyage à venir reste valable (le passager doit pouvoir voyager) ; il pointe vers un compte vidé de toute donnée personnelle
      const b = await c.db.one<any>('SELECT b.status, u.first_name, u.last_name, u.email FROM bookings b JOIN users u ON u.id = b.customer_id WHERE b.reference = $1', [p.booking.reference]);
      expect(b).toMatchObject({ firstName: 'Client', lastName: 'supprimé', email: null });
      // l'e-mail libéré peut servir à recréer un compte
      expect((await c.api('POST', '/auth/register', { body: { email: 'rgpd@test.local', password: 'Client-Test-2026', firstName: 'R', lastName: 'G', phone: '0347778899' } })).status).toBe(201);
      expect(b.status).toBe('confirmed');
    });
  });

  describe('Sessions', () => {
    it('jeton d\'accès court (15 min), signé, refusé s\'il est falsifié, expiré ou signé avec une autre clé', async () => {
      const l = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const d: any = jwt.decode(l.token);
      expect(d.exp - d.iat).toBe(900);
      expect(Object.keys(d).sort()).toEqual(['exp', 'iat', 'k', 'pv', 'sid', 'sub']);   // aucune donnée personnelle dans le jeton
      const forged = jwt.sign({ sub: d.sub, sid: d.sid, pv: d.pv, k: 's' }, 'autre-cle-secrete', { expiresIn: 900 });
      const expired = jwt.sign({ sub: d.sub, sid: d.sid, pv: d.pv, k: 'c' }, env().jwtSecret, { expiresIn: -10 });
      const none = jwt.sign({ sub: d.sub, sid: d.sid, pv: d.pv, k: 'c' }, '', { algorithm: 'none' as any });
      expect((await c.api('GET', '/auth/me', { token: forged })).body.code).toBe('TOKEN_INVALID');
      expect((await c.api('GET', '/auth/me', { token: expired })).body.code).toBe('TOKEN_EXPIRED');
      expect((await c.api('GET', '/auth/me', { token: none })).status).toBe(401);
      expect((await c.api('GET', '/auth/me', { token: l.token + 'x' })).status).toBe(401);
      expect((await c.api('GET', '/auth/me')).body.code).toBe('UNAUTHENTICATED');
    });
    it('renouvellement : le refresh token tourne à chaque usage', async () => {
      const l = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const rt1 = l.cookies.bb_rt_c;
      const r = await c.api('POST', '/auth/refresh', { body: { scope: 'customer' }, cookies: { bb_rt_c: rt1 } });
      expect(r.status).toBe(200);
      expect(r.cookies.bb_rt_c).toBeDefined();
      expect(r.cookies.bb_rt_c).not.toBe(rt1);
      expect((await c.api('GET', '/auth/me', { token: r.body.accessToken })).status).toBe(200);
      expect((await c.api('POST', '/auth/refresh', { body: { scope: 'customer' } })).status).toBe(401);
    });
    it('deux onglets qui renouvellent en même temps : pas de déconnexion intempestive', async () => {
      const l = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const rt = l.cookies.bb_rt_c;
      const [a, b] = await Promise.all([1, 2].map(() => c.api('POST', '/auth/refresh', { body: { scope: 'customer' }, cookies: { bb_rt_c: rt } })));
      const ok = [a, b].filter(x => x.status === 200), ko = [a, b].filter(x => x.status !== 200);
      expect(ok.length).toBe(1);
      expect(ko[0].body.code).toBe('TOKEN_ROTATED');
      expect((await c.api('GET', '/auth/me', { token: ok[0].body.accessToken })).status).toBe(200);   // la famille n'est pas révoquée
    });
    it('vol de refresh token : la réutilisation d\'un jeton déjà tourné révoque toute la famille de sessions', async () => {
      const l = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const stolen = l.cookies.bb_rt_c;
      const legit = await c.api('POST', '/auth/refresh', { body: { scope: 'customer' }, cookies: { bb_rt_c: stolen } });
      expect(legit.status).toBe(200);
      await c.db.q(`UPDATE sessions SET revoked_at = now() - interval '1 minute' WHERE replaced_by IS NOT NULL AND user_id = $1`, [l.user.id]);   // hors de la tolérance de 20 s
      const attacker = await c.api('POST', '/auth/refresh', { body: { scope: 'customer' }, cookies: { bb_rt_c: stolen } });
      expect(attacker.status).toBe(401);
      expect(attacker.body.code).toBe('SESSION_REVOKED');
      expect((await c.api('GET', '/auth/me', { token: legit.body.accessToken })).body.code).toBe('SESSION_REVOKED');
      expect((await c.api('POST', '/auth/refresh', { body: { scope: 'customer' }, cookies: { bb_rt_c: legit.cookies.bb_rt_c } })).status).toBe(401);
    });
    it('plusieurs appareils : liste, déconnexion d\'un appareil à distance, déconnexion simple', async () => {
      const phone = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const laptop = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const list = (await c.api('GET', '/auth/sessions', { token: laptop.token })).body;
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.filter((s: any) => s.current).length).toBe(1);
      const other = list.find((s: any) => s.id === (jwt.decode(phone.token) as any).sid);
      expect((await c.api('DELETE', `/auth/sessions/${other.id}`, { token: laptop.token })).status).toBe(204);
      expect((await c.api('GET', '/auth/me', { token: phone.token })).body.code).toBe('SESSION_REVOKED');   // effet immédiat
      expect((await c.api('GET', '/auth/me', { token: laptop.token })).status).toBe(200);
      expect((await c.api('POST', '/auth/logout', { token: laptop.token })).status).toBe(204);
      expect((await c.api('GET', '/auth/me', { token: laptop.token })).status).toBe(401);
    });
    it('on ne peut pas révoquer la session d\'un autre utilisateur', async () => {
      const a = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      const b = await customer(c);
      const sidA = (jwt.decode(a.token) as any).sid;
      expect((await c.api('DELETE', `/auth/sessions/${sidA}`, { token: b.token })).status).toBe(404);
      expect((await c.api('GET', '/auth/me', { token: a.token })).status).toBe(200);
    });
    it('session expirée côté serveur : refusée même si le jeton d\'accès est encore valide', async () => {
      const l = await login(c, 'jean@test.local', 'Nouveau-Pass-2026');
      await c.db.q(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [(jwt.decode(l.token) as any).sid]);
      expect((await c.api('GET', '/auth/me', { token: l.token })).status).toBe(401);
    });
    it('changement de mot de passe : les autres appareils sont déconnectés, pas l\'appareil courant', async () => {
      const u = await customer(c);
      const other = await login(c, u.email, u.password);
      expect((await c.api('POST', '/auth/change-password', { token: u.token, body: { currentPassword: 'faux', newPassword: 'Autre-Pass-2026' } })).status).toBe(401);
      expect((await c.api('POST', '/auth/change-password', { token: u.token, body: { currentPassword: u.password, newPassword: 'Autre-Pass-2026' } })).status).toBe(200);
      expect((await c.api('GET', '/auth/me', { token: other.token })).status).toBe(401);
      expect((await c.api('GET', '/auth/me', { token: u.token })).status).toBe(200);
    });
  });

  describe('Force brute', () => {
    it('verrouillage après trop d\'échecs, même avec le bon mot de passe ensuite ; un autre compte n\'est pas touché', async () => {
      const u = await customer(c, 'cible@test.local');
      const other = await customer(c, 'voisin@test.local');
      const max = (await c.settings.get('security')).maxLoginAttempts;
      for (let i = 0; i < max; i++) expect((await c.api('POST', '/auth/login', { body: { email: u.email, password: 'essai-' + i, scope: 'customer' } })).status).toBe(401);
      const locked = await c.api('POST', '/auth/login', { body: { email: u.email, password: u.password, scope: 'customer' } });
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      await login(c, other.email, other.password);
      // après le délai de verrouillage, la connexion redevient possible
      await c.db.q(`UPDATE login_attempts SET created_at = now() - interval '1 hour' WHERE identifier = $1`, ['customer:' + u.email]);
      await login(c, u.email, u.password);
    });
    it('limitation de débit par adresse IP sur la connexion (429 + Retry-After)', async () => {
      c.limiter.factor = 1;
      try {
        let limited: any = null;
        for (let i = 0; i < 25 && !limited; i++) {
          const r = await c.api('POST', '/auth/login', { headers: { 'x-forwarded-for': '203.0.113.9' }, body: { email: `spray${i}@test.local`, password: 'x', scope: 'customer' } });
          if (r.status === 429) limited = r;
        }
        expect(limited).not.toBeNull();
        expect(limited.body.code).toBe('RATE_LIMITED');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        // une autre adresse IP n'est pas pénalisée
        const fresh = await c.api('POST', '/auth/login', { headers: { 'x-forwarded-for': '203.0.113.77' }, body: { email: 'spray@test.local', password: 'x', scope: 'customer' } });
        expect(fresh.status).toBe(401);
      } finally { c.limiter.factor = 100000; }
    });
  });

  describe('Double authentification (TOTP)', () => {
    let secret = '', recovery: string[] = [];
    it('activation : il faut prouver que l\'application d\'authentification fonctionne', async () => {
      const s = await staff(c, admin, 'comptable', 'compta2fa@test.local');
      const st = await c.api('POST', '/auth/2fa/setup', { token: s.token });
      expect(st.body.otpauthUri).toContain('otpauth://totp/Trans%20Test:compta2fa%40test.local');
      expect(st.body.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
      secret = st.body.secret;
      expect((await c.api('POST', '/auth/2fa/enable', { token: s.token, body: { code: '000000' } })).status).toBe(400);
      const en = await c.api('POST', '/auth/2fa/enable', { token: s.token, body: { code: totpCode(secret) } });
      expect(en.status).toBe(200);
      recovery = en.body.recoveryCodes;
      expect(recovery.length).toBe(8);
      const row = await c.db.one<any>('SELECT totp_secret_enc, recovery_codes FROM users WHERE email = $1', ['compta2fa@test.local']);
      expect(row.totpSecretEnc).not.toContain(secret);                 // secret chiffré
      expect(JSON.stringify(row.recoveryCodes)).not.toContain(recovery[0]);   // codes de secours hachés
    });
    it('connexion en deux étapes : mot de passe puis code', async () => {
      const l = await c.api('POST', '/auth/login', { body: { email: 'compta2fa@test.local', password: 'Staff-Test-2026', scope: 'staff' } });
      expect(l.body.twoFactorRequired).toBe(true);
      expect(l.body.accessToken).toBeUndefined();
      expect(l.headers['set-cookie']).toBeUndefined();
      expect((await c.api('POST', '/auth/2fa/verify', { body: { challenge: l.body.challenge, code: '123456' } })).status).toBe(401);
      const ok = await c.api('POST', '/auth/2fa/verify', { body: { challenge: l.body.challenge, code: totpCode(secret) } });
      expect(ok.status).toBe(200);
      expect(ok.body.user.totpEnabled).toBe(true);
      // un défi déjà utilisé ne peut pas resservir
      expect((await c.api('POST', '/auth/2fa/verify', { body: { challenge: l.body.challenge, code: totpCode(secret) } })).status).toBe(401);
    });
    it('code de secours : utilisable une seule fois', async () => {
      const l1 = await c.api('POST', '/auth/login', { body: { email: 'compta2fa@test.local', password: 'Staff-Test-2026', scope: 'staff' } });
      expect((await c.api('POST', '/auth/2fa/verify', { body: { challenge: l1.body.challenge, code: recovery[0] } })).status).toBe(200);
      const l2 = await c.api('POST', '/auth/login', { body: { email: 'compta2fa@test.local', password: 'Staff-Test-2026', scope: 'staff' } });
      expect((await c.api('POST', '/auth/2fa/verify', { body: { challenge: l2.body.challenge, code: recovery[0] } })).status).toBe(401);
    });
    it('5 codes faux invalident le défi (pas de force brute sur 6 chiffres)', async () => {
      const l = await c.api('POST', '/auth/login', { body: { email: 'compta2fa@test.local', password: 'Staff-Test-2026', scope: 'staff' } });
      await c.db.q(`DELETE FROM login_attempts WHERE identifier LIKE '2fa:%'`);
      for (let i = 0; i < 5; i++) expect((await c.api('POST', '/auth/2fa/verify', { body: { challenge: l.body.challenge, code: '11111' + i } })).status).toBe(401);
      const r = await c.api('POST', '/auth/2fa/verify', { body: { challenge: l.body.challenge, code: totpCode(secret) } });
      expect(r.body.code).toBe('CHALLENGE_EXPIRED');
    });
    it('rôle pour lequel la double authentification est obligatoire : accès bloqué tant qu\'elle n\'est pas activée', async () => {
      const sec = (await c.api('GET', '/admin/settings', { token: admin })).body.settings.security;
      expect((await c.api('PUT', '/admin/settings/security', { token: admin, body: { ...sec, require2faRoles: ['superviseur'] } })).status).toBe(200);
      const s = await staff(c, admin, 'superviseur', 'sup2fa@test.local');
      expect(s.res.body.mustEnable2fa).toBe(true);
      const blocked = await c.api('GET', '/admin/bookings', { token: s.token });
      expect([blocked.status, blocked.body.code]).toEqual([403, 'TWO_FACTOR_SETUP_REQUIRED']);
      expect((await c.api('GET', '/auth/me', { token: s.token })).status).toBe(200);   // le profil reste accessible pour l'activer
      const st = await c.api('POST', '/auth/2fa/setup', { token: s.token });
      expect((await c.api('POST', '/auth/2fa/enable', { token: s.token, body: { code: totpCode(st.body.secret) } })).status).toBe(200);
      expect((await c.api('GET', '/admin/bookings', { token: s.token })).status).toBe(200);
      await c.api('PUT', '/admin/settings/security', { token: admin, body: { ...sec, require2faRoles: [] } });
    });
  });

  describe('Rôles et permissions vérifiés côté serveur', () => {
    it('TOUTES les routes d\'administration refusent un visiteur et un client', async () => {
      const cust = await customer(c);
      const spec = require('./routes-admin.json') as Array<[string, string]>;
      expect(spec.length).toBeGreaterThan(80);
      const id = '00000000-0000-4000-8000-000000000000';
      for (const [method, path] of spec) {
        const url = path.replace('/api/v1', '').replace(/:(\w+)/g, (_, k) => k === 'lang' ? 'fr' : k === 'code' ? 'mvola' : k === 'group' ? 'identity' : id);
        const anon = await c.api(method, url, { body: method === 'GET' ? undefined : {} });
        expect([method, path, anon.status]).toEqual([method, path, 401]);
        const asCustomer = await c.api(method, url, { token: cust.token, body: method === 'GET' ? undefined : {} });
        expect([method, path, asCustomer.status]).toEqual([method, path, 403]);
      }
    });
    it('chaque rôle intégré n\'accède qu\'à ce que ses permissions autorisent', async () => {
      const users: Record<string, string> = {};
      for (const role of ['comptable', 'superviseur', 'employe', 'chauffeur']) users[role] = (await staff(c, admin, role)).token;
      const w = await world(c, admin, { from: 'Mahajanga', to: 'Antsiranana' });
      const matrix: Array<[string, string, any, Record<string, number>]> = [
        ['GET', '/admin/dashboard', undefined, { comptable: 200, superviseur: 200, employe: 403, chauffeur: 403 }],
        ['GET', '/admin/bookings', undefined, { comptable: 200, superviseur: 200, employe: 403, chauffeur: 403 }],
        ['GET', '/admin/reports/revenue', undefined, { comptable: 200, superviseur: 200, employe: 403, chauffeur: 403 }],
        ['GET', '/admin/staff', undefined, { comptable: 403, superviseur: 200, employe: 403, chauffeur: 403 }],
        ['POST', '/admin/staff', { email: 'x@test.local', firstName: 'a', lastName: 'b', role: 'admin', password: 'Staff-Test-2026' }, { comptable: 403, superviseur: 403, employe: 403, chauffeur: 403 }],
        ['GET', '/admin/settings', undefined, { comptable: 403, superviseur: 403, employe: 403, chauffeur: 403 }],
        ['PUT', '/admin/settings/identity', { name: 'Piraté' }, { comptable: 403, superviseur: 403, employe: 403, chauffeur: 403 }],
        ['GET', '/admin/audit', undefined, { comptable: 403, superviseur: 403, employe: 403, chauffeur: 403 }],
        ['POST', '/admin/vehicles', {}, { comptable: 403, superviseur: 403, employe: 403, chauffeur: 403 }],
        ['POST', `/admin/trips/${w.tripId}/cancel`, { reason: 'test' }, { comptable: 403, superviseur: 403, employe: 403, chauffeur: 403 }],
        ['GET', `/admin/trips/${w.tripId}/manifest`, undefined, { comptable: 200, superviseur: 200, employe: 200, chauffeur: 200 }],
        ['GET', '/admin/driver-schedule', undefined, { comptable: 403, superviseur: 200, employe: 403, chauffeur: 200 }],
        ['GET', '/admin/refunds', undefined, { comptable: 200, superviseur: 200, employe: 403, chauffeur: 403 }],
        ['POST', '/tickets/verify', { code: 'ABC-123' }, { comptable: 403, superviseur: 200, employe: 200, chauffeur: 200 }],
      ];
      for (const [method, url, body, expected] of matrix)
        for (const [role, status] of Object.entries(expected)) {
          const r = await c.api(method, url, { token: users[role], body });
          expect([method, url, role, r.status === 403 ? 403 : r.status < 500 && r.status !== 401 ? 200 : r.status]).toEqual([method, url, role, status]);
        }
      expect((await c.api('PUT', '/admin/settings/identity', { token: admin, body: { name: 'Trans Test' } })).status).toBe(200);
    });
    it('la vente au guichet exige la permission dédiée (corrige la route /admin/walkin sans garde du frontend d\'origine)', async () => {
      const chauffeur = await staff(c, admin, 'chauffeur');
      const comptable = await staff(c, admin, 'comptable');
      const w = await world(c, admin, { from: 'Sambava', to: 'Manakara' });
      const body = { tripId: w.tripId, passengers: [{ seatNo: 'A1', firstName: 'A', lastName: 'B' }], contact: { name: 'A B', phone: '0340000001' }, paymentMethod: 'cash' };
      for (const t of [chauffeur.token, comptable.token]) {
        const r = await c.api('POST', '/admin/walkin', { token: t, headers: { 'idempotency-key': 'walkin-refus-1' }, body });
        expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      }
      expect((await c.db.one<any>('SELECT count(*)::int AS n FROM bookings WHERE trip_id = $1', [w.tripId])).n).toBe(0);
    });
    it('changement de rôle en cours de session : effet immédiat, le jeton en cours est refusé', async () => {
      const s = await staff(c, admin, 'superviseur', 'promu@test.local');
      expect((await c.api('GET', '/admin/bookings', { token: s.token })).status).toBe(200);
      const ch = await c.api('POST', `/admin/staff/${s.id}/role`, { token: admin, body: { role: 'chauffeur', reason: 'réaffectation' } });
      expect(ch.body.role).toBe('chauffeur');
      const stale = await c.api('GET', '/admin/bookings', { token: s.token });
      expect([stale.status, stale.body.code]).toEqual([401, 'PERMISSIONS_CHANGED']);
      // après renouvellement du jeton, les nouvelles permissions s'appliquent
      const r = await c.api('POST', '/auth/refresh', { body: { scope: 'staff' }, cookies: { bb_rt_s: s.cookies.bb_rt_s } });
      expect(r.status).toBe(200);
      expect(r.body.user.permissions.canViewBookings).toBe(false);
      expect((await c.api('GET', '/admin/bookings', { token: r.body.accessToken })).status).toBe(403);
      expect((await c.api('GET', '/admin/driver-schedule', { token: r.body.accessToken })).status).toBe(200);
      const hist = await c.db.one<any>('SELECT from_role, to_role, reason FROM role_changes WHERE user_id = $1', [s.id]);
      expect(hist).toEqual({ fromRole: 'superviseur', toRole: 'chauffeur', reason: 'réaffectation' });
    });
    it('modification des permissions d\'un rôle : appliquée immédiatement à tous les comptes de ce rôle', async () => {
      const s = await staff(c, admin, 'employe', 'guichet-perm@test.local');
      expect((await c.api('GET', '/admin/bookings', { token: s.token })).status).toBe(403);
      const roles = (await c.api('GET', '/admin/roles', { token: admin })).body;
      const employe = roles.find((r: any) => r.slug === 'employe');
      const up = await c.api('PATCH', `/admin/roles/${employe.id}`, { token: admin, body: { permissions: { ...employe.permissions, canViewBookings: true } } });
      expect(up.status).toBe(200);
      // le jeton en cours est refusé (les droits ont changé) ; après renouvellement, la nouvelle permission s'applique
      const stale = await c.api('GET', '/admin/bookings', { token: s.token });
      expect([stale.status, stale.body.code]).toEqual([401, 'PERMISSIONS_CHANGED']);
      const r1 = await c.api('POST', '/auth/refresh', { body: { scope: 'staff' }, cookies: { bb_rt_s: s.cookies.bb_rt_s } });
      expect((await c.api('GET', '/admin/bookings', { token: r1.body.accessToken })).status).toBe(200);
      expect((await c.api('POST', `/admin/roles/${employe.id}/reset`, { token: admin })).status).toBe(200);
      const r2 = await c.api('POST', '/auth/refresh', { body: { scope: 'staff' }, cookies: { bb_rt_s: r1.cookies.bb_rt_s } });
      expect((await c.api('GET', '/admin/bookings', { token: r2.body.accessToken })).status).toBe(403);
    });
    it('rôle personnalisé : création, attribution, suppression refusée tant qu\'il est utilisé', async () => {
      const perms = Object.fromEntries(Object.keys((await c.api('GET', '/admin/roles', { token: admin })).body[0].permissions).map(k => [k, k === 'canViewFleet' || k === 'canManageFleet']));
      const role = await c.api('POST', '/admin/roles', { token: admin, body: { name: 'Mécanicien', description: 'Entretien de la flotte', color: '#a855f7', permissions: perms } });
      expect(role.status).toBe(201);
      expect(role.body.isBuiltin).toBe(false);
      const m = await staff(c, admin, role.body.slug, 'meca@test.local');
      expect(m.user.permissions.canManageFleet).toBe(true);
      expect((await c.api('GET', '/admin/vehicles', { token: m.token })).status).toBe(200);
      expect((await c.api('GET', '/admin/bookings', { token: m.token })).status).toBe(403);
      expect((await c.api('DELETE', `/admin/roles/${role.body.id}`, { token: admin })).status).toBe(409);
      const admins = (await c.api('GET', '/admin/roles', { token: admin })).body.find((r: any) => r.slug === 'admin');
      expect((await c.api('DELETE', `/admin/roles/${admins.id}`, { token: admin })).status).toBe(409);   // rôle intégré non supprimable
    });
    it('garde-fous : pas d\'auto-promotion, pas d\'auto-suppression, toujours au moins un administrateur', async () => {
      const me = (await c.api('GET', '/auth/me', { token: admin })).body;
      expect((await c.api('POST', `/admin/staff/${me.id}/role`, { token: admin, body: { role: 'employe' } })).status).toBe(409);
      expect((await c.api('DELETE', `/admin/staff/${me.id}`, { token: admin })).status).toBe(409);
      expect((await c.api('PATCH', `/admin/staff/${me.id}`, { token: admin, body: { status: 'suspended' } })).status).toBe(409);
    });
    it('compte suspendu : toutes ses sessions sont coupées et la connexion est refusée', async () => {
      const s = await staff(c, admin, 'employe', 'suspendu@test.local');
      expect((await c.api('PATCH', `/admin/staff/${s.id}`, { token: admin, body: { status: 'suspended' } })).status).toBe(200);
      expect((await c.api('GET', '/auth/me', { token: s.token })).status).toBeGreaterThanOrEqual(401);
      expect((await c.api('POST', '/auth/login', { body: { email: s.email, password: s.password, scope: 'staff' } })).status).toBe(403);
      expect((await c.api('POST', '/auth/refresh', { body: { scope: 'staff' }, cookies: { bb_rt_s: s.cookies.bb_rt_s } })).status).toBeGreaterThanOrEqual(401);
    });
    it('compte interne créé sans mot de passe : lien d\'activation à usage unique envoyé par e-mail', async () => {
      const r = await c.api('POST', '/admin/staff', { token: admin, body: { email: 'invite@test.local', firstName: 'In', lastName: 'Vité', role: 'employe' } });
      expect(r.status).toBe(201);
      const token = new URL(r.body.setPasswordUrl).searchParams.get('token')!;
      expect((await c.api('POST', '/auth/login', { body: { email: 'invite@test.local', password: '', scope: 'staff' } })).status).toBe(400);
      expect((await c.api('POST', '/auth/reset-password', { body: { token, password: 'Mon-Choix-2026' } })).status).toBe(200);
      await login(c, 'invite@test.local', 'Mon-Choix-2026', 'staff');
      expect((await c.db.one<any>(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'staff_welcome' AND recipient = 'invite@test.local'`)).n).toBe(1);
    });
  });
});
