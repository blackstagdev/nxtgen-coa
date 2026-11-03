/**
 * Development-only PostgreSQL stand-in (PGlite over the Postgres wire protocol),
 * for machines without a local Postgres/Docker. Production uses Render Postgres.
 *
 *   npm run db:local            # persistent, data in app/.local-db, port 5433
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres DATABASE_POOL_MAX=1 npm run dev
 */
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { APP_ROOT } from '../src/config.js';

const port = Number(process.env.LOCAL_DB_PORT || 5433);
const dir = process.argv.includes('--memory') ? undefined : path.join(APP_ROOT, '.local-db');

const db = await PGlite.create(dir);
// One connection: PGlite is single-session, so transactions must not interleave.
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
await server.start();
console.log(`[local-db] PGlite listening on postgres://postgres:postgres@127.0.0.1:${port}/postgres (${dir ?? 'in-memory'})`);
console.log('[local-db] Set DATABASE_POOL_MAX=1 for the app. Press Ctrl+C to stop.');
const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
