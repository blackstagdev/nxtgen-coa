import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Eta } from 'eta';
import type pg from 'pg';
import { PUBLIC_DIR, VIEWS_DIR, type AppConfig } from './config.js';
import { loadSession, type Session } from './auth/users.js';
import type { ObjectStore } from './storage/index.js';
import { ShopifyClient } from './shopify/shopify.js';
import { registerAdminRoutes } from './admin/routes.js';
import { registerProxyRoutes } from './proxy/routes.js';
import { registerShopifyRoutes } from './shopify/routes.js';

export interface AppDeps {
  cfg: AppConfig;
  db: pg.Pool;
  store: ObjectStore;
  shopify?: ShopifyClient;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyInstance {
    deps: Required<Omit<AppDeps, 'logger'>>;
    view: (reply: FastifyReply, template: string, data?: Record<string, unknown>, status?: number) => FastifyReply;
  }
}

export const SESSION_COOKIE = 'nga_sid';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg } = deps;
  const app = Fastify({
    logger: deps.logger === false ? false : { level: cfg.env === 'production' ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: cfg.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  const shopify = deps.shopify ?? new ShopifyClient(cfg, deps.db);
  app.decorate('deps', { cfg, db: deps.db, store: deps.store, shopify });

  const eta = new Eta({ views: VIEWS_DIR, cache: cfg.env === 'production', autoEscape: true, autoTrim: [false, 'nl'] });
  app.decorate('view', (reply: FastifyReply, template: string, data: Record<string, unknown> = {}, status = 200) => {
    const req = reply.request;
    const html = eta.render(template, {
      ...data,
      session: req.session,
      user: req.session?.user ?? null,
      csrf: req.session?.csrf ?? '',
      flash: (req as FastifyRequest & { flash?: unknown }).flash ?? null,
      env: cfg.env,
      path: req.url,
    });
    return reply.code(status).type('text/html; charset=utf-8').send(html);
  });

  await app.register(cookie, { secret: cfg.sessionSecret });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: cfg.uploadMaxBytes, files: 1, fields: 10 } });
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/admin/assets/',
    maxAge: cfg.env === 'production' ? '7d' : 0,
    decorateReply: false,
  });
  // Published certificate images, streamed from the PUBLIC bucket. Used when no custom
  // domain is attached to the R2 public bucket (PUBLIC_ASSET_BASE_URL defaults to
  // <APP_URL>/coa-assets). Only published copies exist in that bucket, under random
  // versioned keys that are deleted on unpublish, so nothing private is reachable here.
  const COA_ASSET_KEY = /^coa\/[A-Za-z0-9_-]{8,64}\/v\d{1,6}-p\d{1,3}-[0-9a-f]{12}\.webp$/;
  app.get('/coa-assets/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    if (!COA_ASSET_KEY.test(key)) return reply.code(404).send({ error: 'not_found' });
    const buf = await deps.store.get('public', key);
    if (!buf) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not_found' });
    return reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('ETag', `"${key.slice(-17, -5)}"`)
      .send(buf);
  });

  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/admin') && !req.url.startsWith('/shopify')) return;
    const raw = req.cookies[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    req.session = unsigned?.valid && unsigned.value ? await loadSession(deps.db, unsigned.value) : null;
    const flashRaw = req.cookies.nga_flash;
    if (flashRaw) {
      const f = req.unsignCookie(flashRaw);
      if (f.valid && f.value) {
        try {
          (req as FastifyRequest & { flash?: unknown }).flash = JSON.parse(f.value);
        } catch {
          /* ignore */
        }
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (cfg.env === 'production') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/admin') || req.url.startsWith('/shopify')) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      if (!reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
      if ((req as FastifyRequest & { flash?: unknown }).flash) reply.clearCookie('nga_flash', { path: '/' });
    }
    return payload;
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return reply.header('Cache-Control', 'no-store').send({ ok: true, db: 'ok', storage: deps.store.driver });
    } catch {
      return reply.code(503).send({ ok: false, db: 'unreachable' });
    }
  });

  app.get('/', async (_req, reply) => reply.redirect('/admin'));

  await registerAdminRoutes(app);
  await registerProxyRoutes(app);
  await registerShopifyRoutes(app);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/proxy') || req.headers.accept?.includes('application/json')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return app.view(reply, 'error', { title: 'Not found', message: 'The page you requested does not exist.' }, 404);
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    if (req.url.startsWith('/proxy') || req.headers.accept?.includes('application/json')) {
      return reply.code(status).send({ error: status >= 500 ? 'server_error' : 'bad_request', message: status >= 500 ? 'Something went wrong.' : err.message });
    }
    return app.view(
      reply,
      'error',
      { title: status >= 500 ? 'Something went wrong' : 'Request error', message: status >= 500 ? 'An unexpected error occurred. It has been logged.' : err.message },
      status,
    );
  });

  return app;
}
