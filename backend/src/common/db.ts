import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { env } from './env';
import { AppError } from './errors';

types.setTypeParser(20, v => Number(v));          // int8 → number (montants en unités mineures)
types.setTypeParser(1700, v => Number(v));        // numeric
types.setTypeParser(1082, v => v);                // date → 'YYYY-MM-DD' (jamais de Date locale)
types.setTypeParser(1083, v => v.slice(0, 5));    // time → 'HH:mm'

const camelCache = new Map<string, string>();
const camelKey = (k: string) => { let c = camelCache.get(k); if (!c) { c = k.replace(/_([a-z0-9])/g, (_, x) => x.toUpperCase()); camelCache.set(k, c); } return c; };
export const snake = (k: string) => k.replace(/[A-Z]/g, x => '_' + x.toLowerCase());
function camelRows<T>(rows: any[]): T[] {
  return rows.map(r => { const o: any = {}; for (const k in r) o[camelKey(k)] = r[k]; return o; });
}
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => { if (!IDENT.test(s)) throw new Error('identifiant SQL invalide : ' + s); return s; };

export interface Queryable {
  q<T = any>(text: string, params?: any[]): Promise<T[]>;
  one<T = any>(text: string, params?: any[]): Promise<T>;
  maybe<T = any>(text: string, params?: any[]): Promise<T | null>;
  insert<T = any>(table: string, row: Record<string, any>): Promise<T>;
  update<T = any>(table: string, id: string, patch: Record<string, any>, idCol?: string): Promise<T | null>;
}

abstract class Base implements Queryable {
  protected abstract run(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
  async q<T = any>(text: string, params?: any[]): Promise<T[]> { return camelRows<T>((await this.run(text, params)).rows); }
  async exec(text: string, params?: any[]): Promise<number> { return (await this.run(text, params)).rowCount ?? 0; }
  async maybe<T = any>(text: string, params?: any[]): Promise<T | null> { return (await this.q<T>(text, params))[0] ?? null; }
  async one<T = any>(text: string, params?: any[]): Promise<T> {
    const r = await this.maybe<T>(text, params); if (!r) throw new AppError('NOT_FOUND', 404, 'Introuvable'); return r;
  }
  /** INSERT générique. Les clés (camelCase) viennent toujours de schémas validés, jamais du client brut. */
  async insert<T = any>(table: string, row: Record<string, any>): Promise<T> {
    const keys = Object.keys(row).filter(k => row[k] !== undefined);
    const cols = keys.map(k => ident(snake(k)));
    const sql = `INSERT INTO ${ident(table)} (${cols.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`;
    return this.one<T>(sql, keys.map(k => prep(row[k])));
  }
  async update<T = any>(table: string, id: string, patch: Record<string, any>, idCol = 'id'): Promise<T | null> {
    const keys = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!keys.length) return this.maybe<T>(`SELECT * FROM ${ident(table)} WHERE ${ident(idCol)} = $1`, [id]);
    const sets = keys.map((k, i) => `${ident(snake(k))} = $${i + 2}`);
    return this.maybe<T>(`UPDATE ${ident(table)} SET ${sets.join(', ')} WHERE ${ident(idCol)} = $1 RETURNING *`, [id, ...keys.map(k => prep(patch[k]))]);
  }
}
/** Les objets et tableaux d'objets partent en JSON ; les tableaux de scalaires restent des tableaux PostgreSQL. */
function prep(v: any): any {
  if (v === null || v === undefined || v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.some(x => x !== null && typeof x === 'object') ? JSON.stringify(v) : v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export class Tx extends Base {
  private hooks: Array<() => void | Promise<void>> = [];
  constructor(private client: PoolClient) { super(); }
  protected run(text: string, params?: any[]) { return this.client.query(text, params); }
  /** Sous-transaction : si `fn` échoue, seules ses écritures sont annulées et la transaction englobante continue. */
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = 'sp_' + (++this.spSeq);
    await this.client.query('SAVEPOINT ' + name);
    try { const r = await fn(); await this.client.query('RELEASE SAVEPOINT ' + name); return r; }
    catch (e) { await this.client.query('ROLLBACK TO SAVEPOINT ' + name); throw e; }
  }
  private spSeq = 0;
  /** Action exécutée seulement si la transaction est validée (événements temps réel, etc.). */
  afterCommit(fn: () => void | Promise<void>) { this.hooks.push(fn); }
  async flush() { for (const h of this.hooks) { try { await h(); } catch { /* un événement perdu ne doit pas casser la requête */ } } }
}

/** Vrai pendant l'exécution d'une transaction : sert à interdire d'emprunter une seconde connexion au pool depuis une transaction
 *  (sous forte charge, toutes les connexions seraient tenues par des transactions qui en attendent une autre : blocage général). */
const inTx = new AsyncLocalStorage<boolean>();

@Injectable()
export class Db extends Base implements OnModuleDestroy {
  readonly pool: Pool;
  /** Petit pool réservé aux lectures de configuration : ne dépend jamais de la disponibilité du pool principal. */
  readonly side: Pool;
  constructor() {
    super();
    const e = env();
    this.pool = new Pool({ connectionString: e.databaseUrl, max: e.dbPoolMax, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    this.pool.on('error', () => { /* connexion inactive perdue : le pool en recrée une */ });
    this.side = new Pool({ connectionString: e.databaseUrl, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    this.side.on('error', () => { /* idem */ });
  }
  /** Délestage : si trop de requêtes attendent une connexion, on répond 503 plutôt que de s'effondrer. */
  private guard() {
    if (inTx.getStore()) {
      const err = new Error('Requête hors transaction lancée depuis une transaction : passer la transaction `t` à cette fonction');
      if (env().nodeEnv !== 'production') throw err;   // détecté par les tests ; en production on laisse passer
    }
    if (this.pool.waitingCount > env().dbMaxWaiting) throw new AppError('SERVER_BUSY', 503, 'Serveur très sollicité, réessayez dans quelques secondes', undefined, { 'Retry-After': '3' });
  }
  protected run(text: string, params?: any[]) { this.guard(); return this.pool.query(text, params); }

  async tx<T>(fn: (t: Tx) => Promise<T>, opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {}): Promise<T> {
    this.guard();
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      const t = new Tx(client);
      try {
        await client.query('BEGIN' + (opts.isolation ? ' ISOLATION LEVEL ' + opts.isolation.toUpperCase() : ''));
        const result = await inTx.run(true, () => fn(t));
        await client.query('COMMIT');
        client.release();
        await inTx.run(false, () => t.flush());
        return result;
      } catch (e: any) {
        try { await client.query('ROLLBACK'); } catch { /* connexion déjà perdue */ }
        client.release();
        // interblocage ou échec de sérialisation : on rejoue (3 essais)
        if ((e?.code === '40P01' || e?.code === '40001') && attempt < 3) { await new Promise(r => setTimeout(r, 20 * attempt + Math.random() * 30)); continue; }
        throw e;
      }
    }
  }
  /** Exécute `fn` seulement si le verrou consultatif est libre (une seule instance exécute une tâche planifiée). */
  async withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
      if (!rows[0].ok) return undefined;
      try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [key]); }
    } finally { client.release(); }
  }
  /** Lecture sur le pool réservé (utilisable depuis n'importe où, y compris une transaction). */
  async sideQuery<T = any>(text: string, params?: any[]): Promise<T[]> {
    const r = await this.side.query(text, params);
    return r.rows.map(row => { const o: any = {}; for (const k in row) o[camelKey(k)] = row[k]; return o; });
  }
  async onModuleDestroy() { await Promise.all([this.pool.end(), this.side.end()]); }
}

export interface Page<T> { items: T[]; total: number; page: number; limit: number }
export function paging(query: any, maxLimit = 100, defLimit = 25) {
  const page = Math.max(1, Math.floor(Number(query?.page) || 1));
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(Number(query?.limit) || defLimit)));
  return { page, limit, offset: (page - 1) * limit };
}
