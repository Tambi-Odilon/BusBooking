import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { env } from './common/env';

/** Applique les fichiers migrations/*.sql manquants, dans l'ordre, chacun dans sa transaction. Un verrou évite deux exécutions simultanées. */
export async function runMigrations(pool: Pool, dir = process.env.MIGRATIONS_DIR || path.resolve(__dirname, '..', 'migrations')): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7426000)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN'); await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT'); applied.push(file);
      } catch (e) { await client.query('ROLLBACK'); throw new Error(`Migration ${file} en échec : ${(e as Error).message}`); }
    }
  } finally { await client.query('SELECT pg_advisory_unlock(7426000)').catch(() => {}); client.release(); }
  return applied;
}
if (require.main === module) {
  const pool = new Pool({ connectionString: env().databaseUrl });
  runMigrations(pool).then(a => { console.log(a.length ? `Migrations appliquées : ${a.join(', ')}` : 'Base déjà à jour'); return pool.end(); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
