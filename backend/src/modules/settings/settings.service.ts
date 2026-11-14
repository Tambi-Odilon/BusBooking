import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';
import { decrypt, encrypt } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { BUILTIN_ROLES } from '../../common/permissions';
import { BUILTIN_LAYOUTS, DEFAULT_PAYMENT_METHODS, PAYMENT_SECRET_FIELDS, SETTING_GROUPS, SETTING_SCHEMAS, SettingGroup, Settings } from './schemas';

@Injectable()
export class SettingsService {
  private cache: { at: number; value: Settings; setupCompleted: boolean } | null = null;
  constructor(private db: Db) {}

  invalidate() { this.cache = null; this.generation++; }

  private loading: Promise<{ at: number; value: Settings; setupCompleted: boolean }> | null = null;
  /** Cache de 3 s, une seule lecture à la fois (les requêtes simultanées partagent le même aller-retour),
   *  sur un pool réservé : la configuration reste lisible même quand le pool principal est saturé. */
  private async load(): Promise<{ value: Settings; setupCompleted: boolean }> {
    if (this.cache && Date.now() - this.cache.at < 3000) return this.cache;
    if (!this.loading) {
      const gen = this.generation;
      this.loading = (async () => {
        const rows = await this.db.sideQuery<{ key: string; value: any }>('SELECT key, value FROM app_settings');
        const stored = Object.fromEntries(rows.map(r => [r.key, r.value]));
        const value: any = {};
        for (const g of SETTING_GROUPS) {
          const parsed = SETTING_SCHEMAS[g].safeParse(stored[g] ?? {});
          // une valeur stockée devenue invalide (changement de version) ne doit jamais bloquer l'application
          value[g] = parsed.success ? parsed.data : SETTING_SCHEMAS[g].parse({});
        }
        const st = (await this.db.sideQuery<{ status: string }>('SELECT status FROM setup_state WHERE id = 1'))[0];
        const fresh = { at: Date.now(), value, setupCompleted: st?.status === 'completed' };
        if (gen === this.generation) this.cache = fresh;     // une modification arrivée entre-temps invalide cette lecture
        return fresh;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }
  private generation = 0;
  async all(): Promise<Settings> { return (await this.load()).value; }
  async get<K extends SettingGroup>(group: K): Promise<Settings[K]> { return (await this.load()).value[group]; }
  async setupCompleted(): Promise<boolean> { return (await this.load()).setupCompleted; }

  async set<K extends SettingGroup>(group: K, input: unknown, userId: string | null, t: Queryable = this.db): Promise<Settings[K]> {
    const value = SETTING_SCHEMAS[group].parse(input ?? {});
    await t.q(`INSERT INTO app_settings (key, value, updated_by) VALUES ($1,$2,$3)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [group, JSON.stringify(value), userId]);
    this.invalidate();
    (t as any).afterCommit?.(() => this.invalidate());   // modification faite dans une transaction : on relit après validation
    return value as Settings[K];
  }

  // ── Secrets chiffrés ───────────────────────────────────────────────────────
  async setSecret(key: string, value: string, t: Queryable = this.db) {
    if (!/^[a-z_]+\.[a-zA-Z]+$/.test(key)) throw new AppError('INVALID_SECRET_KEY', 400);
    if (!value) { await t.q('DELETE FROM app_secrets WHERE key = $1', [key]); return; }
    const e = encrypt(value);
    const hint = '••••' + (value.length > 8 ? value.slice(-4) : '');
    await t.q(`INSERT INTO app_secrets (key, ciphertext, iv, tag, hint) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, hint = EXCLUDED.hint, updated_at = now()`,
      [key, e.ciphertext, e.iv, e.tag, hint]);
  }
  async getSecret(key: string): Promise<string | null> {
    const r = await this.db.maybe<any>('SELECT ciphertext, iv, tag FROM app_secrets WHERE key = $1', [key]);
    if (!r) return null;
    try { return decrypt(r.ciphertext, r.iv, r.tag); } catch { return null; }   // clé maîtresse changée : secret à ressaisir
  }
  async secretHints(): Promise<Record<string, string>> {
    const rows = await this.db.q<{ key: string; hint: string }>('SELECT key, hint FROM app_secrets');
    return Object.fromEntries(rows.map(r => [r.key, r.hint]));
  }
  async paymentSecrets(code: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of PAYMENT_SECRET_FIELDS[code] ?? []) { const v = await this.getSecret(`${code}.${f}`); if (v) out[f] = v; }
    return out;
  }

  // ── Moyens de paiement ─────────────────────────────────────────────────────
  paymentMethods() { return this.db.q<any>('SELECT * FROM payment_methods ORDER BY sort_order, code'); }
  async paymentMethod(code: string) { return this.db.maybe<any>('SELECT * FROM payment_methods WHERE code = $1', [code]); }

  /** Données de référence indispensables (idempotent, exécuté au démarrage après les migrations). */
  async ensureReferenceData() {
    for (const r of BUILTIN_ROLES)
      await this.db.q(`INSERT INTO roles (slug, name, description, color, is_builtin, permissions) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT (slug) DO NOTHING`,
        [r.slug, r.name, r.description, r.color, JSON.stringify(r.permissions)]);
    for (const l of BUILTIN_LAYOUTS)
      await this.db.q(`INSERT INTO seat_layouts (code, name, capacity, rows, is_builtin) VALUES ($1,$2,$3,$4,true) ON CONFLICT (code) DO NOTHING`,
        [l.code, l.name, l.capacity, JSON.stringify(l.rows)]);
    for (const m of DEFAULT_PAYMENT_METHODS)
      await this.db.q(`INSERT INTO payment_methods (code, name, kind, online, enabled, sort_order, public_config) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
        [m.code, m.name, m.kind, m.online, m.enabled, m.sortOrder, JSON.stringify(m.publicConfig)]);
  }

  /** Ce que le navigateur a le droit de connaître. Aucun secret, aucune configuration SMTP. */
  async publicConfig() {
    const { value: s, setupCompleted } = await this.load();
    const methods = await this.paymentMethods();
    const prefix = s.identity.referencePrefix || derivePrefix(s.identity.name);
    return {
      setupCompleted,
      identity: { ...s.identity, referencePrefix: prefix },
      contact: s.contact,
      legal: {
        registrationNumbers: s.legal.registrationNumbers, taxEnabled: s.legal.taxEnabled, taxName: s.legal.taxName,
        taxRatePercent: s.legal.taxRatePercent, taxIncluded: s.legal.taxIncluded, termsText: s.legal.termsText,
        cancellationPolicyText: s.legal.cancellationPolicyText, privacyText: s.legal.privacyText, ticketLegalNotice: s.legal.ticketLegalNotice,
      },
      locale: s.locale,
      booking: {
        seatHoldMinutes: s.booking.seatHoldMinutes, paymentTimeoutMinutes: s.booking.paymentTimeoutMinutes, maxPassengers: s.booking.maxPassengers,
        serviceFee: s.booking.serviceFee, serviceFeeMode: s.booking.serviceFeeMode, salesCloseMinutes: s.booking.salesCloseMinutes,
        salesHorizonDays: s.booking.salesHorizonDays, allowGuestCheckout: s.booking.allowGuestCheckout,
        cancellation: s.booking.cancellation, change: s.booking.change, child: s.booking.child, baggage: s.booking.baggage,
      },
      ticket: s.ticket,
      payments: methods.filter(m => m.enabled).map(m => ({
        code: m.code, name: m.name, kind: m.kind, online: m.online, mode: m.mode,
        info: { merchantNumber: m.publicConfig?.merchantNumber || '', prefixes: m.publicConfig?.prefixes || '' },
      })),
      storagePrefix: 'bb_',
    };
  }
}

/** Préfixe des références de billet déduit du nom de la société (3 lettres), ex. « Ma Compagnie » → MAC. */
export function derivePrefix(name: string): string {
  const letters = name.normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase();
  const words = letters.split(/\s+/).filter(Boolean);
  const p = words.length >= 3 ? words.slice(0, 3).map(w => w[0]).join('') : letters.replace(/\s/g, '').slice(0, 3);
  return (p || 'BUS').padEnd(3, 'X');
}
