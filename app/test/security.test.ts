import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  dataHash,
  decryptSecret,
  encryptSecret,
  generateVerificationKey,
  normalizeVerificationKey,
  VERIFICATION_KEY_RE,
} from '../src/lib/security.js';
import { verifyOAuthHmac, verifyProxySignature } from '../src/shopify/shopify.js';
import { MemoryStore, StorageError } from '../src/storage/index.js';
import { signProxy } from './helpers.js';

describe('verification keys', () => {
  it('generates unique, well-formed keys', () => {
    const keys = new Set(Array.from({ length: 2000 }, generateVerificationKey));
    expect(keys.size).toBe(2000);
    for (const k of keys) expect(k).toMatch(VERIFICATION_KEY_RE);
  });
  it('normalises typed input (case, spaces, ambiguous characters)', () => {
    expect(normalizeVerificationKey(' nga-7k4m-q9xd-2htp ')).toBe('NGA-7K4M-Q9XD-2HTP');
    expect(normalizeVerificationKey('7K4MQ9XD2HTP')).toBe('NGA-7K4M-Q9XD-2HTP');
    expect(normalizeVerificationKey('NGA-7K4M-Q9XD-2HTO')).toBe('NGA-7K4M-Q9XD-2HT0');
    expect(normalizeVerificationKey("NGA-7K4M'; DROP TABLE")).toBeNull();
    expect(normalizeVerificationKey('')).toBeNull();
  });
});

describe('Shopify app proxy signature', () => {
  const secret = 'shh';
  const now = Math.floor(Date.now() / 1000);
  const base = { shop: 'nga-test.myshopify.com', path_prefix: '/apps/coa', timestamp: String(now), logged_in_customer_id: '12345' };

  it('accepts a correctly signed request and exposes the customer id', () => {
    const r = verifyProxySignature(signProxy(base, secret), secret, { shop: base.shop });
    expect(r).toEqual({ ok: true, customerId: '12345', shop: base.shop });
  });
  it('rejects tampered parameters', () => {
    const signed = signProxy(base, secret);
    expect(verifyProxySignature({ ...signed, logged_in_customer_id: '999' }, secret).ok).toBe(false);
  });
  it('rejects a wrong secret, missing signature, stale timestamp and other shops', () => {
    expect(verifyProxySignature(signProxy(base, 'other'), secret).ok).toBe(false);
    expect(verifyProxySignature(base, secret).ok).toBe(false);
    expect(verifyProxySignature(signProxy({ ...base, timestamp: String(now - 3600) }, secret), secret).ok).toBe(false);
    expect(verifyProxySignature(signProxy({ ...base, shop: 'evil.myshopify.com' }, secret), secret, { shop: base.shop }).ok).toBe(false);
  });
  it('treats an empty customer id as signed out', () => {
    const r = verifyProxySignature(signProxy({ ...base, logged_in_customer_id: '' }, secret), secret);
    expect(r.ok && r.customerId).toBe(null);
  });
  it('verifies OAuth callback hmac', () => {
    const q: Record<string, string> = { code: 'abc', shop: base.shop, state: 'xyz', timestamp: String(now) };
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
    const hmac = crypto.createHmac('sha256', secret).update(msg).digest('hex');
    expect(verifyOAuthHmac({ ...q, hmac }, secret)).toBe(true);
    expect(verifyOAuthHmac({ ...q, code: 'zzz', hmac }, secret)).toBe(false);
  });
});

describe('secrets and hashing', () => {
  it('round-trips encrypted tokens and detects tampering', () => {
    const key = crypto.randomBytes(32).toString('base64');
    const enc = encryptSecret('shpat_example', key);
    expect(decryptSecret(enc, key)).toBe('shpat_example');
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });
  it('hashes data independent of key order', () => {
    expect(dataHash({ a: 1, b: [1, 2] })).toBe(dataHash({ b: [1, 2], a: 1 }));
    expect(dataHash({ a: 1 })).not.toBe(dataHash({ a: 2 }));
  });
});

describe('storage adapter contract', () => {
  it('stores, reads, deletes and rejects unsafe keys', async () => {
    const s = new MemoryStore();
    await s.put('private', 'reports/a/v1/p1.webp', Buffer.from('x'), { contentType: 'image/webp' });
    expect((await s.get('private', 'reports/a/v1/p1.webp'))?.toString()).toBe('x');
    expect(await s.get('public', 'reports/a/v1/p1.webp')).toBeNull();
    await s.delete('private', 'reports/a/v1/p1.webp');
    expect(await s.get('private', 'reports/a/v1/p1.webp')).toBeNull();
    await expect(s.put('private', '../etc/passwd', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(StorageError);
  });
});

describe('R2 error explanations', () => {
  it('turns SDK errors into actionable messages', async () => {
    const { explainR2Error } = await import('../src/storage/index.js');
    expect(explainR2Error({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toMatch(/Object Read & Write/);
    expect(explainR2Error({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toMatch(/bucket not found/);
    expect(explainR2Error({ name: 'SignatureDoesNotMatch' })).toMatch(/R2_SECRET_ACCESS_KEY/);
    expect(explainR2Error({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' })).toMatch(/R2_ACCOUNT_ID/);
    expect(explainR2Error({ name: 'UnknownError', message: 'UnknownError', $metadata: { httpStatusCode: 400 } })).toMatch(/unexpected error \(UnknownError, 400\)/);
  });
});
