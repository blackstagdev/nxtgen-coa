import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROOT } from '../src/config.js';
import { FIXTURES } from './fixtures/coa-fixtures.js';
import { FORM, form, login, makeUser, PASSWORD, proxyUrl, startTestEnv, type TestEnv } from './helpers.js';

const REPO = path.resolve(APP_ROOT, '..');

function multipart(field: string, filename: string, buf: Buffer, mime = 'image/png') {
  const boundary = '----ngaTestBoundary' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\n${field}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function crop(src: string, c: [number, number, number, number]) {
  return sharp(path.join(REPO, src)).extract({ left: c[0], top: c[1], width: c[2] - c[0], height: c[3] - c[1] }).png().toBuffer();
}

const fakeShopify = {
  configured: true,
  emails: new Map<string, { email: string | null; verified: boolean }>(),
  async customerEmail(id: string) {
    return this.emails.get(id) ?? null;
  },
  async installationStatus() {
    return { installed: true, via: 'test' };
  },
  async beginInstall() {
    return 'https://example.test';
  },
  async completeInstall() {},
};

describe('staff workflow and storefront integration', () => {
  let env: TestEnv;
  let admin: { cookie: string; csrf: string };
  let staff: { cookie: string; csrf: string };
  let reportId = '';
  let vkey = '';

  beforeAll(async () => {
    env = await startTestEnv({}, fakeShopify);
    const a = await makeUser(env.db, 'admin', 'admin@example.test');
    await makeUser(env.db, 'staff', 'staff@example.test');
    expect(a.role).toBe('admin');
    admin = await login(env.app, 'admin@example.test');
    staff = await login(env.app, 'staff@example.test');
  }, 60_000);

  afterAll(async () => {
    await env?.close();
  });

  // ---- Authentication & permissions ----
  it('redirects anonymous users to sign-in and protects the API', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/admin/reports' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/admin/login');
    const post = await env.app.inject({ method: 'POST', url: '/admin/reports', payload: form({ test_type: 'hplc-purity' }), headers: FORM });
    expect(post.statusCode).toBe(401);
  });

  it('rejects wrong passwords and locks the account after repeated failures', async () => {
    await makeUser(env.db, 'staff', 'lockme@example.test');
    for (let i = 0; i < 4; i++) {
      const r = await env.app.inject({ method: 'POST', url: '/admin/login', payload: form({ email: 'lockme@example.test', password: 'wrong-password-1' }), headers: FORM });
      expect(r.statusCode).toBe(401);
    }
    const fifth = await env.app.inject({ method: 'POST', url: '/admin/login', payload: form({ email: 'lockme@example.test', password: 'wrong-password-1' }), headers: FORM });
    expect(fifth.body).toContain('temporarily locked');
    const good = await env.app.inject({ method: 'POST', url: '/admin/login', payload: form({ email: 'lockme@example.test', password: PASSWORD }), headers: FORM });
    expect(good.statusCode).toBe(401);
  });

  it('requires a CSRF token for state-changing requests', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/admin/reports', payload: form({ test_type: 'hplc-purity' }), headers: { ...FORM, cookie: staff.cookie } });
    expect(r.statusCode).toBe(403);
  });

  it('keeps user management admin-only', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: staff.cookie } });
    expect(r.statusCode).toBe(403);
    const ok = await env.app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: admin.cookie } });
    expect(ok.statusCode).toBe(200);
  });

  // ---- Draft → preview → publish ----
  it('creates a draft with a server-generated verification key', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/admin/reports', payload: form({ _csrf: staff.csrf, test_type: 'hplc-purity' }), headers: { ...FORM, cookie: staff.cookie } });
    expect(r.statusCode).toBe(302);
    reportId = r.headers.location!.split('/').pop()!;
    const row = (await env.db.query('SELECT * FROM reports WHERE id = $1', [reportId])).rows[0];
    expect(row.status).toBe('draft');
    expect(row.verification_key).toMatch(/^NGA-/);
    vkey = row.verification_key;
  });

  it('never exposes drafts through the storefront', async () => {
    const r = await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: vkey }) });
    expect(r.statusCode).toBe(404);
  });

  it('saves partial drafts but blocks preview until required fields are complete', async () => {
    const save = await env.app.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}`,
      payload: form({ _csrf: staff.csrf, _action: 'save', 'f[client]': 'Peptide Brand Name' }),
      headers: { ...FORM, cookie: staff.cookie },
    });
    expect(save.statusCode).toBe(302);
    const prev = await env.app.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}`,
      payload: form({ _csrf: staff.csrf, _action: 'preview', 'f[client]': 'Peptide Brand Name' }),
      headers: { ...FORM, cookie: staff.cookie },
    });
    expect(prev.statusCode).toBe(422);
    expect(prev.body).toContain('Complete the required fields');
  });

  it('validates field formats server-side', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}`,
      payload: form({ _csrf: staff.csrf, _action: 'save', 'f[purity_percent]': '99.96%', 'f[report_date]': '2025-13-01' }),
      headers: { ...FORM, cookie: staff.cookie },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('Enter a number');
    expect(r.body).toContain('Enter a valid date');
  });

  it('accepts image uploads only as real images and only for image fields', async () => {
    const fake = multipart('chromatogram', 'x.png', Buffer.from('not an image at all'));
    const bad = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/uploads`, payload: fake.body, headers: { ...fake.headers, cookie: staff.cookie, 'x-csrf-token': staff.csrf } });
    expect(bad.statusCode).toBe(415);
    const png = await crop('docs/reference/hplc-purity/filled-p1.png', [141, 790, 1266, 1170]);
    const wrongField = multipart('client', 'c.png', png);
    const wf = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/uploads`, payload: wrongField.body, headers: { ...wrongField.headers, cookie: staff.cookie, 'x-csrf-token': staff.csrf } });
    expect(wf.statusCode).toBe(400);
  });

  async function upload(field: string, buf: Buffer) {
    const mp = multipart(field, `${field}.png`, buf);
    const r = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/uploads`, payload: mp.body, headers: { ...mp.headers, cookie: staff.cookie, 'x-csrf-token': staff.csrf } });
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.body).id as string;
  }

  let chromId = '';
  let peakId = '';
  const fx = FIXTURES.find((f) => f.slug === 'hplc-purity')!;
  const baseForm = () => ({
    _csrf: staff.csrf,
    'f[client]': String(fx.data.client),
    'f[sample_name]': String(fx.data.sample_name),
    'f[lot_number]': String(fx.data.lot_number),
    'f[report_date]': String(fx.data.report_date),
    'f[purity_percent]': '99.96',
    'f[chromatogram][]': [chromId],
    'f[peak_table][]': [peakId],
    _client_email: 'client@example.test',
    _internal_notes: 'Internal: sample received cold.',
  });

  it('generates a preview version stored privately as WEBP', async () => {
    chromId = await upload('chromatogram', await crop('docs/reference/hplc-purity/filled-p1.png', [141, 790, 1266, 1170]));
    peakId = await upload('peak_table', await crop('docs/reference/hplc-purity/filled-p1.png', [151, 1262, 666, 1399]));
    const r = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}`, payload: form({ ...baseForm(), _action: 'preview' }), headers: { ...FORM, cookie: staff.cookie } });
    expect(r.statusCode).toBe(302);
    const v = (await env.db.query('SELECT * FROM report_versions WHERE report_id = $1', [reportId])).rows;
    expect(v).toHaveLength(1);
    expect(v[0].status).toBe('ready');
    const pages = (await env.db.query('SELECT * FROM report_version_pages WHERE version_id = $1', [v[0].id])).rows;
    expect(pages[0].public_key).toBeNull();
    const obj = env.store.objects.get(`private:${pages[0].private_key}`);
    expect(obj?.opts.contentType).toBe('image/webp');
    expect([...env.store.objects.keys()].some((k) => k.startsWith('public:'))).toBe(false);
    // Staff can view the private preview; anonymous users cannot.
    const img = await env.app.inject({ method: 'GET', url: `/admin/reports/${reportId}/versions/${v[0].id}/pages/1`, headers: { cookie: staff.cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    const anon = await env.app.inject({ method: 'GET', url: `/admin/reports/${reportId}/versions/${v[0].id}/pages/1` });
    expect(anon.statusCode).toBe(302);
  }, 60_000);

  it('does not let staff publish', async () => {
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/publish`, payload: form({ _csrf: staff.csrf }), headers: { ...FORM, cookie: staff.cookie } });
    const row = (await env.db.query('SELECT status FROM reports WHERE id = $1', [reportId])).rows[0];
    expect(row.status).toBe('draft');
  });

  it('publishes for reviewers/admins, copying the image to the public bucket with immutable caching', async () => {
    const r = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/publish`, payload: form({ _csrf: admin.csrf }), headers: { ...FORM, cookie: admin.cookie } });
    expect(r.statusCode).toBe(302);
    const row = (await env.db.query('SELECT * FROM reports WHERE id = $1', [reportId])).rows[0];
    expect(row.status).toBe('published');
    const pub = [...env.store.objects.entries()].filter(([k]) => k.startsWith('public:'));
    expect(pub).toHaveLength(1);
    expect(pub[0][1].opts).toEqual({ contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
  });

  it('serves the published report through the signed proxy without private data', async () => {
    const r = await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: vkey.toLowerCase() }) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.body);
    expect(body.report.verificationKey).toBe(vkey);
    expect(body.report.sampleName).toBe('GLP-2 (11mg)');
    expect(body.report.pages[0].url).toMatch(/^https:\/\/assets\.test\/coa\//);
    const raw = r.body;
    expect(raw).not.toContain('client@example.test');
    expect(raw).not.toContain('Internal');
    expect(raw).not.toContain(reportId);
  });

  it('serves published images from /coa-assets and nothing else', async () => {
    const key = [...env.store.objects.keys()].find((k) => k.startsWith('public:'))!.slice('public:'.length);
    const ok = await env.app.inject({ method: 'GET', url: `/coa-assets/${key}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    expect(ok.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // Private objects (drafts, uploads, versions) are never reachable through this route.
    const privateKey = [...env.store.objects.keys()].find((k) => k.startsWith('private:reports/'))!.slice('private:'.length);
    expect((await env.app.inject({ method: 'GET', url: `/coa-assets/${privateKey}` })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/coa-assets/coa/../../etc/passwd' })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/coa-assets/coa/AAAAAAAAAAAA/v1-p1-000000000000.webp' })).statusCode).toBe(404);
  });

  it('rejects unsigned or tampered proxy requests', async () => {
    const unsigned = await env.app.inject({ method: 'GET', url: `/proxy/api/verify?key=${vkey}` });
    expect(unsigned.statusCode).toBe(401);
    const tampered = proxyUrl('/proxy/api/verify', { key: vkey }).replace('path_prefix=%2Fapps%2Fcoa', 'path_prefix=%2Fapps%2Fx');
    expect((await env.app.inject({ method: 'GET', url: tampered })).statusCode).toBe(401);
  });

  it('validates the lookup key format and returns a not-found state for unknown keys', async () => {
    const bad = await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: '<script>' }) });
    expect(bad.statusCode).toBe(400);
    const miss = await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: 'NGA-0000-0000-0000' }) });
    expect(miss.statusCode).toBe(404);
  });

  it('keeps the published version public while edits are pending, then republishes', async () => {
    const edit = await env.app.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}`,
      payload: form({ ...baseForm(), _csrf: admin.csrf, _action: 'save', 'f[purity_percent]': '99.95' }),
      headers: { ...FORM, cookie: admin.cookie },
    });
    expect(edit.statusCode).toBe(302);
    let body = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: vkey }) })).body);
    const oldUrl = body.report.pages[0].url;
    // Publishing is blocked until a fresh preview exists.
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/publish`, payload: form({ _csrf: admin.csrf }), headers: { ...FORM, cookie: admin.cookie } });
    const versionsBefore = (await env.db.query('SELECT count(*)::int n FROM report_versions WHERE report_id = $1', [reportId])).rows[0].n;
    expect(versionsBefore).toBe(1);
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}`, payload: form({ ...baseForm(), _csrf: admin.csrf, _action: 'preview', 'f[purity_percent]': '99.95' }), headers: { ...FORM, cookie: admin.cookie } });
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/publish`, payload: form({ _csrf: admin.csrf }), headers: { ...FORM, cookie: admin.cookie } });
    body = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: vkey }) })).body);
    expect(body.report.pages[0].url).not.toBe(oldUrl);
    // Old public object removed; both private versions retained.
    const oldKey = oldUrl.replace('https://assets.test/', '');
    expect(env.store.objects.has(`public:${oldKey}`)).toBe(false);
    const versions = (await env.db.query('SELECT version_no, status FROM report_versions WHERE report_id = $1 ORDER BY version_no', [reportId])).rows;
    expect(versions.map((v) => v.version_no)).toEqual([1, 2]);
  }, 60_000);

  it('lists published reports for the matching signed-in customer only', async () => {
    fakeShopify.emails.set('111', { email: 'client@example.test', verified: true });
    fakeShopify.emails.set('222', { email: 'someone-else@example.test', verified: true });
    fakeShopify.emails.set('333', { email: 'client@example.test', verified: false });
    const mine = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/my-reports', {}, '111') })).body);
    expect(mine.total).toBe(1);
    expect(mine.reports[0].verificationKey).toBe(vkey);
    const other = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/my-reports', {}, '222') })).body);
    expect(other.total).toBe(0);
    const unverified = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/my-reports', {}, '333') })).body);
    expect(unverified.total).toBe(0);
    const anon = await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/my-reports') });
    expect(anon.statusCode).toBe(401);
  });

  it('prevents duplicate report identifiers', async () => {
    const mk = async () => {
      const r = await env.app.inject({ method: 'POST', url: '/admin/reports', payload: form({ _csrf: staff.csrf, test_type: 'endotoxin' }), headers: { ...FORM, cookie: staff.cookie } });
      return r.headers.location!.split('/').pop()!;
    };
    const a = await mk();
    const b = await mk();
    const first = await env.app.inject({ method: 'POST', url: `/admin/reports/${a}`, payload: form({ _csrf: staff.csrf, _action: 'save', 'f[report_id]': 'NGA-25081040-001' }), headers: { ...FORM, cookie: staff.cookie } });
    expect(first.statusCode).toBe(302);
    const dup = await env.app.inject({ method: 'POST', url: `/admin/reports/${b}`, payload: form({ _csrf: staff.csrf, _action: 'save', 'f[report_id]': 'nga-25081040-001' }), headers: { ...FORM, cookie: staff.cookie } });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toContain('already used by another report');
  });

  it('unpublishes: public lookups stop and public objects are deleted', async () => {
    const before = [...env.store.objects.keys()].filter((k) => k.startsWith('public:'));
    expect(before.length).toBe(1);
    const noReason = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/unpublish`, payload: form({ _csrf: admin.csrf, reason: '' }), headers: { ...FORM, cookie: admin.cookie } });
    expect(noReason.statusCode).toBe(302);
    expect((await env.db.query('SELECT status FROM reports WHERE id = $1', [reportId])).rows[0].status).toBe('published');
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/unpublish`, payload: form({ _csrf: admin.csrf, reason: 'Client requested withdrawal' }), headers: { ...FORM, cookie: admin.cookie } });
    expect((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: vkey }) })).statusCode).toBe(404);
    expect([...env.store.objects.keys()].filter((k) => k.startsWith('public:'))).toHaveLength(0);
    const mine = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/my-reports', {}, '111') })).body);
    expect(mine.total).toBe(0);
  });

  it('records who created, changed, rendered, published and unpublished', async () => {
    const rows = (
      await env.db.query(
        `SELECT a.action, u.email FROM audit_events a JOIN users u ON u.id = a.user_id WHERE a.report_id = $1 ORDER BY a.id`,
        [reportId],
      )
    ).rows;
    const actions = rows.map((r) => `${r.action}:${r.email}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'create:staff@example.test',
        'edit:staff@example.test',
        'upload:staff@example.test',
        'render:staff@example.test',
        'publish:admin@example.test',
        'edit:admin@example.test',
        'unpublish:admin@example.test',
      ]),
    );
  });

  it('archives read-only and restores to draft', async () => {
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/archive`, payload: form({ _csrf: admin.csrf, reason: 'Superseded' }), headers: { ...FORM, cookie: admin.cookie } });
    expect((await env.db.query('SELECT status FROM reports WHERE id = $1', [reportId])).rows[0].status).toBe('archived');
    const edit = await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}`, payload: form({ ...baseForm(), _action: 'save', 'f[client]': 'Changed' }), headers: { ...FORM, cookie: staff.cookie } });
    expect(edit.statusCode).toBe(409);
    await env.app.inject({ method: 'POST', url: `/admin/reports/${reportId}/restore`, payload: form({ _csrf: admin.csrf }), headers: { ...FORM, cookie: admin.cookie } });
    expect((await env.db.query('SELECT status FROM reports WHERE id = $1', [reportId])).rows[0].status).toBe('draft');
  });

  it('rate-limits public lookups', async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key: 'NGA-0000-0000-0001' }), headers: { 'x-forwarded-for': '203.0.113.9' } });
      if (r.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it('exposes a health check', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });
});

describe('test fixtures stay out of production results', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv({}, fakeShopify);
  }, 60_000);
  afterAll(async () => env?.close());

  it('hides fixture reports from the proxy when running in production mode', async () => {
    const admin = await makeUser(env.db, 'admin', 'fx-admin@example.test');
    const key = 'NGA-FX00-0000-0001';
    const rep = (
      await env.db.query(
        `INSERT INTO reports (test_type, definition_version, verification_key, status, is_test_fixture, data, created_by)
         VALUES ('hplc-purity', 1, $1, 'published', true, '{}', $2) RETURNING id`,
        [key, admin.id],
      )
    ).rows[0];
    const v = (
      await env.db.query(
        `INSERT INTO report_versions (report_id, version_no, data, data_hash, definition_version, renderer_version, status)
         VALUES ($1, 1, '{"sample_name":"TEST"}', 'x', 1, 'r1', 'ready') RETURNING id`,
        [rep.id],
      )
    ).rows[0];
    await env.db.query('UPDATE reports SET published_version_id = $1, published_at = now() WHERE id = $2', [v.id, rep.id]);
    // test env (non-production) shows fixtures, flagged as test data
    const dev = JSON.parse((await env.app.inject({ method: 'GET', url: proxyUrl('/proxy/api/verify', { key }) })).body);
    expect(dev.report.testData).toBe(true);
    // production config hides them entirely
    const { findPublishedByKey } = await import('../src/reports/service.js');
    expect(await findPublishedByKey({ db: env.db, store: env.store }, key, { includeFixtures: false })).toBeNull();
  });
});
