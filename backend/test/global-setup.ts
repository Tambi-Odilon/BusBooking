import { Client } from 'pg';

/** Crée la base de test si elle n'existe pas. Chaque fichier de test repart ensuite d'un schéma vide (voir helpers.ts). */
export default async function globalSetup() {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
  const name = process.env.TEST_DATABASE_NAME || 'bb_test';
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}
