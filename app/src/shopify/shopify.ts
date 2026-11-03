import crypto from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret, randomToken, timingSafeEqualStr } from '../lib/security.js';

export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Verifies a Shopify app proxy request.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
export function verifyProxySignature(
  query: Record<string, string | string[] | undefined>,
  secret: string,
  opts: { now?: number; maxAgeSeconds?: number; shop?: string } = {},
): { ok: true; customerId: string | null; shop: string } | { ok: false; reason: string } {
  const signature = typeof query.signature === 'string' ? query.signature : '';
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'missing signature' };
  const message = Object.keys(query)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => {
      const v = query[k];
      return `${k}=${Array.isArray(v) ? v.join(',') : (v ?? '')}`;
    })
    .join('');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  if (!timingSafeEqualStr(expected, signature)) return { ok: false, reason: 'bad signature' };
  const ts = Number(query.timestamp);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (opts.maxAgeSeconds ?? 600)) return { ok: false, reason: 'stale request' };
  const shop = String(query.shop ?? '');
  if (opts.shop && shop !== opts.shop) return { ok: false, reason: 'unexpected shop' };
  const cid = typeof query.logged_in_customer_id === 'string' && /^\d{1,20}$/.test(query.logged_in_customer_id) ? query.logged_in_customer_id : null;
  return { ok: true, customerId: cid, shop };
}

/** Verifies the hmac on OAuth redirects. */
export function verifyOAuthHmac(query: Record<string, string | undefined>, secret: string): boolean {
  const hmac = query.hmac ?? '';
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return /^[0-9a-f]{64}$/.test(hmac) && timingSafeEqualStr(expected, hmac);
}

export class ShopifyClient {
  private ccToken: { token: string; exp: number } | null = null;
  private customerCache = new Map<string, { email: string | null; verified: boolean; exp: number }>();

  constructor(
    private cfg: AppConfig,
    private db: pg.Pool,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get configured() {
    return !!(this.cfg.shopify.apiKey && this.cfg.shopify.apiSecret && this.cfg.shopify.shop);
  }

  // ---- OAuth install (offline token, scope read_customers) ----

  async beginInstall(): Promise<string> {
    const { apiKey, shop, scopes } = this.cfg.shopify;
    if (!this.configured || !shop || !SHOP_RE.test(shop)) throw new Error('Shopify app credentials are not configured.');
    const state = randomToken(18);
    await this.db.query('INSERT INTO oauth_states (state) VALUES ($1)', [state]);
    const redirect = `${this.cfg.appUrl}/shopify/callback`;
    const u = new URL(`https://${shop}/admin/oauth/authorize`);
    u.searchParams.set('client_id', apiKey!);
    u.searchParams.set('scope', scopes);
    u.searchParams.set('redirect_uri', redirect);
    u.searchParams.set('state', state);
    return u.toString();
  }

  async completeInstall(query: Record<string, string | undefined>): Promise<void> {
    const { apiKey, apiSecret, shop } = this.cfg.shopify;
    if (!apiSecret || !apiKey) throw new Error('Shopify app credentials are not configured.');
    if (!verifyOAuthHmac(query, apiSecret)) throw new Error('Invalid OAuth signature.');
    if (query.shop !== shop) throw new Error('Unexpected shop.');
    const state = query.state ?? '';
    const r = await this.db.query(`DELETE FROM oauth_states WHERE state = $1 AND created_at > now() - interval '10 minutes' RETURNING state`, [state]);
    if (!r.rows[0]) throw new Error('OAuth state expired or invalid. Start the installation again.');
    const res = await this.fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code: query.code }),
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status}).`);
    const body = (await res.json()) as { access_token?: string; scope?: string };
    if (!body.access_token) throw new Error('Token exchange returned no token.');
    await this.db.query(
      `INSERT INTO shopify_installations (shop, access_token_enc, scopes) VALUES ($1, $2, $3)
       ON CONFLICT (shop) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, scopes = EXCLUDED.scopes, installed_at = now()`,
      [shop, encryptSecret(body.access_token, this.cfg.tokenEncKey), body.scope ?? ''],
    );
  }

  async installationStatus(): Promise<{ installed: boolean; scopes?: string; via?: string }> {
    if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) return { installed: true, via: 'environment token' };
    const r = await this.db.query('SELECT scopes FROM shopify_installations WHERE shop = $1', [this.cfg.shopify.shop ?? '']);
    return r.rows[0] ? { installed: true, scopes: r.rows[0].scopes, via: 'OAuth' } : { installed: false };
  }

  private async accessToken(): Promise<string | null> {
    if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    const r = await this.db.query('SELECT access_token_enc FROM shopify_installations WHERE shop = $1', [this.cfg.shopify.shop ?? '']);
    if (r.rows[0]) return decryptSecret(r.rows[0].access_token_enc, this.cfg.tokenEncKey);
    // Apps owned by the same organisation as the store can use the client-credentials grant.
    if (this.ccToken && this.ccToken.exp > Date.now()) return this.ccToken.token;
    if (!this.configured) return null;
    const res = await this.fetchImpl(`https://${this.cfg.shopify.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.shopify.apiKey!,
        client_secret: this.cfg.shopify.apiSecret!,
      }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;
    this.ccToken = { token: body.access_token, exp: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000 };
    return body.access_token;
  }

  /**
   * Resolves a customer's email from the signed customer id (read_customers).
   * Returns null when the app is not installed or the customer cannot be read.
   */
  async customerEmail(customerId: string): Promise<{ email: string | null; verified: boolean } | null> {
    const cached = this.customerCache.get(customerId);
    if (cached && cached.exp > Date.now()) return cached;
    const token = await this.accessToken();
    if (!token) return null;
    const url = `https://${this.cfg.shopify.shop}/admin/api/${this.cfg.shopify.apiVersion}/graphql.json`;
    const run = async (query: string) => {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables: { id: `gid://shopify/Customer/${customerId}` } }),
      });
      if (!res.ok) throw new Error(`Shopify Admin API ${res.status}`);
      return (await res.json()) as {
        data?: { customer?: { email?: string | null; verifiedEmail?: boolean; defaultEmailAddress?: { emailAddress?: string | null } } | null };
        errors?: unknown[];
      };
    };
    let body = await run('query($id: ID!) { customer(id: $id) { verifiedEmail defaultEmailAddress { emailAddress } } }');
    if (body.errors?.length) body = await run('query($id: ID!) { customer(id: $id) { verifiedEmail email } }');
    if (body.errors?.length || !body.data) throw new Error('Shopify Admin API returned errors');
    const c = body.data.customer;
    const out = {
      email: (c?.defaultEmailAddress?.emailAddress ?? c?.email ?? null)?.toLowerCase() ?? null,
      verified: !!c?.verifiedEmail,
      exp: Date.now() + 10 * 60 * 1000,
    };
    this.customerCache.set(customerId, out);
    return out;
  }
}
