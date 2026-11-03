import crypto from 'node:crypto';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { createUser, type Role, type User } from '../src/auth/users.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { MemoryStore } from '../src/storage/index.js';
import type { FastifyInstance } from 'fastify';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export interface TestEnv {
  cfg: AppConfig;
  db: pg.Pool;
  store: MemoryStore;
  app: FastifyInstance;
  close: () => Promise<void>;
}

export const SHOP = 'nga-test.myshopify.com';
export const SECRET = 'test-shopify-secret';

export async function startTestEnv(overrides: Record<string, string> = {}, shopify?: unknown, publicBase = 'https://assets.test'): Promise<TestEnv> {
  const pgl = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pgl, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    STORAGE_DRIVER: 'local',
    SHOPIFY_API_KEY: 'test-key',
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_SHOP: SHOP,
    PUBLIC_ASSET_BASE_URL: publicBase,
    ...overrides,
  });
  const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1 });
  await migrate(db, () => {});
  const store = new MemoryStore(publicBase);
  const app = await buildApp({ cfg, db, store, logger: false, shopify: shopify as never });
  await app.ready();
  return {
    cfg,
    db,
    store,
    app,
    close: async () => {
      await app.close();
      await db.end();
      await server.stop();
      await pgl.close();
    },
  };
}

export const PASSWORD = 'correct-horse-battery-9';

export async function makeUser(db: pg.Pool, role: Role, email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.test`): Promise<User> {
  return createUser(db, { email, name: `${role} user`, role, password: PASSWORD });
}

/** Signs in through the real login form and returns cookie header + CSRF token. */
export async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/login',
    payload: new URLSearchParams({ email, password }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const setCookie = res.headers['set-cookie'];
  const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean) as string[];
  const sid = cookies.find((c) => c.startsWith('nga_sid='));
  if (!sid) throw new Error(`login failed: ${res.statusCode}`);
  const cookie = sid.split(';')[0];
  const page = await app.inject({ method: 'GET', url: '/admin/reports/new', headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
  if (!csrf) throw new Error('no csrf token on page');
  return { cookie, csrf };
}

export function form(data: Record<string, string | string[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return p.toString();
}

export const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

export function signProxy(params: Record<string, string>, secret: string): Record<string, string> {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  return { ...params, signature: crypto.createHmac('sha256', secret).update(message).digest('hex') };
}

/** Builds a signed app-proxy URL as Shopify would forward it. */
export function proxyUrl(pathname: string, params: Record<string, string> = {}, customerId = ''): string {
  const signed = signProxy(
    { shop: SHOP, path_prefix: '/apps/coa', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: customerId, ...params },
    SECRET,
  );
  return `${pathname}?${new URLSearchParams(signed).toString()}`;
}
