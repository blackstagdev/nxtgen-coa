import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { APP_ROOT, loadConfig } from '../config.js';
import { createPool } from './pool.js';

export const MIGRATIONS_DIR = path.join(APP_ROOT, 'migrations');

/** Applies pending *.sql migrations in filename order, each in its own transaction. */
export async function migrate(pool: pg.Pool, log: (m: string) => void = console.log): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Serialise concurrent deploys
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
      log(`[migrate] applying ${f}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    if (!applied.length) log('[migrate] database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  const pool = createPool(cfg);
  migrate(pool)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
