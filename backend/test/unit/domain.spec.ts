process.env.NODE_ENV = 'test';
import { BUILTIN_ROLES, PERMISSIONS, normalizePermissions } from '../../src/common/permissions';
import { BUILTIN_LAYOUTS, DEFAULT_COMPANY_NAME, SETTING_GROUPS, SETTING_SCHEMAS, bookingSchema, identitySchema, layoutSeats, localeSchema } from '../../src/modules/settings/schemas';
import { derivePrefix } from '../../src/modules/settings/settings.service';
import { formatMoney, parseQr, qrPayload } from '../../src/modules/tickets/tickets.service';
import { sanitizeHtml } from '../../src/modules/notifications/notifications.service';
import { DEFAULT_TEMPLATES, TEMPLATE_CODES, TEMPLATE_VARIABLES } from '../../src/modules/notifications/templates';
import { normalizePhone, zDate, zEmail, zMoney, zPassword, zPhone, zSeat, zTime } from '../../src/common/zod';
import { webhookSignature } from '../../src/modules/payments/payments.service';
import * as fs from 'fs';
import * as path from 'path';

describe('Marque blanche : aucune valeur de société en dur', () => {
  it('le nom par défaut est neutre', () => {
    expect(DEFAULT_COMPANY_NAME).toBe('Ma Compagnie');
    expect(identitySchema.parse({}).name).toBe('Ma Compagnie');
  });
  it('chaque groupe de paramètres a des valeurs par défaut valides (l\'assistant peut tout passer)', () => {
    for (const g of SETTING_GROUPS) expect(() => SETTING_SCHEMAS[g].parse({})).not.toThrow();
  });
  it('aucune occurrence de « soatrans » dans le code du backend ni dans les migrations', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = [...walk(path.resolve(__dirname, '../../src')), ...walk(path.resolve(__dirname, '../../migrations'))];
    const hits = files.filter(f => /soatrans/i.test(fs.readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
  it('préfixe des références déduit du nom de la société', () => {
    expect(derivePrefix('Ma Compagnie')).toBe('MAC');
    expect(derivePrefix('Trans Sud Express')).toBe('TSE');
    expect(derivePrefix('Éclair')).toBe('ECL');
    expect(derivePrefix('')).toBe('BUS');
    expect(derivePrefix('A')).toBe('AXX');
  });
  it('les modèles d\'e-mails n\'utilisent que des variables déclarées, dans les langues de base', () => {
    for (const code of TEMPLATE_CODES) {
      expect(DEFAULT_TEMPLATES[code].fr).toBeDefined();
      const allowed = new Set([...TEMPLATE_VARIABLES[code], 'company_name', 'company_phone', 'company_email', 'company_website']);
      for (const [lang, t] of Object.entries(DEFAULT_TEMPLATES[code])) {
        const used = [...`${t.subject} ${t.body} ${t.sms ?? ''}`.matchAll(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi)].map(m => m[1]);
        for (const v of used) expect([code, lang, v, allowed.has(v)]).toEqual([code, lang, v, true]);
      }
    }
  });
});

describe('Paramètres', () => {
  it('refuse les champs inconnus', () => {
    expect(() => identitySchema.parse({ name: 'X', isAdmin: true })).toThrow();
  });
  it('la langue par défaut doit être activée', () => {
    expect(() => localeSchema.parse({ defaultLang: 'en', enabledLangs: ['fr'] })).toThrow();
    expect(localeSchema.parse({ defaultLang: 'en', enabledLangs: ['fr', 'en'] }).defaultLang).toBe('en');
  });
  it('refuse un fuseau horaire inconnu et une couleur invalide', () => {
    expect(() => localeSchema.parse({ timezone: 'Mars/Olympus' })).toThrow();
    expect(() => identitySchema.parse({ primaryColor: 'red' })).toThrow();
  });
  it('borne les réglages de réservation', () => {
    expect(() => bookingSchema.parse({ seatHoldMinutes: 0 })).toThrow();
    expect(() => bookingSchema.parse({ maxPassengers: 500 })).toThrow();
    expect(bookingSchema.parse({}).seatHoldMinutes).toBe(10);
    expect(bookingSchema.parse({}).salesCloseMinutes).toBe(30);
  });
});

describe('Plans de sièges', () => {
  it('les trois plans d\'origine ont la bonne capacité et des sièges uniques', () => {
    const caps: Record<string, number> = { bus: 48, minibus16: 16, minibus10: 10 };
    for (const l of BUILTIN_LAYOUTS) {
      const seats = layoutSeats(l.rows);
      expect(seats.length).toBe(caps[l.code]);
      expect(l.capacity).toBe(caps[l.code]);
      expect(new Set(seats).size).toBe(seats.length);
      for (const s of seats) expect(zSeat.safeParse(s).success).toBe(true);
    }
  });
});

describe('Rôles et permissions', () => {
  it('les 5 rôles intégrés existent, l\'administrateur a tout', () => {
    expect(BUILTIN_ROLES.map(r => r.slug)).toEqual(['admin', 'comptable', 'superviseur', 'employe', 'chauffeur']);
    const admin = BUILTIN_ROLES.find(r => r.slug === 'admin')!;
    expect(PERMISSIONS.every(p => admin.permissions[p])).toBe(true);
  });
  it('la vente au guichet n\'est plus ouverte à tous : le chauffeur et le comptable ne l\'ont pas', () => {
    const p = (slug: string) => BUILTIN_ROLES.find(r => r.slug === slug)!.permissions;
    expect(p('employe').canSellWalkin).toBe(true);
    expect(p('chauffeur').canSellWalkin).toBe(false);
    expect(p('comptable').canSellWalkin).toBe(false);
    expect(p('comptable').canRefund).toBe(true);
    expect(p('chauffeur').canViewOwnSchedule).toBe(true);
  });
  it('normalizePermissions ignore les clés inconnues et les valeurs non booléennes', () => {
    const n = normalizePermissions({ canViewDashboard: true, canRefund: 'yes', hack: true });
    expect(n.canViewDashboard).toBe(true);
    expect(n.canRefund).toBe(false);
    expect((n as any).hack).toBeUndefined();
    expect(Object.keys(n).length).toBe(PERMISSIONS.length);
  });
});

describe('Billet : QR code et montants', () => {
  it('QR signé : accepté tel quel, rejeté si le numéro ou la signature sont modifiés', () => {
    const q = qrPayload('MAC-ABC1234-1', 'signed');
    expect(q.startsWith('BB1.MAC-ABC1234-1.')).toBe(true);
    expect(parseQr(q)).toEqual({ ticketNumber: 'MAC-ABC1234-1', signed: true, valid: true });
    expect(parseQr(q.replace('ABC1234-1', 'ABC1234-2')).valid).toBe(false);
    expect(parseQr(q.slice(0, -1) + (q.endsWith('A') ? 'B' : 'A')).valid).toBe(false);
    expect(parseQr('BB1.MAC-ABC1234-1').valid).toBe(false);
  });
  it('QR au format « référence » et saisie manuelle', () => {
    expect(qrPayload('MAC-ABC1234-1', 'reference')).toBe('MAC-ABC1234-1');
    expect(parseQr(' mac-abc1234-1 ')).toEqual({ ticketNumber: 'MAC-ABC1234-1', signed: false, valid: true });
  });
  it('formatMoney suit la devise configurée', () => {
    const plain = (x: string) => x.replace(/[\u00a0\u202f]/g, ' ');   // le séparateur de milliers « espace » est insécable
    expect(plain(formatMoney(35000, { currencySymbol: 'Ar', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ' }))).toBe('35 000 Ar');
    expect(plain(formatMoney(123456, { currencySymbol: '€', currencyPosition: 'after', currencyDecimals: 2, thousandsSeparator: ' ' }))).toBe('1 234,56 €');
    expect(plain(formatMoney(150000, { currencySymbol: '$', currencyPosition: 'before', currencyDecimals: 2, thousandsSeparator: ',' }))).toBe('$ 1,500.00');
    expect(plain(formatMoney(150000, { currencySymbol: '€', currencyPosition: 'after', currencyDecimals: 2, thousandsSeparator: '.' }))).toBe('1.500,00 €');
    expect(plain(formatMoney(0, { currencySymbol: 'Ar', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: '' }))).toBe('0 Ar');
  });
  it('la signature d\'un callback dépend du paiement et du moyen de paiement', () => {
    expect(webhookSignature('mvola', 'a')).not.toBe(webhookSignature('mvola', 'b'));
    expect(webhookSignature('mvola', 'a')).not.toBe(webhookSignature('orange_money', 'a'));
    expect(webhookSignature('mvola', 'a')).toBe(webhookSignature('mvola', 'a'));
  });
});

describe('Validation des entrées', () => {
  it('e-mail', () => {
    expect(zEmail.parse('  Jean.Dupont@Example.COM ')).toBe('jean.dupont@example.com');
    for (const bad of ['', 'a@b', 'a b@c.fr', '@c.fr', 'a@@c.fr']) expect(zEmail.safeParse(bad).success).toBe(false);
  });
  it('téléphone', () => {
    for (const ok of ['0341234567', '+261 34 12 345 67', '034-12-345-67']) expect(zPhone.safeParse(ok).success).toBe(true);
    for (const bad of ['123', 'abcdefgh', '034<script>', "0341234567'; DROP TABLE users;--"]) expect(zPhone.safeParse(bad).success).toBe(false);
    expect(normalizePhone('+261 34 12 345 67')).toBe('+261341234567');
  });
  it('date et heure', () => {
    expect(zDate.safeParse('2026-11-30').success).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '30/11/2026', '2026-11-3', '']) expect(zDate.safeParse(bad).success).toBe(false);
    for (const ok of ['00:00', '23:59', '08:30']) expect(zTime.safeParse(ok).success).toBe(true);
    for (const bad of ['24:00', '8:30', '08:60', '']) expect(zTime.safeParse(bad).success).toBe(false);
  });
  it('montant : entier positif uniquement', () => {
    expect(zMoney.safeParse(15000).success).toBe(true);
    for (const bad of [-1, 1.5, NaN, Infinity, '15000' as any]) expect(zMoney.safeParse(bad).success).toBe(false);
  });
  it('siège', () => {
    for (const ok of ['A1', 'L4', 'F2', 'AB12']) expect(zSeat.safeParse(ok).success).toBe(true);
    for (const bad of ['a1', '1A', 'A', 'A123', "A1' OR '1'='1", '']) expect(zSeat.safeParse(bad).success).toBe(false);
  });
  it('mot de passe fort exigé', () => {
    expect(zPassword.safeParse('Admin-Test-2026').success).toBe(true);
    for (const bad of ['court1A', 'toutenminuscules1', 'TOUTENMAJUSCULES1', 'SansChiffreDuTout']) expect(zPassword.safeParse(bad).success).toBe(false);
  });
});

describe('Assainissement des modèles d\'e-mail', () => {
  it('retire scripts, gestionnaires d\'événements et URL javascript:', () => {
    const out = sanitizeHtml(`<p onclick="steal()">Bonjour</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="//evil"></iframe><img src=x onerror=alert(1)>`);
    expect(out).not.toMatch(/<script|onclick|onerror|javascript:|<iframe/i);
    expect(out).toContain('Bonjour');
  });
  it('conserve la mise en forme légitime', () => {
    const html = '<p style="color:red"><b>Bonjour</b> {{customer_name}}</p><a class="btn" href="{{booking_url}}">Voir</a>';
    expect(sanitizeHtml(html)).toBe(html);
  });
});
