import crypto from 'node:crypto';

/** Crockford base32 without ambiguous characters (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Verification key: "NGA-XXXX-XXXX-XXXX" = 12 random base32 chars (60 bits).
 * Unguessable for public lookup (combined with rate limiting) and short enough to type.
 */
export function generateVerificationKey(): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += CROCKFORD[bytes[i] & 31];
  return `NGA-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Normalises user input to the canonical key format; returns null if it cannot be a key. */
export function normalizeVerificationKey(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s_]+/g, '')
    .replace(/[O]/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/-/g, '');
  const m = /^(?:NGA)?([0-9A-HJKMNP-TV-Z]{12})$/.exec(s);
  if (!m) return null;
  const c = m[1];
  return `NGA-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

export const VERIFICATION_KEY_RE = /^NGA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function keyFrom(secret: string): Buffer {
  // Accept a base64 32-byte key, otherwise derive one.
  try {
    const b = Buffer.from(secret, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* fallthrough */
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/** AES-256-GCM encryption for secrets at rest (Shopify offline token). */
export function encryptSecret(plain: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, secret: string): string {
  const [v, iv, tag, enc] = payload.split('.');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

/** Stable hash of structured data (sorted keys) used to tie a rendered version to its data. */
export function dataHash(data: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return sha256(JSON.stringify(stable(data)));
}
