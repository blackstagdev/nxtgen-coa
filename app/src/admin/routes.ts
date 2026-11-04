import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../app.js';
import {
  authenticate,
  can,
  countActiveAdmins,
  createSession,
  createUser,
  destroySession,
  getUser,
  listUsers,
  passwordProblem,
  ROLE_LABELS,
  ROLES,
  setPassword,
  verifyPassword,
  type Role,
  type User,
} from '../auth/users.js';
import { DEFINITIONS, getDefinition } from '../coa/definitions/index.js';
import { validateData } from '../coa/validate.js';
import { hit } from '../lib/rate-limit.js';
import { dataHash, timingSafeEqualStr } from '../lib/security.js';
import {
  archive,
  audit,
  createReport,
  getAudit,
  getReport,
  getUploadBuffer,
  getUploads,
  getVersion,
  getVersions,
  listReports,
  publish,
  publishBlockers,
  renderPreview,
  ReportError,
  restore,
  saveDraft,
  summaryOf,
  unpublish,
  uploadImage,
  type Deps,
} from '../reports/service.js';

type Body = Record<string, string | string[] | undefined>;

/** Non-secret R2 connection details for the Integrations page (masked). */
function r2Diagnostics(cfg: FastifyInstance['deps']['cfg']) {
  const r2 = cfg.storage.r2;
  const mask = (v?: string, keep = 4) => (!v ? 'not set' : v.length <= keep * 2 ? `${v.length} chars` : `${v.slice(0, keep)}…${v.slice(-keep)} (${v.length} chars)`);
  const endpoint = r2.endpoint || `https://${r2.accountId ?? '?'}.r2.cloudflarestorage.com`;
  return {
    endpoint: endpoint.replace(/^https:\/\/([^.]+)/, (_m, id: string) => `https://${mask(id)}`),
    endpointSource: r2.endpoint ? 'R2_ENDPOINT' : 'built from R2_ACCOUNT_ID',
    accessKey: mask(r2.accessKeyId),
    secretLength: r2.secretAccessKey ? `${r2.secretAccessKey.length} chars${/\s/.test(r2.secretAccessKey) ? ' — contains whitespace!' : ''}` : 'not set',
    buckets: `${r2.privateBucket}, ${r2.publicBucket}`,
  };
}

export function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

function setFlash(reply: FastifyReply, type: 'success' | 'error' | 'info', message: string, extra: Record<string, unknown> = {}) {
  reply.setCookie('nga_flash', JSON.stringify({ type, message, ...extra }).slice(0, 3500), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: reply.server.deps.cfg.env === 'production',
    signed: true,
    maxAge: 60,
  });
}

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[v.length - 1] ?? '') : (v ?? '');
}

/** Extracts `f[key]` / `f[key][]` form fields into a plain object. */
export function formData(body: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const m = /^f\[([a-z0-9_]+)\](\[\])?$/.exec(k);
    if (!m) continue;
    out[m[1]] = m[2] ? (Array.isArray(v) ? v : v ? [v] : []) : v;
  }
  return out;
}

export async function registerAdminRoutes(app: FastifyInstance) {
  const { cfg, db } = app.deps;
  const deps: Deps = { db, store: app.deps.store };
  const secureCookie = cfg.env === 'production';

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) {
      if (req.method === 'GET') return reply.redirect(`/admin/login?next=${encodeURIComponent(req.url)}`);
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
  const requireCsrf = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const sent = (req.headers['x-csrf-token'] as string) || one((req.body as Body | undefined)?._csrf);
    if (!req.session || !sent || !timingSafeEqualStr(sent, req.session.csrf)) {
      return reply.code(403).send({ error: 'csrf', message: 'Your session expired. Reload the page and try again.' });
    }
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session || !can.manageUsers(req.session.user)) {
      return app.view(reply, 'error', { title: 'Not allowed', message: 'Only administrators can access this page.' }, 403);
    }
  };
  const auth = { preHandler: [requireUser, requireCsrf] };
  const adminOnly = { preHandler: [requireUser, requireCsrf, requireAdmin] };
  const userOf = (req: FastifyRequest) => req.session!.user as User;

  // ---- Login ----------------------------------------------------------------------
  app.get('/admin/login', async (req, reply) => {
    if (req.session) return reply.redirect('/admin/reports');
    return app.view(reply, 'login', { title: 'Sign in', next: (req.query as Body).next ?? '', error: null, email: '' });
  });

  app.post('/admin/login', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const email = one(body.email).trim().slice(0, 200);
    const password = one(body.password).slice(0, 300);
    let next = one(body.next);
    if (!next.startsWith('/admin') || next.startsWith('//')) next = '/admin/reports';
    const ipOk = await hit(db, `login-ip:${clientIp(req)}`, 30, 15 * 60);
    const emailOk = await hit(db, `login-email:${email.toLowerCase()}`, 10, 15 * 60);
    if (!ipOk || !emailOk) {
      return app.view(reply, 'login', { title: 'Sign in', next, email, error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }, 429);
    }
    const result = await authenticate(db, email, password);
    if (!result.ok) {
      const message =
        result.reason === 'locked'
          ? 'This account is temporarily locked after repeated failed attempts. Try again in 15 minutes.'
          : 'Email or password is incorrect.';
      await audit(db, null, null, 'login_failed', { email: email.toLowerCase(), reason: result.reason, ip: clientIp(req) });
      return app.view(reply, 'login', { title: 'Sign in', next, email, error: message }, 401);
    }
    const { token } = await createSession(db, result.user.id, cfg.sessionTtlHours, { ip: clientIp(req), ua: req.headers['user-agent'] });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      signed: true,
      maxAge: cfg.sessionTtlHours * 3600,
    });
    await audit(db, null, result.user.id, 'login', { ip: clientIp(req) });
    return reply.redirect(next);
  });

  app.post('/admin/logout', auth, async (req, reply) => {
    await destroySession(db, req.session!.idHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/admin/login');
  });

  app.get('/admin', auth, async (_req, reply) => reply.redirect('/admin/reports'));

  // ---- Reports list ---------------------------------------------------------------
  app.get('/admin/reports', auth, async (req, reply) => {
    const q = req.query as Body;
    const result = await listReports(db, {
      q: one(q.q).slice(0, 100),
      status: one(q.status),
      type: one(q.type),
      page: Number(one(q.page)) || 1,
    });
    const rows = result.rows.map((r) => {
      const def = getDefinition(r.test_type);
      return { ...r, def, summary: summaryOf(def, r.data) };
    });
    return app.view(reply, 'reports', {
      title: 'Reports',
      result: { ...result, rows },
      filters: { q: one(q.q), status: one(q.status), type: one(q.type) },
      definitions: DEFINITIONS,
    });
  });

  app.get('/admin/reports/new', auth, async (_req, reply) => {
    return app.view(reply, 'new-report', { title: 'New report', definitions: DEFINITIONS });
  });

  app.post('/admin/reports', auth, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const def = getDefinition(one(body.test_type));
    if (!def) {
      setFlash(reply, 'error', 'Choose a test type.');
      return reply.redirect('/admin/reports/new');
    }
    const isFixture = one(body.test_fixture) === '1';
    const report = await createReport(deps, userOf(req), def.slug, { isTestFixture: isFixture });
    setFlash(reply, 'success', `Draft created for ${def.name}.`);
    return reply.redirect(`/admin/reports/${report.id}`);
  });

  // ---- Report editor --------------------------------------------------------------
  async function renderEditor(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    override?: { data?: Record<string, unknown>; errors?: { field: string; message: string }[]; message?: string; internalNotes?: string; clientEmail?: string },
    status = 200,
  ) {
    const report = await getReport(db, id);
    if (!report) return app.view(reply, 'error', { title: 'Not found', message: 'Report not found.' }, 404);
    const def = getDefinition(report.test_type)!;
    const [versions, uploads, auditRows] = await Promise.all([getVersions(db, id), getUploads(db, id), getAudit(db, id)]);
    const blockers = await publishBlockers(db, report);
    const latest = versions.find((v) => v.status === 'ready') ?? null;
    const currentHash = dataHash(report.data);
    const missing = validateData(def, report.data, 'strict');
    const published = report.published_version_id ? versions.find((v) => v.id === report.published_version_id) ?? null : null;
    return app.view(
      reply,
      'report',
      {
        title: `${def.name} · ${report.verification_key}`,
        report,
        def,
        data: override?.data ?? report.data,
        errors: override?.errors ?? [],
        errorMessage: override?.message ?? null,
        internalNotes: override?.internalNotes ?? report.internal_notes,
        clientEmail: override?.clientEmail ?? report.client_email ?? '',
        versions,
        latest,
        latestIsCurrent: !!latest && latest.data_hash === currentHash,
        published,
        hasUnpublishedChanges: !!published && published.data_hash !== currentHash,
        uploads,
        audit: auditRows,
        blockers,
        missingCount: missing.length,
        canPublish: can.publish(userOf(req)),
        canArchive: can.archive(userOf(req)),
        publicBase: cfg.storage.publicBaseUrl,
      },
      status,
    );
  }

  app.get('/admin/reports/:id', auth, async (req, reply) => renderEditor(req, reply, (req.params as { id: string }).id));

  async function handleSave(req: FastifyRequest, reply: FastifyReply, id: string) {
    const body = (req.body ?? {}) as Body;
    const data = formData(body);
    const notes = one(body._internal_notes);
    const clientEmail = one(body._client_email);
    try {
      await saveDraft(deps, userOf(req), id, { data, internalNotes: notes, clientEmail });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof ReportError) {
        return { ok: false as const, response: await renderEditor(req, reply, id, { data, errors: e.fieldErrors, message: e.message, internalNotes: notes, clientEmail }, e.status) };
      }
      throw e;
    }
  }

  app.post('/admin/reports/:id', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const action = one((req.body as Body)?._action);
    const saved = await handleSave(req, reply, id);
    if (!saved.ok) return saved.response;
    if (action === 'preview') {
      try {
        const v = await renderPreview(deps, userOf(req), id);
        setFlash(reply, 'success', `Preview generated (version ${v.version_no}). Check every page before publishing.`);
        return reply.redirect(`/admin/reports/${id}#preview`);
      } catch (e) {
        if (e instanceof ReportError) {
          const report = await getReport(db, id);
          return renderEditor(req, reply, id, { data: report?.data, errors: e.fieldErrors, message: e.message }, e.status);
        }
        throw e;
      }
    }
    setFlash(reply, 'success', 'Draft saved.');
    return reply.redirect(`/admin/reports/${id}`);
  });

  app.post('/admin/reports/:id/publish', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await publish(deps, userOf(req), id);
      setFlash(reply, 'success', 'Published. The report is now available on Verify COA.');
    } catch (e) {
      if (!(e instanceof ReportError)) throw e;
      setFlash(reply, 'error', e.message);
    }
    return reply.redirect(`/admin/reports/${id}`);
  });

  app.post('/admin/reports/:id/unpublish', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await unpublish(deps, userOf(req), id, one((req.body as Body)?.reason));
      setFlash(reply, 'success', 'Unpublished. The report and its public images are no longer available.');
    } catch (e) {
      if (!(e instanceof ReportError)) throw e;
      setFlash(reply, 'error', e.message);
    }
    return reply.redirect(`/admin/reports/${id}`);
  });

  app.post('/admin/reports/:id/archive', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await archive(deps, userOf(req), id, one((req.body as Body)?.reason));
      setFlash(reply, 'success', 'Archived.');
    } catch (e) {
      if (!(e instanceof ReportError)) throw e;
      setFlash(reply, 'error', e.message);
    }
    return reply.redirect(`/admin/reports/${id}`);
  });

  app.post('/admin/reports/:id/restore', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await restore(deps, userOf(req), id);
      setFlash(reply, 'success', 'Restored as a draft.');
    } catch (e) {
      if (!(e instanceof ReportError)) throw e;
      setFlash(reply, 'error', e.message);
    }
    return reply.redirect(`/admin/reports/${id}`);
  });

  // Uploads (fetch from admin.js; CSRF via header)
  app.post('/admin/reports/:id/uploads', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = await hit(db, `upload:${userOf(req).id}`, 120, 3600);
    if (!ok) return reply.code(429).send({ error: 'rate_limited', message: 'Too many uploads; wait a little.' });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no_file', message: 'Choose an image to upload.' });
    const field = String((file.fields.field as { value?: string } | undefined)?.value ?? '');
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'too_large', message: `Image is larger than ${Math.round(cfg.uploadMaxBytes / 1048576)} MB.` });
    }
    try {
      const up = await uploadImage(deps, userOf(req), id, field, buf, file.filename, cfg.uploadMaxBytes);
      return reply.send({ ...up, url: `/admin/reports/${id}/uploads/${up.id}` });
    } catch (e) {
      if (e instanceof ReportError) return reply.code(e.status).send({ error: 'upload_failed', message: e.message });
      req.log.error(e);
      return reply.code(502).send({ error: 'upload_failed', message: 'The image could not be stored. Try again.' });
    }
  });

  app.get('/admin/reports/:id/uploads/:uid', auth, async (req, reply) => {
    const { id, uid } = req.params as { id: string; uid: string };
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return reply.code(404).send();
    const out = await getUploadBuffer(deps, id, uid);
    if (!out) return reply.code(404).send();
    return reply.header('Cache-Control', 'private, max-age=300').type(out.mime).send(out.buf);
  });

  app.get('/admin/reports/:id/versions/:vid/pages/:n', auth, async (req, reply) => {
    const { id, vid, n } = req.params as { id: string; vid: string; n: string };
    if (!/^[0-9a-f-]{36}$/i.test(vid)) return reply.code(404).send();
    const v = await getVersion(db, id, vid);
    const page = v?.pages?.find((p) => p.page_no === Number(n));
    if (!page) return reply.code(404).send();
    const buf = await app.deps.store.get('private', page.private_key);
    if (!buf) return reply.code(404).send();
    const dl = (req.query as Body).download === '1';
    const report = await getReport(db, id);
    if (dl) reply.header('Content-Disposition', `attachment; filename="${report?.verification_key ?? 'coa'}-v${v!.version_no}-p${page.page_no}.webp"`);
    return reply.header('Cache-Control', 'private, max-age=86400, immutable').type('image/webp').send(buf);
  });

  // ---- Users (admin) -----------------------------------------------------------------
  app.get('/admin/users', adminOnly, async (_req, reply) => {
    return app.view(reply, 'users', { title: 'Users', users: await listUsers(db), roles: ROLES, roleLabels: ROLE_LABELS, errors: [], form: {} });
  });

  app.post('/admin/users', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const form = { email: one(body.email).trim(), name: one(body.name).trim(), role: one(body.role) as Role };
    const password = one(body.password);
    const errors: { field: string; message: string }[] = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email)) errors.push({ field: 'email', message: 'Enter a valid email.' });
    if (!form.name) errors.push({ field: 'name', message: 'Required.' });
    if (!ROLES.includes(form.role)) errors.push({ field: 'role', message: 'Choose a role.' });
    const pwProblem = passwordProblem(password);
    if (pwProblem) errors.push({ field: 'password', message: pwProblem });
    if (!errors.length) {
      try {
        const u = await createUser(db, { ...form, password });
        await audit(db, null, userOf(req).id, 'user_create', { user_id: u.id, email: u.email, role: u.role });
        setFlash(reply, 'success', `Account created for ${u.email}. Share the temporary password securely and ask them to change it.`);
        return reply.redirect('/admin/users');
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'users_email_key') errors.push({ field: 'email', message: 'An account with this email already exists.' });
        else throw e;
      }
    }
    return app.view(reply, 'users', { title: 'Users', users: await listUsers(db), roles: ROLES, roleLabels: ROLE_LABELS, errors, form }, 422);
  });

  app.post('/admin/users/:id', adminOnly, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as Body;
    const target = await getUser(db, id);
    if (!target) return reply.redirect('/admin/users');
    const role = one(body.role) as Role;
    const active = one(body.is_active) === '1';
    const me = userOf(req);
    const demotingAdmin = target.role === 'admin' && (role !== 'admin' || !active);
    if (demotingAdmin && (await countActiveAdmins(db)) <= 1) {
      setFlash(reply, 'error', 'At least one active administrator is required.');
      return reply.redirect('/admin/users');
    }
    if (target.id === me.id && !active) {
      setFlash(reply, 'error', 'You cannot deactivate your own account.');
      return reply.redirect('/admin/users');
    }
    if (ROLES.includes(role)) {
      await db.query('UPDATE users SET role = $2, is_active = $3, updated_at = now() WHERE id = $1', [id, role, active]);
      if (!active) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(db, null, me.id, 'user_update', { user_id: id, role, active });
    }
    const newPw = one(body.new_password);
    if (newPw) {
      try {
        await setPassword(db, id, newPw);
        await audit(db, null, me.id, 'user_password_reset', { user_id: id });
      } catch (e) {
        setFlash(reply, 'error', (e as Error).message);
        return reply.redirect('/admin/users');
      }
    }
    setFlash(reply, 'success', `Updated ${target.email}.`);
    return reply.redirect('/admin/users');
  });

  // ---- Account --------------------------------------------------------------------
  app.get('/admin/account', auth, async (_req, reply) => app.view(reply, 'account', { title: 'Account', error: null }));

  app.post('/admin/account/password', auth, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const me = userOf(req);
    if (!(await verifyPassword(db, me.id, one(body.current_password)))) {
      return app.view(reply, 'account', { title: 'Account', error: 'Current password is incorrect.' }, 422);
    }
    if (one(body.new_password) !== one(body.confirm_password)) {
      return app.view(reply, 'account', { title: 'Account', error: 'The new passwords do not match.' }, 422);
    }
    try {
      await setPassword(db, me.id, one(body.new_password));
    } catch (e) {
      return app.view(reply, 'account', { title: 'Account', error: (e as Error).message }, 422);
    }
    await audit(db, null, me.id, 'password_change', {});
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    setFlash(reply, 'success', 'Password changed. Sign in again with the new password.');
    return reply.redirect('/admin/login');
  });

  // ---- Integration status (admin) ----------------------------------------------------
  app.get('/admin/settings', adminOnly, async (_req, reply) => {
    const storage = await app.deps.store.check().catch((e) => ({ ok: false, detail: (e as Error).message }));
    const shop = await app.deps.shopify.installationStatus().catch(() => ({ installed: false }));
    return app.view(reply, 'settings', {
      title: 'Integrations',
      storage,
      storageDriver: app.deps.store.driver,
      publicBase: cfg.storage.publicBaseUrl,
      r2Info: cfg.storage.driver === 'r2' ? r2Diagnostics(cfg) : null,
      shopify: { configured: app.deps.shopify.configured, shop: cfg.shopify.shop, ...shop, proxyUrl: `${cfg.appUrl}/proxy` },
    });
  });
}
