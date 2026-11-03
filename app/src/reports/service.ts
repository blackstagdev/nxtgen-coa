import crypto from 'node:crypto';
import sharp from 'sharp';
import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.js';
import { allFields, fieldMap, getDefinition } from '../coa/definitions/index.js';
import { renderDefinition, RenderError, RENDERER_VERSION } from '../coa/render/renderer.js';
import type { CoaData, CoaDefinition } from '../coa/types.js';
import { imageIds, normalizeData, validateData, type FieldError } from '../coa/validate.js';
import { can, type User } from '../auth/users.js';
import { dataHash, generateVerificationKey, randomToken } from '../lib/security.js';
import { PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL, StorageError, type ObjectStore } from '../storage/index.js';

export type ReportStatus = 'draft' | 'published' | 'unpublished' | 'archived';

export class ReportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface ReportRow {
  id: string;
  test_type: string;
  definition_version: number;
  status: ReportStatus;
  verification_key: string;
  report_number: string | null;
  data: CoaData;
  internal_notes: string;
  client_email: string | null;
  shopify_customer_id: string | null;
  is_test_fixture: boolean;
  published_version_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  first_published_at: Date | null;
  archived_at: Date | null;
}

export interface VersionRow {
  id: string;
  report_id: string;
  version_no: number;
  data: CoaData;
  data_hash: string;
  definition_version: number;
  renderer_version: string;
  status: 'rendering' | 'ready' | 'failed';
  error: string | null;
  created_by: string | null;
  created_at: Date;
  pages?: PageRow[];
}

export interface PageRow {
  version_id: string;
  page_no: number;
  private_key: string;
  public_key: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface Deps {
  db: pg.Pool;
  store: ObjectStore;
  /** Watermark every render (development / fixtures). */
  watermarkFixtures?: boolean;
}

function requireDef(slug: string): CoaDefinition {
  const def = getDefinition(slug);
  if (!def) throw new ReportError(`Unknown test type "${slug}"`, 400);
  return def;
}

export async function audit(db: Queryable, reportId: string | null, userId: string | null, action: string, details: object = {}) {
  await db.query('INSERT INTO audit_events (report_id, user_id, action, details) VALUES ($1, $2, $3, $4)', [
    reportId,
    userId,
    action,
    JSON.stringify(details),
  ]);
}

// ---- Create / read -----------------------------------------------------------------

export async function createReport(
  deps: Deps,
  user: User,
  testType: string,
  opts: { isTestFixture?: boolean; clientEmail?: string } = {},
): Promise<ReportRow> {
  const def = requireDef(testType);
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateVerificationKey();
    try {
      return await withTx(deps.db, async (tx) => {
        const r = await tx.query(
          `INSERT INTO reports (test_type, definition_version, verification_key, is_test_fixture, client_email, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
          [def.slug, def.version, key, !!opts.isTestFixture, opts.clientEmail ?? null, user.id],
        );
        await audit(tx, r.rows[0].id, user.id, 'create', { test_type: def.slug, test_fixture: !!opts.isTestFixture });
        return r.rows[0];
      });
    } catch (e) {
      if ((e as { code?: string; constraint?: string }).constraint === 'reports_verification_key_key') continue;
      throw e;
    }
  }
  throw new ReportError('Could not allocate a unique verification key; try again.', 500);
}

export async function getReport(db: Queryable, id: string): Promise<ReportRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await db.query('SELECT * FROM reports WHERE id = $1', [id])).rows[0] ?? null;
}

export async function getVersions(db: Queryable, reportId: string): Promise<VersionRow[]> {
  const versions: VersionRow[] = (
    await db.query('SELECT * FROM report_versions WHERE report_id = $1 ORDER BY version_no DESC', [reportId])
  ).rows;
  if (!versions.length) return versions;
  const pages: PageRow[] = (
    await db.query('SELECT * FROM report_version_pages WHERE version_id = ANY($1) ORDER BY page_no', [versions.map((v) => v.id)])
  ).rows;
  for (const v of versions) v.pages = pages.filter((p) => p.version_id === v.id);
  return versions;
}

export async function getVersion(db: Queryable, reportId: string, versionId: string): Promise<VersionRow | null> {
  const r = await db.query('SELECT * FROM report_versions WHERE id = $1 AND report_id = $2', [versionId, reportId]);
  const v: VersionRow | undefined = r.rows[0];
  if (!v) return null;
  v.pages = (await db.query('SELECT * FROM report_version_pages WHERE version_id = $1 ORDER BY page_no', [v.id])).rows;
  return v;
}

export interface ListFilter {
  q?: string;
  status?: string;
  type?: string;
  page?: number;
  perPage?: number;
  includeFixtures?: boolean;
}

export async function listReports(db: Queryable, f: ListFilter) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (f.status && ['draft', 'published', 'unpublished', 'archived'].includes(f.status)) add('r.status = ?', f.status);
  else where.push(`r.status <> 'archived'`);
  if (f.type && getDefinition(f.type)) add('r.test_type = ?', f.type);
  if (f.q?.trim()) {
    const q = `%${f.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    add(
      `(r.verification_key ILIKE ? OR r.report_number ILIKE $X OR r.client_email ILIKE $X
        OR r.data->>'sample_name' ILIKE $X OR r.data->>'lot_number' ILIKE $X OR r.data->>'sample_lot' ILIKE $X
        OR r.data->>'client' ILIKE $X OR r.data->>'client_name' ILIKE $X)`.replace(/\$X/g, `$${args.length + 1}`),
      q,
    );
  }
  const perPage = Math.min(Math.max(f.perPage ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query(`SELECT count(*)::int AS n FROM reports r ${whereSql}`, args)).rows[0].n);
  const rows = (
    await db.query(
      `SELECT r.*, cu.name AS created_by_name, uu.name AS updated_by_name
         FROM reports r
         LEFT JOIN users cu ON cu.id = r.created_by
         LEFT JOIN users uu ON uu.id = r.updated_by
         ${whereSql}
        ORDER BY r.updated_at DESC
        LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
      args,
    )
  ).rows;
  return { rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

export async function getAudit(db: Queryable, reportId: string) {
  return (
    await db.query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
         FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.report_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [reportId],
    )
  ).rows;
}

export async function getUploads(db: Queryable, reportId: string) {
  return (await db.query('SELECT * FROM report_uploads WHERE report_id = $1 ORDER BY created_at', [reportId])).rows;
}

// ---- Draft editing ---------------------------------------------------------------------

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;

export async function saveDraft(
  deps: Deps,
  user: User,
  id: string,
  input: { data: Record<string, unknown>; internalNotes?: string; clientEmail?: string },
): Promise<{ report: ReportRow; changed: string[] }> {
  const report = await getReport(deps.db, id);
  if (!report) throw new ReportError('Report not found', 404);
  if (report.status === 'archived') throw new ReportError('Archived reports are read-only. Restore it first.', 409);
  const def = requireDef(report.test_type);
  const data = normalizeData(def, input.data);
  const errors = validateData(def, data, 'draft');
  const clientEmail = (input.clientEmail ?? report.client_email ?? '').trim().toLowerCase() || null;
  if (clientEmail && !EMAIL.test(clientEmail)) errors.push({ field: '_client_email', message: 'Enter a valid email address.' });
  const notes = (input.internalNotes ?? report.internal_notes ?? '').slice(0, 5000);
  // Image references must belong to this report and the right field.
  const refs = imageIds(def, data);
  if (refs.length) {
    const ok = new Set(
      (await deps.db.query('SELECT id, field_key FROM report_uploads WHERE report_id = $1', [id])).rows.map(
        (r) => `${r.field_key}:${r.id}`,
      ),
    );
    for (const ref of refs) if (!ok.has(`${ref.field}:${ref.id}`)) errors.push({ field: ref.field, message: 'Unknown image; upload it again.' });
  }
  if (errors.length) throw new ReportError('Please correct the highlighted fields.', 422, errors);

  const reportNumber = def.reportNumberField ? ((data[def.reportNumberField] as string) || null) : null;
  const changed = [
    ...new Set([...Object.keys(data), ...Object.keys(report.data)].filter((k) => JSON.stringify(data[k]) !== JSON.stringify(report.data[k]))),
  ];
  if (notes !== report.internal_notes) changed.push('_internal_notes');
  if (clientEmail !== report.client_email) changed.push('_client_email');
  if (!changed.length) return { report, changed };
  try {
    return await withTx(deps.db, async (tx) => {
      const r = await tx.query(
        `UPDATE reports SET data = $2, report_number = $3, internal_notes = $4, client_email = $5,
           shopify_customer_id = CASE WHEN client_email IS DISTINCT FROM $5 THEN NULL ELSE shopify_customer_id END,
           updated_by = $6, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(data), reportNumber, notes, clientEmail, user.id],
      );
      await audit(tx, id, user.id, 'edit', { fields: changed });
      return { report: r.rows[0], changed };
    });
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'reports_report_number_key') {
      const label = def.reportNumberField ? fieldMap(def).get(def.reportNumberField)?.label : 'Report number';
      throw new ReportError('Duplicate report identifier.', 409, [
        { field: def.reportNumberField ?? '_form', message: `${label} "${reportNumber}" is already used by another report.` },
      ]);
    }
    throw e;
  }
}

// ---- Uploads ---------------------------------------------------------------------------

const MAGIC: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

export async function uploadImage(
  deps: Deps,
  user: User,
  reportId: string,
  fieldKey: string,
  file: Buffer,
  originalName: string,
  maxBytes: number,
) {
  const report = await getReport(deps.db, reportId);
  if (!report) throw new ReportError('Report not found', 404);
  if (report.status === 'archived') throw new ReportError('Archived reports are read-only.', 409);
  const def = requireDef(report.test_type);
  const field = fieldMap(def).get(fieldKey);
  if (!field || field.type !== 'image') throw new ReportError('This field does not accept images.', 400);
  if (file.length > maxBytes) throw new ReportError(`Image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413);
  const kind = MAGIC.find((m) => m.test(file));
  if (!kind) throw new ReportError('Only PNG, JPEG or WEBP images are accepted.', 415);
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(file, { limitInputPixels: 60_000_000 }).metadata();
  } catch {
    throw new ReportError('The image could not be read. Export it again as PNG or JPEG.', 415);
  }
  if (!meta.width || !meta.height || meta.width < 50 || meta.height < 50) throw new ReportError('Image is too small to be legible.', 422);
  const id = crypto.randomUUID();
  const key = `uploads/${reportId}/${id}.${kind.ext}`;
  await deps.store.put('private', key, file, { contentType: kind.mime, cacheControl: PRIVATE_CACHE_CONTROL });
  const sha = crypto.createHash('sha256').update(file).digest('hex');
  await deps.db.query(
    `INSERT INTO report_uploads (id, report_id, field_key, private_key, mime, width, height, bytes, sha256, original_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, reportId, fieldKey, key, kind.mime, meta.width, meta.height, file.length, sha, originalName.slice(0, 200), user.id],
  );
  await audit(deps.db, reportId, user.id, 'upload', { field: fieldKey, upload_id: id, bytes: file.length });
  return { id, width: meta.width, height: meta.height, mime: kind.mime };
}

export async function getUploadBuffer(deps: Deps, reportId: string, uploadId: string) {
  const r = await deps.db.query('SELECT * FROM report_uploads WHERE id = $1 AND report_id = $2', [uploadId, reportId]);
  if (!r.rows[0]) return null;
  const buf = await deps.store.get('private', r.rows[0].private_key);
  return buf ? { buf, mime: r.rows[0].mime as string } : null;
}

// ---- Rendering -------------------------------------------------------------------------

export async function renderPreview(deps: Deps, user: User, id: string): Promise<VersionRow> {
  const report = await getReport(deps.db, id);
  if (!report) throw new ReportError('Report not found', 404);
  if (report.status === 'archived') throw new ReportError('Archived reports are read-only.', 409);
  const def = requireDef(report.test_type);
  const errors = validateData(def, report.data, 'strict');
  if (errors.length) throw new ReportError('Complete the required fields before generating a preview.', 422, errors);
  const hash = dataHash(report.data);

  // Reuse an existing ready render of identical data (no duplicate versions).
  const existing = await deps.db.query(
    `SELECT id FROM report_versions WHERE report_id = $1 AND data_hash = $2 AND status = 'ready'
       AND definition_version = $3 AND renderer_version = $4 ORDER BY version_no DESC LIMIT 1`,
    [id, hash, def.version, RENDERER_VERSION],
  );
  if (existing.rows[0]) return (await getVersion(deps.db, id, existing.rows[0].id))!;

  const version: VersionRow = await withTx(deps.db, async (tx) => {
    await tx.query('SELECT id FROM reports WHERE id = $1 FOR UPDATE', [id]);
    const n = (await tx.query('SELECT COALESCE(max(version_no), 0) + 1 AS n FROM report_versions WHERE report_id = $1', [id])).rows[0].n;
    const r = await tx.query(
      `INSERT INTO report_versions (report_id, version_no, data, data_hash, definition_version, renderer_version, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'rendering', $7) RETURNING *`,
      [id, n, JSON.stringify(report.data), hash, def.version, RENDERER_VERSION, user.id],
    );
    return r.rows[0];
  });

  const uploaded: string[] = [];
  try {
    const labels = new Map(allFields(def).map((f) => [f.key, f.label]));
    const pages = await renderDefinition(def, report.data, {
      verificationKey: report.verification_key,
      loadUpload: async (uploadId) => (await getUploadBuffer(deps, id, uploadId))?.buf ?? null,
      watermark: report.is_test_fixture ? 'TEST DATA' : undefined,
      fieldLabel: (k) => labels.get(k) ?? k,
    });
    const rows: PageRow[] = [];
    for (const p of pages) {
      const key = `reports/${id}/v${version.version_no}/p${p.pageNo}-${p.sha256.slice(0, 12)}.webp`;
      await deps.store.put('private', key, p.webp, { contentType: 'image/webp', cacheControl: PRIVATE_CACHE_CONTROL });
      uploaded.push(key);
      rows.push({
        version_id: version.id,
        page_no: p.pageNo,
        private_key: key,
        public_key: null,
        width: p.width,
        height: p.height,
        bytes: p.webp.length,
        sha256: p.sha256,
      });
    }
    await withTx(deps.db, async (tx) => {
      for (const p of rows) {
        await tx.query(
          `INSERT INTO report_version_pages (version_id, page_no, private_key, width, height, bytes, sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [p.version_id, p.page_no, p.private_key, p.width, p.height, p.bytes, p.sha256],
        );
      }
      await tx.query(`UPDATE report_versions SET status = 'ready' WHERE id = $1`, [version.id]);
      await audit(tx, id, user.id, 'render', { version: version.version_no, pages: rows.length });
    });
    return (await getVersion(deps.db, id, version.id))!;
  } catch (e) {
    for (const key of uploaded) await deps.store.delete('private', key).catch(() => {});
    const msg =
      e instanceof RenderError
        ? e.message
        : e instanceof StorageError
          ? 'The image could not be saved to storage. Nothing was published; try again.'
          : 'Image generation failed unexpectedly.';
    await deps.db.query(`UPDATE report_versions SET status = 'failed', error = $2 WHERE id = $1`, [version.id, msg]);
    await audit(deps.db, id, user.id, 'render_failed', { version: version.version_no, error: msg });
    if (!(e instanceof RenderError) && !(e instanceof StorageError)) console.error('[render] unexpected failure', e);
    throw new ReportError(msg, e instanceof StorageError ? 502 : 422, e instanceof RenderError && e.field ? [{ field: e.field, message: e.message }] : []);
  }
}

// ---- Publishing ------------------------------------------------------------------------

export async function latestReadyVersion(db: Queryable, reportId: string): Promise<VersionRow | null> {
  const r = await db.query(
    `SELECT id FROM report_versions WHERE report_id = $1 AND status = 'ready' ORDER BY version_no DESC LIMIT 1`,
    [reportId],
  );
  return r.rows[0] ? getVersion(db, reportId, r.rows[0].id) : null;
}

/** Reasons the report cannot be published right now (empty array = publishable). */
export async function publishBlockers(db: Queryable, report: ReportRow): Promise<string[]> {
  const def = getDefinition(report.test_type);
  const out: string[] = [];
  if (!def) return ['Unknown test type.'];
  if (def.status !== 'complete') out.push(`The "${def.name}" template is marked incomplete: ${def.incompleteReason ?? 'mapping not confirmed'}.`);
  if (report.status === 'archived') out.push('Archived reports cannot be published.');
  const errors = validateData(def, report.data, 'strict');
  if (errors.length) out.push(`${errors.length} field(s) need attention before publishing.`);
  const latest = await latestReadyVersion(db, report.id);
  if (!latest) out.push('Generate a preview first.');
  else if (latest.data_hash !== dataHash(report.data)) out.push('The form changed after the last preview. Generate a new preview.');
  else if (latest.definition_version !== def.version) out.push('The template definition changed. Generate a new preview.');
  if (latest && report.status === 'published' && report.published_version_id === latest.id) out.push('This version is already published.');
  return out;
}

export async function publish(deps: Deps, user: User, id: string): Promise<ReportRow> {
  if (!can.publish(user)) throw new ReportError('Only reviewers and administrators can publish reports.', 403);
  const report = await getReport(deps.db, id);
  if (!report) throw new ReportError('Report not found', 404);
  const blockers = await publishBlockers(deps.db, report);
  if (blockers.length) throw new ReportError(blockers.join(' '), 409);
  const version = (await latestReadyVersion(deps.db, id))!;
  const token = randomToken(12);
  const copied: { page_no: number; key: string }[] = [];
  try {
    for (const p of version.pages ?? []) {
      const buf = await deps.store.get('private', p.private_key);
      if (!buf) throw new StorageError(`Rendered page ${p.page_no} is missing from private storage`);
      const key = `coa/${token}/v${version.version_no}-p${p.page_no}-${p.sha256.slice(0, 12)}.webp`;
      await deps.store.put('public', key, buf, { contentType: 'image/webp', cacheControl: PUBLIC_CACHE_CONTROL });
      copied.push({ page_no: p.page_no, key });
    }
  } catch (e) {
    for (const c of copied) await deps.store.delete('public', c.key).catch(() => {});
    await audit(deps.db, id, user.id, 'publish_failed', { version: version.version_no, error: (e as Error).message });
    throw new ReportError('Publishing failed while copying the image to public storage. The report was not published; try again.', 502);
  }
  const previousVersionId = report.published_version_id;
  const updated = await withTx(deps.db, async (tx) => {
    for (const c of copied) {
      await tx.query('UPDATE report_version_pages SET public_key = $3 WHERE version_id = $1 AND page_no = $2', [version.id, c.page_no, c.key]);
    }
    const r = await tx.query(
      `UPDATE reports SET status = 'published', published_version_id = $2, published_by = $3, published_at = now(),
         first_published_at = COALESCE(first_published_at, now()), archived_at = NULL, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING *`,
      [id, version.id, user.id],
    );
    await audit(tx, id, user.id, 'publish', { version: version.version_no, replaced_version_id: previousVersionId });
    return r.rows[0] as ReportRow;
  });
  if (previousVersionId && previousVersionId !== version.id) await withdrawPublicCopies(deps, previousVersionId);
  return updated;
}

async function withdrawPublicCopies(deps: Deps, versionId: string) {
  const pages = (await deps.db.query('SELECT page_no, public_key FROM report_version_pages WHERE version_id = $1 AND public_key IS NOT NULL', [versionId])).rows;
  for (const p of pages) {
    try {
      await deps.store.delete('public', p.public_key);
      await deps.db.query('UPDATE report_version_pages SET public_key = NULL WHERE version_id = $1 AND page_no = $2', [versionId, p.page_no]);
    } catch (e) {
      console.error('[publish] could not remove public object', p.public_key, e);
    }
  }
}

export async function unpublish(deps: Deps, user: User, id: string, reason: string): Promise<ReportRow> {
  if (!can.publish(user)) throw new ReportError('Only reviewers and administrators can unpublish reports.', 403);
  const report = await getReport(deps.db, id);
  if (!report) throw new ReportError('Report not found', 404);
  if (report.status !== 'published') throw new ReportError('This report is not published.', 409);
  if (!reason.trim()) throw new ReportError('Give a reason for unpublishing.', 422, [{ field: '_reason', message: 'Required.' }]);
  const versionId = report.published_version_id;
  const updated = await withTx(deps.db, async (tx) => {
    const r = await tx.query(
      `UPDATE reports SET status = 'unpublished', published_version_id = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, user.id],
    );
    await audit(tx, id, user.id, 'unpublish', { reason: reason.trim().slice(0, 500) });
    return r.rows[0] as ReportRow;
  });
  if (versionId) await withdrawPublicCopies(deps, versionId);
  return updated;
}

export async function archive(deps: Deps, user: User, id: string, reason: string): Promise<ReportRow> {
  if (!can.archive(user)) throw new ReportError('Only reviewers and administrators can archive reports.', 403);
  const report = await getReport(deps.db, id);
  if (!report) throw new ReportError('Report not found', 404);
  if (report.status === 'archived') return report;
  if (!reason.trim()) throw new ReportError('Give a reason for archiving.', 422, [{ field: '_reason', message: 'Required.' }]);
  const versionId = report.published_version_id;
  const updated = await withTx(deps.db, async (tx) => {
    const r = await tx.query(
      `UPDATE reports SET status = 'archived', published_version_id = NULL, archived_at = now(), updated_at = now(), updated_by = $2
       WHERE id = $1 RETURNING *`,
      [id, user.id],
    );
    await audit(tx, id, user.id, 'archive', { reason: reason.trim().slice(0, 500), was: report.status });
    return r.rows[0] as ReportRow;
  });
  if (versionId) await withdrawPublicCopies(deps, versionId);
  return updated;
}

export async function restore(deps: Deps, user: User, id: string): Promise<ReportRow> {
  if (!can.archive(user)) throw new ReportError('Only reviewers and administrators can restore reports.', 403);
  const report = await getReport(deps.db, id);
  if (!report) throw new ReportError('Report not found', 404);
  if (report.status !== 'archived') throw new ReportError('Only archived reports can be restored.', 409);
  return withTx(deps.db, async (tx) => {
    const r = await tx.query(
      `UPDATE reports SET status = 'draft', archived_at = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, user.id],
    );
    await audit(tx, id, user.id, 'restore', {});
    return r.rows[0] as ReportRow;
  });
}

// ---- Public read model ---------------------------------------------------------------

export interface PublicReport {
  verificationKey: string;
  reportNumber: string | null;
  testType: string;
  testTypeName: string;
  sampleName: string | null;
  lot: string | null;
  reportDate: string | null;
  publishedAt: string;
  pages: { url: string; width: number; height: number }[];
  testData?: boolean;
}

function toPublic(store: ObjectStore, row: Record<string, unknown>, pages: PageRow[], exposeFixtureFlag: boolean): PublicReport | null {
  const def = getDefinition(row.test_type as string);
  if (!def) return null;
  const data = row.version_data as CoaData;
  const pick = (k?: string) => (k && typeof data[k] === 'string' ? (data[k] as string) : null);
  const out: PublicReport = {
    verificationKey: row.verification_key as string,
    reportNumber: (row.report_number as string) ?? null,
    testType: def.slug,
    testTypeName: def.name,
    sampleName: pick(def.summary.sampleName),
    lot: pick(def.summary.lot),
    reportDate: pick(def.summary.reportDate),
    publishedAt: new Date(row.published_at as string).toISOString(),
    pages: pages.filter((p) => p.public_key).map((p) => ({ url: store.publicUrl(p.public_key!), width: p.width, height: p.height })),
  };
  if (exposeFixtureFlag && row.is_test_fixture) out.testData = true;
  return out;
}

const PUBLIC_SELECT = `SELECT r.id, r.test_type, r.verification_key, r.report_number, r.published_at, r.is_test_fixture,
         v.id AS version_id, v.data AS version_data
    FROM reports r JOIN report_versions v ON v.id = r.published_version_id
   WHERE r.status = 'published'`;

export async function findPublishedByKey(
  deps: Deps,
  key: string,
  opts: { includeFixtures: boolean },
): Promise<PublicReport | null> {
  const r = await deps.db.query(`${PUBLIC_SELECT} AND r.verification_key = $1 ${opts.includeFixtures ? '' : 'AND NOT r.is_test_fixture'}`, [key]);
  const row = r.rows[0];
  if (!row) return null;
  const pages = (await deps.db.query('SELECT * FROM report_version_pages WHERE version_id = $1 ORDER BY page_no', [row.version_id])).rows;
  return toPublic(deps.store, row, pages, opts.includeFixtures);
}

export async function listCustomerReports(
  deps: Deps,
  customer: { id: string; email: string | null },
  f: { q?: string; type?: string; page?: number; includeFixtures: boolean },
) {
  const args: unknown[] = [customer.id];
  let match = 'r.shopify_customer_id = $1';
  if (customer.email) {
    args.push(customer.email.toLowerCase());
    match = `(r.shopify_customer_id = $1 OR (r.shopify_customer_id IS NULL AND lower(r.client_email) = $2))`;
  }
  const where = [match];
  if (!f.includeFixtures) where.push('NOT r.is_test_fixture');
  if (f.type && getDefinition(f.type)) {
    args.push(f.type);
    where.push(`r.test_type = $${args.length}`);
  }
  if (f.q?.trim()) {
    args.push(`%${f.q.trim().slice(0, 80).replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    const p = `$${args.length}`;
    where.push(`(r.verification_key ILIKE ${p} OR r.report_number ILIKE ${p} OR v.data->>'sample_name' ILIKE ${p}
                 OR v.data->>'lot_number' ILIKE ${p} OR v.data->>'sample_lot' ILIKE ${p})`);
  }
  const perPage = 10;
  const page = Math.min(Math.max(f.page ?? 1, 1), 1000);
  const base = `FROM reports r JOIN report_versions v ON v.id = r.published_version_id WHERE r.status = 'published' AND ${where.join(' AND ')}`;
  const total = Number((await deps.db.query(`SELECT count(*)::int AS n ${base}`, args)).rows[0].n);
  const rows = (
    await deps.db.query(
      `SELECT r.id, r.test_type, r.verification_key, r.report_number, r.published_at, r.is_test_fixture, r.shopify_customer_id,
              v.id AS version_id, v.data AS version_data
         ${base} ORDER BY r.published_at DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
      args,
    )
  ).rows;
  // Remember the match so later lookups do not depend on the email.
  const toLink = rows.filter((r) => !r.shopify_customer_id).map((r) => r.id);
  if (toLink.length) await deps.db.query('UPDATE reports SET shopify_customer_id = $1 WHERE id = ANY($2)', [customer.id, toLink]);
  const pages: PageRow[] = rows.length
    ? (await deps.db.query('SELECT * FROM report_version_pages WHERE version_id = ANY($1) ORDER BY page_no', [rows.map((r) => r.version_id)])).rows
    : [];
  return {
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    reports: rows
      .map((r) => toPublic(deps.store, r, pages.filter((p) => p.version_id === r.version_id), f.includeFixtures))
      .filter(Boolean) as PublicReport[],
  };
}

/** Summary used by the dashboard list. */
export function summaryOf(def: CoaDefinition | undefined, data: CoaData) {
  if (!def) return { sample: '', lot: '', client: '' };
  const s = (k?: string) => (k ? String(data[k] ?? '') : '');
  return { sample: s(def.summary.sampleName), lot: s(def.summary.lot), client: s(def.summary.client) };
}
