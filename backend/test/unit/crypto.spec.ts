process.env.NODE_ENV = 'test';
import { base32Decode, base32Encode, decrypt, decryptFromString, encrypt, encryptToString, randomCode, randomToken, safeEqual, sha256, totpCode, totpSecret, totpUri, totpVerify } from '../../src/common/crypto';
import { resetEnvCache } from '../../src/common/env';

describe('Chiffrement des secrets (AES-256-GCM)', () => {
  it('chiffre puis déchiffre', () => {
    const e = encrypt('clé-api-très-secrète');
    expect(e.ciphertext.toString('utf8')).not.toContain('secrète');
    expect(decrypt(e.ciphertext, e.iv, e.tag)).toBe('clé-api-très-secrète');
  });
  it('deux chiffrements du même texte diffèrent (IV aléatoire)', () => {
    expect(encryptToString('abc')).not.toBe(encryptToString('abc'));
    expect(decryptFromString(encryptToString('abc'))).toBe('abc');
  });
  it('un texte chiffré altéré est rejeté (authentification GCM)', () => {
    const e = encrypt('secret');
    e.ciphertext[0] ^= 1;
    expect(() => decrypt(e.ciphertext, e.iv, e.tag)).toThrow();
  });
  it('une autre clé maîtresse ne déchiffre pas', () => {
    const e = encrypt('secret');
    const before = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = 'une-autre-cle-maitresse-de-plus-de-32-caracteres';
    resetEnvCache();
    expect(() => decrypt(e.ciphertext, e.iv, e.tag)).toThrow();
    if (before === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = before;
    resetEnvCache();
  });
});

describe('Double authentification TOTP (RFC 6238)', () => {
  // Vecteurs de test officiels de la RFC 6238 (SHA-1, secret ASCII « 12345678901234567890 »), tronqués à 6 chiffres.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']])('vecteur RFC à t=%i s → %s', (t, code) => {
    expect(totpCode(secret, t * 1000)).toBe(code);
  });
  it('accepte le code courant et celui de la fenêtre voisine (dérive d\'horloge de 30 s)', () => {
    const s = totpSecret(), now = Date.UTC(2026, 10, 11, 12, 0, 0);
    expect(totpVerify(s, totpCode(s, now), now)).toBe(true);
    expect(totpVerify(s, totpCode(s, now - 30000), now)).toBe(true);
    expect(totpVerify(s, totpCode(s, now + 30000), now)).toBe(true);
    expect(totpVerify(s, totpCode(s, now - 120000), now)).toBe(false);
  });
  it('refuse un code mal formé', () => {
    const s = totpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5']) expect(totpVerify(s, bad)).toBe(false);
    expect(totpVerify(s, ' ' + totpCode(s) + ' ')).toBe(true);
  });
  it('base32 aller-retour', () => {
    const b = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('URI otpauth lisible par les applications d\'authentification', () => {
    const u = totpUri('ABC', 'admin@test.local', 'Ma Compagnie');
    expect(u).toContain('otpauth://totp/Ma%20Compagnie:admin%40test.local?secret=ABC');
    expect(u).toContain('issuer=Ma%20Compagnie');
  });
});

describe('Utilitaires', () => {
  it('safeEqual compare sans fuite de longueur', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('sha256, jetons et codes aléatoires', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken(48).length).toBeGreaterThanOrEqual(64);
    const c = randomCode(7);
    expect(c).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7}$/);   // sans caractères ambigus (0/O, 1/I)
  });
});
