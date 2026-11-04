import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** app/ directory (works from both src/ via tsx and dist/ after build). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS_DIR = path.join(APP_ROOT, 'assets');
export const VIEWS_DIR = path.join(APP_ROOT, 'views');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export type StorageDriver = 'r2' | 'local';

export interface AppConfig {
  env: 'production' | 'development' | 'test';
  port: number;
  host: string;
  appUrl: string;
  databaseUrl: string;
  databaseSsl: boolean;
  sessionSecret: string;
  sessionTtlHours: number;
  tokenEncKey: string;
  storage: {
    driver: StorageDriver;
    localDir: string;
    r2: {
      accountId?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      privateBucket: string;
      publicBucket: string;
      endpoint?: string;
    };
    publicBaseUrl: string;
  };
  shopify: {
    apiKey?: string;
    apiSecret?: string;
    shop?: string;
    scopes: string;
    apiVersion: string;
    proxySubpath: string;
    /** Development only: accept unsigned proxy calls (never honoured in production). */
    allowUnsignedProxy: boolean;
  };
  bootstrapAdmin?: { email: string; password: string; name: string };
  trustProxy: boolean;
  uploadMaxBytes: number;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
  const nodeEnv = (env('NODE_ENV', 'development') as AppConfig['env']);
  const isProd = nodeEnv === 'production';
  const port = Number(env('PORT', '3000'));
  const driver = (env('STORAGE_DRIVER', isProd ? 'r2' : 'local') as StorageDriver);
  if (isProd && driver !== 'r2') {
    throw new Error('STORAGE_DRIVER=local is not allowed in production; configure Cloudflare R2.');
  }
  const sessionSecret = isProd ? required('SESSION_SECRET') : env('SESSION_SECRET', 'dev-only-session-secret-change-me-0123456789')!;
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const tokenEncKey = isProd ? required('TOKEN_ENC_KEY') : env('TOKEN_ENC_KEY', 'ZGV2LW9ubHktdG9rZW4tZW5jLWtleS0zMmJ5dGVzISE=')!;
  const appUrl = env('APP_URL', env('RENDER_EXTERNAL_URL', `http://localhost:${port}`))!.replace(/\/$/, '');
  const cfg: AppConfig = {
    env: nodeEnv,
    port,
    host: env('HOST', '0.0.0.0')!,
    appUrl,
    databaseUrl: isProd ? required('DATABASE_URL') : env('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres')!,
    databaseSsl: env('DATABASE_SSL', 'false') === 'true',
    sessionSecret,
    sessionTtlHours: Number(env('SESSION_TTL_HOURS', '12')),
    tokenEncKey,
    storage: {
      driver,
      localDir: path.resolve(APP_ROOT, env('LOCAL_STORAGE_DIR', '.local-storage')!),
      r2: {
        accountId: env('R2_ACCOUNT_ID')?.trim(),
        accessKeyId: env('R2_ACCESS_KEY_ID')?.trim(),
        secretAccessKey: env('R2_SECRET_ACCESS_KEY')?.trim(),
        privateBucket: env('R2_PRIVATE_BUCKET', 'nga-coa-private')!,
        publicBucket: env('R2_PUBLIC_BUCKET', 'nga-coa-public')!,
        endpoint: env('R2_ENDPOINT')?.trim().replace(/\/+$/, ''),
      },
      // Custom domain of the public R2 bucket if one exists; otherwise the app serves
      // published images itself from /coa-assets (no Cloudflare-hosted domain needed).
      publicBaseUrl: (env('PUBLIC_ASSET_BASE_URL') ?? `${appUrl}/coa-assets`).replace(/\/$/, ''),
    },
    shopify: {
      apiKey: env('SHOPIFY_API_KEY')?.trim(),
      apiSecret: env('SHOPIFY_API_SECRET')?.trim(),
      shop: env('SHOPIFY_SHOP')?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      scopes: env('SHOPIFY_SCOPES', 'read_customers')!,
      apiVersion: env('SHOPIFY_API_VERSION', '2026-07')!,
      proxySubpath: env('SHOPIFY_PROXY_SUBPATH', 'apps/coa')!,
      allowUnsignedProxy: !isProd && env('DEV_ALLOW_UNSIGNED_PROXY', 'false') === 'true',
    },
    trustProxy: env('TRUST_PROXY', isProd ? 'true' : 'false') === 'true',
    uploadMaxBytes: Number(env('UPLOAD_MAX_BYTES', String(8 * 1024 * 1024))),
  };
  const bEmail = env('ADMIN_BOOTSTRAP_EMAIL');
  const bPass = env('ADMIN_BOOTSTRAP_PASSWORD');
  if (bEmail && bPass) cfg.bootstrapAdmin = { email: bEmail, password: bPass, name: env('ADMIN_BOOTSTRAP_NAME', 'Administrator')! };
  if (driver === 'r2') {
    for (const k of ['accountId', 'accessKeyId', 'secretAccessKey'] as const) {
      if (!cfg.storage.r2[k] && isProd) throw new Error(`Missing R2 configuration: ${k}`);
    }
  }
  if (isProd && (!cfg.shopify.apiSecret || !cfg.shopify.shop)) {
    // The dashboard can run without Shopify, but the storefront proxy will reject every request.
    console.warn('[config] SHOPIFY_API_SECRET / SHOPIFY_SHOP not set: storefront proxy endpoints will return 503.');
  }
  return cfg;
}
