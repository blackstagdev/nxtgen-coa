import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { can } from '../auth/users.js';
import { audit } from '../reports/service.js';

/**
 * Minimal OAuth install so the app can read a signed-in customer's email
 * (scope: read_customers). Started by an administrator from /admin/settings.
 */
export async function registerShopifyRoutes(app: FastifyInstance) {
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) return reply.redirect(`/admin/login?next=${encodeURIComponent('/admin/settings')}`);
    if (!can.manageUsers(req.session.user)) return app.view(reply, 'error', { title: 'Not allowed', message: 'Administrators only.' }, 403);
  };

  app.get('/shopify/install', { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return reply.redirect(await app.deps.shopify.beginInstall());
    } catch (e) {
      return app.view(reply, 'error', { title: 'Shopify not configured', message: (e as Error).message }, 400);
    }
  });

  app.get('/shopify/callback', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      await app.deps.shopify.completeInstall(req.query as Record<string, string>);
      await audit(app.deps.db, null, req.session!.user.id, 'shopify_install', { shop: app.deps.cfg.shopify.shop });
      return reply.redirect('/admin/settings');
    } catch (e) {
      return app.view(reply, 'error', { title: 'Shopify installation failed', message: (e as Error).message }, 400);
    }
  });
}
