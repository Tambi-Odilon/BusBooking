import { Injectable } from '@nestjs/common';
import { Db } from './db';
import { AppError } from './errors';
import { sha256 } from './crypto';

/**
 * Idempotence des requêtes sensibles (réservation, paiement).
 * Même clé + même contenu → même réponse, sans rejouer l'opération.
 * Même clé + contenu différent → 422.
 */
@Injectable()
export class Idempotency {
  constructor(private db: Db) {}
  static key(headers: any): string {
    const k = String(headers?.['idempotency-key'] || '').trim();
    if (!k) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'En-tête Idempotency-Key requis');
    if (k.length < 8 || k.length > 128) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, 'Idempotency-Key : 8 à 128 caractères');
    return k;
  }
  async run<T>(scope: string, key: string, body: any, fn: () => Promise<T>): Promise<T> {
    const hash = sha256(JSON.stringify(body ?? {}));
    const inserted = await this.db.maybe(
      `INSERT INTO idempotency_keys (scope, key, request_hash, expires_at) VALUES ($1,$2,$3, now() + interval '24 hours')
       ON CONFLICT (scope, key) DO NOTHING RETURNING key`, [scope, key, hash]);
    if (inserted) {
      try {
        const result = await fn();
        await this.db.q(`UPDATE idempotency_keys SET response = $3, status_code = 200 WHERE scope = $1 AND key = $2`, [scope, key, JSON.stringify(result ?? null)]);
        return result;
      } catch (e) {
        // échec : on libère la clé pour qu'un nouvel essai soit possible
        await this.db.q(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [scope, key]).catch(() => {});
        throw e;
      }
    }
    // la clé existe : requête rejouée (double clic, rafraîchissement, nouvel essai réseau)
    for (let i = 0; i < 100; i++) {
      const row = await this.db.maybe<any>(`SELECT request_hash, status_code, response FROM idempotency_keys WHERE scope = $1 AND key = $2`, [scope, key]);
      if (!row) return this.run(scope, key, body, fn);            // la première tentative a échoué entre-temps
      if (row.requestHash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 422, 'Cette clé d\'idempotence a déjà servi pour une autre requête');
      if (row.statusCode) return row.response as T;
      await new Promise(r => setTimeout(r, 100));                 // première tentative encore en cours
    }
    throw new AppError('IDEMPOTENCY_IN_PROGRESS', 409, 'Requête identique encore en cours de traitement');
  }
}
