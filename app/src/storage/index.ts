import fs from 'node:fs/promises';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import type { AppConfig } from '../config.js';

export type BucketKind = 'private' | 'public';

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

export interface ObjectStore {
  readonly driver: 'r2' | 'local' | 'memory';
  put(bucket: BucketKind, key: string, body: Buffer, opts: PutOptions): Promise<void>;
  get(bucket: BucketKind, key: string): Promise<Buffer | null>;
  delete(bucket: BucketKind, key: string): Promise<void>;
  /** Public URL for an object in the public bucket. */
  publicUrl(key: string): string;
  check(): Promise<{ ok: boolean; detail?: string }>;
}

export class StorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]{0,500}$/i;
function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new StorageError(`Unsafe object key: ${key}`);
}

export class R2Store implements ObjectStore {
  readonly driver = 'r2' as const;
  private client: S3Client;
  constructor(private cfg: AppConfig['storage'], client?: S3Client) {
    const r2 = cfg.r2;
    this.client =
      client ??
      new S3Client({
        region: 'auto',
        endpoint: r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: r2.accessKeyId ?? '', secretAccessKey: r2.secretAccessKey ?? '' },
        maxAttempts: 3,
      });
  }
  private bucket(kind: BucketKind) {
    return kind === 'public' ? this.cfg.r2.publicBucket : this.cfg.r2.privateBucket;
  }
  async put(kind: BucketKind, key: string, body: Buffer, opts: PutOptions) {
    assertKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket(kind),
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          CacheControl: opts.cacheControl,
          ContentLength: body.length,
        }),
      );
    } catch (e) {
      throw new StorageError(`Upload to R2 (${kind}) failed for ${key}: ${(e as Error).message}`, e);
    }
  }
  async get(kind: BucketKind, key: string) {
    assertKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket(kind), Key: key }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return null;
      throw new StorageError(`Download from R2 (${kind}) failed for ${key}: ${(e as Error).message}`, e);
    }
  }
  async delete(kind: BucketKind, key: string) {
    assertKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(kind), Key: key }));
    } catch (e) {
      throw new StorageError(`Delete from R2 (${kind}) failed for ${key}: ${(e as Error).message}`, e);
    }
  }
  publicUrl(key: string) {
    return `${this.cfg.publicBaseUrl}/${key}`;
  }
  /**
   * Verifies exactly what the app needs — write, read and delete an object in each
   * bucket — and turns S3/R2 errors into actionable messages.
   */
  async check() {
    const key = `healthcheck/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    for (const kind of ['private', 'public'] as const) {
      const bucket = this.bucket(kind);
      let step = 'write';
      try {
        await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'ok', ContentType: 'text/plain' }));
        step = 'read';
        await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        step = 'delete';
        await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        return { ok: false, detail: `${kind} bucket "${bucket}" — ${step} failed: ${explainR2Error(e)}` };
      }
    }
    return { ok: true, detail: 'Write, read and delete succeeded on both buckets.' };
  }
}

/** Maps S3/R2 SDK errors to messages staff can act on (never includes secrets). */
export function explainR2Error(e: unknown): string {
  const err = e as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const code = err.Code ?? err.name ?? err.code ?? '';
  const status = err.$metadata?.httpStatusCode;
  const msg = err.message ?? '';
  const tag = `(${[code, status].filter(Boolean).join(', ')})`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${code} ${msg}`))
    return `cannot reach the R2 endpoint — check R2_ACCOUNT_ID (32-character account ID, not a URL) ${tag}`;
  if (code === 'InvalidAccessKeyId') return `R2_ACCESS_KEY_ID is not recognised ${tag}`;
  if (code === 'SignatureDoesNotMatch') return `R2_SECRET_ACCESS_KEY does not match the access key ${tag}`;
  if (code === 'NoSuchBucket' || status === 404)
    return `bucket not found — check the bucket name and R2_ACCOUNT_ID; for a jurisdiction bucket (.us./.eu.) set R2_ENDPOINT to the bucket's S3 API URL without the bucket name ${tag}`;
  if (code === 'AccessDenied' || status === 403 || status === 401)
    return `access denied — the API token needs "Object Read & Write" on this bucket; if the bucket's S3 API URL contains a jurisdiction (e.g. .us., .eu.), set R2_ENDPOINT to that URL without the bucket name ${tag}`;
  return `${msg && msg !== 'UnknownError' ? msg : 'unexpected error'} ${tag}`;
}

/** Development-only filesystem store (refused in production by config). */
export class LocalStore implements ObjectStore {
  readonly driver = 'local' as const;
  constructor(private dir: string, private publicBase: string) {}
  private file(kind: BucketKind, key: string) {
    assertKey(key);
    return path.join(this.dir, kind, ...key.split('/'));
  }
  async put(kind: BucketKind, key: string, body: Buffer, opts: PutOptions) {
    const f = this.file(kind, key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
    await fs.writeFile(`${f}.meta.json`, JSON.stringify(opts));
  }
  async get(kind: BucketKind, key: string) {
    try {
      return await fs.readFile(this.file(kind, key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(kind: BucketKind, key: string) {
    const f = this.file(kind, key);
    await fs.rm(f, { force: true });
    await fs.rm(`${f}.meta.json`, { force: true });
  }
  publicUrl(key: string) {
    return `${this.publicBase}/${key}`;
  }
  async check() {
    await fs.mkdir(this.dir, { recursive: true });
    return { ok: true, detail: 'local filesystem (development only)' };
  }
}

/** In-memory store used by automated tests. */
export class MemoryStore implements ObjectStore {
  readonly driver = 'memory' as const;
  objects = new Map<string, { body: Buffer; opts: PutOptions }>();
  failNextPut = false;
  constructor(private publicBase = 'https://assets.test') {}
  async put(kind: BucketKind, key: string, body: Buffer, opts: PutOptions) {
    assertKey(key);
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new StorageError('simulated upload failure');
    }
    this.objects.set(`${kind}:${key}`, { body, opts });
  }
  async get(kind: BucketKind, key: string) {
    return this.objects.get(`${kind}:${key}`)?.body ?? null;
  }
  async delete(kind: BucketKind, key: string) {
    this.objects.delete(`${kind}:${key}`);
  }
  publicUrl(key: string) {
    return `${this.publicBase}/${key}`;
  }
  async check() {
    return { ok: true };
  }
}

export function createStore(cfg: AppConfig): ObjectStore {
  if (cfg.storage.driver === 'r2') return new R2Store(cfg.storage);
  return new LocalStore(cfg.storage.localDir, cfg.storage.publicBaseUrl);
}

export const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PRIVATE_CACHE_CONTROL = 'private, no-store';
