import { buildApp } from './app.js';
import { countUsers, createUser, pruneSessions } from './auth/users.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { pruneRateLimits } from './lib/rate-limit.js';
import { registerFonts } from './coa/render/renderer.js';
import { createStore } from './storage/index.js';

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg);
  const store = createStore(cfg);
  registerFonts();

  // One-time bootstrap of the first administrator (ignored once any user exists).
  if (cfg.bootstrapAdmin && (await countUsers(db)) === 0) {
    const u = await createUser(db, { ...cfg.bootstrapAdmin, role: 'admin' });
    console.log(`[bootstrap] created administrator ${u.email}. Remove ADMIN_BOOTSTRAP_PASSWORD from the environment now.`);
  }

  const app = await buildApp({ cfg, db, store });
  const timer = setInterval(() => {
    pruneSessions(db).catch(() => {});
    pruneRateLimits(db).catch(() => {});
  }, 60 * 60 * 1000);
  timer.unref();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.port, host: cfg.host });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
