import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEFINITIONS } from '../coa/definitions/index.js';
import { hit } from '../lib/rate-limit.js';
import { normalizeVerificationKey } from '../lib/security.js';
import { findPublishedByKey, listCustomerReports, type Deps } from '../reports/service.js';
import { verifyProxySignature } from '../shopify/shopify.js';

type Q = Record<string, string | string[] | undefined>;

declare module 'fastify' {
  interface FastifyRequest {
    proxyCustomerId?: string | null;
  }
}

/** The visitor's IP as forwarded by Shopify (falls back to the socket address). */
function visitorIp(req: FastifyRequest): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return xff || req.ip || 'unknown';
}

/**
 * Storefront API, reached only through the Shopify app proxy:
 *   https://<store>/apps/coa/api/...  ->  https://<app>/proxy/api/...
 * Every request must carry a valid Shopify proxy signature.
 */
export async function registerProxyRoutes(app: FastifyInstance) {
  const { cfg, db } = app.deps;
  const deps: Deps = { db, store: app.deps.store };
  // Fixture (test) records are only ever visible outside production.
  const includeFixtures = cfg.env !== 'production';

  const json = (reply: FastifyReply, status: number, body: unknown) =>
    reply.code(status).header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex').type('application/json').send(body);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/proxy')) return;
    const secret = cfg.shopify.apiSecret;
    if (!secret) {
      if (cfg.shopify.allowUnsignedProxy) {
        req.proxyCustomerId = typeof (req.query as Q).logged_in_customer_id === 'string' ? ((req.query as Q).logged_in_customer_id as string) : null;
        return;
      }
      return json(reply, 503, { error: 'not_configured', message: 'Report lookup is not available yet.' });
    }
    const v = verifyProxySignature(req.query as Q, secret, { shop: cfg.shopify.shop });
    if (!v.ok) {
      req.log.warn({ reason: v.reason }, 'rejected proxy request');
      return json(reply, 401, { error: 'unauthorized' });
    }
    req.proxyCustomerId = v.customerId;
  });

  // Connectivity check: open https://<store>/apps/coa/api/ping in a browser.
  app.get('/proxy/api/ping', async (req, reply) =>
    json(reply, 200, { ok: true, service: 'nga-coa', proxy: 'signature verified', signedInCustomer: !!req.proxyCustomerId }),
  );

  app.get('/proxy/api/test-types', async (_req, reply) =>
    json(reply, 200, { testTypes: DEFINITIONS.map((d) => ({ slug: d.slug, name: d.name })) }),
  );

  app.get('/proxy/api/verify', async (req, reply) => {
    const ip = visitorIp(req);
    if (!(await hit(db, `verify-ip:${ip}`, 30, 60)) || !(await hit(db, `verify-ip-h:${ip}`, 300, 3600))) {
      return json(reply, 429, { error: 'rate_limited', message: 'Too many lookups. Please wait a minute and try again.' });
    }
    const raw = String((req.query as Q).key ?? '').slice(0, 64);
    const key = normalizeVerificationKey(raw);
    if (!key) {
      return json(reply, 400, { error: 'invalid_key', message: 'Enter the verification key exactly as printed on the certificate (e.g. NGA-XXXX-XXXX-XXXX).' });
    }
    const report = await findPublishedByKey(deps, key, { includeFixtures });
    if (!report) {
      // Failed lookups count extra against the visitor to slow down key guessing.
      await hit(db, `verify-miss:${ip}`, 20, 600);
      return json(reply, 404, { error: 'not_found', message: 'No published report matches this verification key.' });
    }
    return json(reply, 200, { report });
  });

  app.get('/proxy/api/my-reports', async (req, reply) => {
    const customerId = req.proxyCustomerId;
    if (!customerId) return json(reply, 401, { error: 'login_required', message: 'Sign in to see your reports.' });
    if (!(await hit(db, `my-reports:${customerId}`, 60, 60))) {
      return json(reply, 429, { error: 'rate_limited', message: 'Too many requests. Please wait a minute.' });
    }
    let email: string | null = null;
    try {
      const c = await app.deps.shopify.customerEmail(customerId);
      // Only verified customer emails are trusted for matching reports.
      email = c?.verified ? c.email : null;
    } catch (e) {
      req.log.error(e, 'customer lookup failed');
      return json(reply, 502, { error: 'upstream', message: 'Your reports could not be loaded right now. Please try again shortly.' });
    }
    const q = req.query as Q;
    const result = await listCustomerReports(
      deps,
      { id: customerId, email },
      {
        q: String(q.q ?? '').slice(0, 80),
        type: String(q.type ?? ''),
        page: Number(q.page) || 1,
        includeFixtures,
      },
    );
    return json(reply, 200, { ...result, emailMatched: !!email });
  });
}
