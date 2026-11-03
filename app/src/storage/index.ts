import fs from 'node:fs/promises';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
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
  async check() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.r2.privateBucket }));
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.r2.publicBucket }));
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
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
