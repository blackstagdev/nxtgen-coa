# NxtGen Analysis — COA platform and Shopify theme

This repository holds two things:

- **`theme/`** — the improved Shopify theme for https://nxtgenanalysis.com. It is based on Atelier 3.1.0.
- **`app/`** — the COA application. Staff use it to enter verified results, preview the generated certificate (WEBP), and publish it. The Shopify storefront uses it to verify and list published reports.

Supporting material:

| Path | Contents |
|---|---|
| `docs/product-template-mapping.md` | Field-by-field mapping for every test type (generated from code) |
| `docs/findings.md` | Audit of the previous theme and integrations, plus the architecture decision |
| `docs/reference/` | Normalized completed COA examples |
| `Products/` | Original template images (read-only reference) |
| `.claude/CLAUDE.md` | Project memory for Claude Code |

> Nothing in this repository pushes to a remote, publishes the live theme, or deploys services. Those steps are listed below and need an authorized person.

---

## 1. Architecture

```
 Shopify storefront (theme/)                         Render
 ┌───────────────────────────┐   /apps/coa/*   ┌─────────────────────────────────┐
 │ Verify COA  (?key=…)      │ ──────────────▶ │ nga-coa (Node 24, Fastify)       │
 │ Test Reports (signed in)  │  Shopify signs  │  /proxy/api/*  (HMAC-verified)   │
 │ Order Tests / product     │  every request  │  /admin/*      staff dashboard   │
 └───────────────────────────┘                 │  /healthz                        │
            ▲  images (public, immutable)      └──────┬──────────────┬───────────┘
            │                                         │              │
   coa-cdn.<domain> ◀── R2 public bucket ◀── publish ─┘     Render Postgres
                         R2 private bucket ◀── drafts, uploads, every rendered version
```

**Why one application?** The dashboard and the storefront need the same records, rendering and storage. One service means one database, one place for secrets and one deployment. Shopify's **app proxy** lets the theme call the app on the store's own domain, so there is no CORS setup and no secrets in the browser. Shopify signs each proxied request and includes the signed-in customer's ID.

### Security model

**Staff dashboard**
- Passwords are hashed with argon2id.
- Sessions are stored in the database and use signed HttpOnly cookies. They expire after 12 hours.
- Every form carries a CSRF token.
- An account locks for 15 minutes after 5 failed sign-ins. Sign-in attempts are also rate-limited per IP address and per email.
- Strict Content-Security-Policy.
- Roles:
  - **admin** — users and integrations
  - **reviewer** — publish, unpublish and archive
  - **staff** — drafts and previews

**Storefront API**
- Every request must carry a valid Shopify app-proxy signature. Requests from other shops, or with a signature older than 10 minutes, are rejected.
- Verification lookups are rate-limited per visitor IP, and failed lookups are counted separately.
- Lookups use a random 60-bit key (`NGA-XXXX-XXXX-XXXX`).

**Draft and public separation**
- Public queries only read reports with `status = 'published'`, through the published version snapshot.
- Drafts, unpublished and archived reports are never returned.
- Public images exist only in the public bucket, under random paths, and only while the report is published. Unpublishing and archiving delete them.

**Private data**
- Client email for account matching and internal notes are never returned by the API.
- Caveat: the pH and Sterility templates print the client email on the certificate image itself.

**Shopify permissions**
- The only scope requested is `read_customers`. It is used to read a signed-in customer's **verified** email for the Test Reports page.

### COA lifecycle

1. **Draft.** Staff choose a test type and fill in its form. Saving uses lenient validation.
2. **Preview.** This runs strict server-side validation, then renders every page onto the blank template as WEBP. The result is stored privately as an immutable **version**: a data snapshot plus `data_hash`.
3. **Publish** (reviewer or admin). Allowed only when the latest preview matches the current data and the template is marked complete. The pages are copied to the public bucket with `Cache-Control: public, max-age=31536000, immutable`.
4. **Edit after publishing.** Changes go into the draft only. The public page keeps showing the published snapshot until a new preview is published. Older public copies are then removed; every private version is kept.
5. **Unpublish or archive.** A reason is required. Both are recorded in the audit trail.

Every create, edit (which fields changed), upload, render, publish, unpublish, archive, restore, sign-in and user change is recorded in `audit_events`.

Rendering never calculates or infers results. Average quantity, statuses and pH values are entered exactly as the analyst types them, and numbers are stored as typed so precision is preserved. If text is too long to fit, the render fails with an error naming the field; it is never clipped.

---

## 2. Local development

Requirements:
- Node 24 or later.
- PostgreSQL 14 or later, *or* the bundled PGlite stand-in (no installation needed).

```bash
cd app
npm install
cp ../.env.example .env            # adjust if you have a real Postgres

# Option A — no Postgres installed: start the PGlite stand-in (keep it running)
npm run db:local                   # postgres://postgres:postgres@127.0.0.1:5433/postgres (use DATABASE_POOL_MAX=1)

npm run migrate:dev
npm run create-admin:dev -- --email you@example.com --name "Your Name"   # prompts for a password
npm run dev                        # http://localhost:3000/admin
```

Local storage (`STORAGE_DRIVER=local`):
- Files are written to `app/.local-storage/`.
- Public files are served at `/local-public/`.
- The app refuses to start with local storage when `NODE_ENV=production`.

To try the storefront endpoints without Shopify, set `DEV_ALLOW_UNSIGNED_PROXY=true` and call `/proxy/api/verify?key=…` directly. This setting is ignored in production.

### Checks

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests (vitest; Postgres via in-process PGlite) |
| `npm run typecheck` / `npm run build` | TypeScript |
| `npm run render:fixtures -- --clean` | Renders every test type with TEST fixtures. Writes completed-vs-generated comparison sheets and overlays to `app/.renders/` |
| `npm run e2e:dashboard` | Playwright walkthrough of the dashboard against a running app, with screenshots (`npx playwright install chromium` first) |
| `npm run theme:harness` | Renders the new theme sections locally with an in-process app behind a signed proxy shim. Desktop and mobile screenshots go to `app/.renders/theme/` |
| `npx @shopify/cli@3 theme check --path theme` | Theme lint. The stock theme has pre-existing offenses; compare against the original export |

---

## 3. Deploying to Render (Blueprint)

`render.yaml` defines:
- **`nga-coa`** — the web service. Root `app/`.
  - Build: `npm ci --include=dev && npm run build && npm prune --omit=dev`
  - Start: `npm run migrate && npm start`
  - Health check: `/healthz`
- **`nga-coa-db`** — managed Postgres 16.

Steps (for an authorized person):

1. Push this repository to GitHub or GitLab.
2. In Render: **New → Blueprint**, select the repository, and review the resources.
3. Fill in the `sync: false` variables (table below).
4. Deploy.
   - `SESSION_SECRET` and `TOKEN_ENC_KEY` are generated by Render. Do not change `TOKEN_ENC_KEY` later, or the stored Shopify token can no longer be decrypted.
5. Optionally add a custom domain such as `coa.nxtgenanalysis.com`, then set `APP_URL` to it.
6. First administrator: either set the `ADMIN_BOOTSTRAP_*` variables for the first deploy (then delete `ADMIN_BOOTSTRAP_PASSWORD`), or open a Render Shell and run `npm run create-admin -- --email … --name …`.

| Variable | Required | Notes |
|---|---|---|
| `APP_URL` | yes | Public URL of the service. Used for the OAuth redirect |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes | R2 API token with Object Read & Write on both buckets |
| `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET` | defaults | `nga-coa-private`, `nga-coa-public` |
| `PUBLIC_ASSET_BASE_URL` | optional | Leave unset: published images are served by the app at `<APP_URL>/coa-assets`. Set only if a custom domain is connected to the public bucket |
| `SHOPIFY_SHOP` | yes | `your-store.myshopify.com` |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | yes | From the Shopify app (client ID and secret). The secret verifies proxy signatures |
| `SHOPIFY_SCOPES` | default | `read_customers` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | optional | Use instead of the OAuth install if you have an Admin API token with `read_customers` |
| `ADMIN_BOOTSTRAP_EMAIL` / `_NAME` / `_PASSWORD` | optional | One-time first administrator |
| `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENC_KEY` | auto | Provided by the Blueprint |

The service is stateless. Every file lives in R2 and every record lives in Postgres, so Render's ephemeral disk is never used for data.

---

## 4. Cloudflare R2

1. Create two buckets: **`nga-coa-private`** and **`nga-coa-public`**.
2. **Private bucket:** leave public access **disabled**. Do not connect a domain or enable `r2.dev`. Staff see private previews through the authenticated dashboard, which streams them.
3. **Public bucket:** keep public access **disabled** too. By default the app streams published images from it at `<APP_URL>/coa-assets/…`, so no domain is needed.
   - *Optional, later:* if a domain on Cloudflare becomes available, connect it under Settings → **Custom Domains** and set `PUBLIC_ASSET_BASE_URL` to it. Keep `r2.dev` disabled.
   - Objects are written with `Content-Type: image/webp` and `Cache-Control: public, max-age=31536000, immutable`. Keys are unique per version, so caches never serve stale data.
   - CORS is only needed with a custom domain (the `/coa-assets` route already allows downloads). Optional CORS policy so the Verify page's **Download** button can save the file directly. Without it, the button opens the image in a new tab.
     ```json
     [{ "AllowedOrigins": ["https://nxtgenanalysis.com", "https://www.nxtgenanalysis.com", "https://YOUR-STORE.myshopify.com"],
        "AllowedMethods": ["GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400 }]
     ```
4. **API token:** R2 → Manage API tokens → *Object Read & Write*, restricted to the two buckets. Put its values in `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and your account ID in `R2_ACCOUNT_ID`.
5. Check the connection: **Dashboard → Integrations** shows whether both buckets are reachable.

Object layout:

| Bucket | Path | Contents |
|---|---|---|
| private | `uploads/<reportId>/<uuid>.<ext>` | Staff uploads |
| private | `reports/<reportId>/v<n>/p<page>-<sha>.webp` | Every rendered version |
| public | `coa/<random>/v<n>-p<page>-<sha>.webp` | Published copies only |

---

## 5. Shopify setup

The theme talks to the app only through an **app proxy**.

1. **Create the app.**
   - In the Shopify **Dev Dashboard** (or Partner Dashboard), create an app owned by the same organization as the store.
   - Distribution: **custom**, installed on the NxtGen store.
   - App URL: `https://<APP_URL>/admin`.
   - Allowed redirection URL: `https://<APP_URL>/shopify/callback`.
   - Access scopes: **`read_customers`** only. Request **protected customer data** access for the customer email field, which Shopify requires for `read_customers`.
2. **Configure the app proxy.**
   - Subpath prefix: **`apps`**. Subpath: **`coa`**.
   - Proxy URL: `https://<APP_URL>/proxy`.
   - The storefront then calls `https://nxtgenanalysis.com/apps/coa/api/verify?key=…`.
3. Put the client ID and secret in `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`, and set `SHOPIFY_SHOP`.
4. As an admin, open **Dashboard → Integrations → Connect to Shopify** to install and store the offline token, which is encrypted at rest.
   - Verify COA works without this step.
   - Test Reports needs it to read the signed-in customer's email.
5. **Customer accounts** must be enabled so customers can sign in for Test Reports. Reports match when the customer's **verified** account email equals the "Customer email for Test Reports access" entered by staff on the report.

No other Shopify integration is used: no webhooks, order access, product writes, billing or notifications.

---

## 6. Theme changes and how to preview them

What changed (see `docs/findings.md` for the reasons):

| Area | Change |
|---|---|
| Verify COA (`templates/page.pdf-upload.json` → `sections/coa-verify.liquid`, `assets/nga-verify.js`) | New lookup by verification key: validation; loading, not-found, rate-limited and error states; report details and certificate images; stable `?key=` link; view, download and copy link. Replaces the old 166 KB section, which contained a hidden COA generator and called an unauthenticated external backend. |
| Test Reports (`templates/page.test-reports.json` → `sections/coa-customer-reports.liquid`, `assets/nga-reports.js`) | A signed-in customer's own published reports: search, test-type filter, pagination, empty and error states, mobile card layout. A signed-out visitor sees a sign-in prompt. |
| Homepage Order Tests (`sections/order-tests.liquid`) | Editable section (collection, heading, intro, price, description, image): an ordered list of tests with "from" prices. Replaces the hard-coded rewrite of the stock collection-links section. |
| Order Tests page (`templates/collection.order-test.json`) | The same section used as the collection page. **Assign it to the `order-test` collection in Shopify admin** (Collection → Theme template → `order-test`). |
| Product order form (`snippets/order-test-form.liquid`, rendered by the existing Custom Liquid block) | Same cart behaviour and line-item properties (Client Name, Sample Name, Lot #, Batch #, Number of Samples, `_unique_id`) and the same native `/cart/add` POST. Adds: live variant price, real labels, required indicators, inline validation summary, sold-out handling, and the `technique_options` minimum-samples rule. |
| FAQ (`sections/faq.liquid`) | Question/answer blocks using accessible `<details>`, readable panels over the optional background image. The 3 existing Q&As were migrated verbatim. |
| Header | Removed the insecure report-search modal, which listed any customer's reports by email from the old backend, and about 2,300 lines of commented-out copies. |
| Removed | `sections/pdf-upload.liquid`, `sections/get-report.liquid`, `templates/page.pdf-upload.liquid`, `templates/page.test-reports.liquid` |

Preview without touching the live theme:

```bash
shopify theme pull --store YOUR-STORE.myshopify.com --path /tmp/live-check   # 1. compare with theme/ in case the editor changed content since 16 Oct 2026
shopify theme push --unpublished --path theme --store YOUR-STORE.myshopify.com  # 2. creates a NEW unpublished theme
# or: shopify theme dev --path theme --store YOUR-STORE.myshopify.com
```

Then, in the preview:
- Assign the `order-test` collection template.
- Confirm the pages `verify` (template `pdf-upload`) and `order-details` (template `test-reports`) still use their templates.
- Check Verify COA with a published key, and Test Reports as a signed-in customer.

Publishing the theme is a separate, deliberate step in Shopify admin.

---

## 7. Staff guide: creating, previewing, publishing and updating a COA

1. Sign in at `https://<APP_URL>/admin`.
2. **New report** → choose the test type.
   - Tick "Test data" only for trials. Test reports are watermarked and never appear on the live storefront.
3. Fill in the form.
   - Required fields are marked `*`.
   - Units shown next to a field (%, mg) are added automatically; type numbers only.
   - Upload the instrument images (chromatogram, peak table, spectrum, bottle photos) as PNG, JPEG or WEBP.
4. Optionally enter the **customer email** under "Staff only". The report will then appear in that customer's Test Reports.
5. **Save & generate preview.** Review every page of the image. If a value doesn't fit, the error names the field to shorten.
6. A **reviewer or admin** selects **Publish**. The verification key printed on the certificate now works on Verify COA.
7. **To correct a published report:** edit, generate a new preview, then publish again. The public page switches to the new version and the old image is withdrawn.
8. **Unpublish** removes a report from public access immediately. **Archive** also makes it read-only. A reason is required for both.

Each template's known defects and ambiguities are listed in the report editor under **Template notes**.

---

## 8. Maintenance

**Migrations**
- Add numbered SQL files in `app/migrations/` (`002_….sql`).
- They run automatically on every deploy (`npm run migrate`, using an advisory lock). Never edit an applied migration.

**Backups**
- Render Postgres paid plans include automated backups and point-in-time recovery. Confirm the retention for your plan.
- Manual backup: `pg_dump "$DATABASE_URL" -Fc -f nga-coa-$(date +%F).dump`
- Restore: `pg_restore -d "$NEW_DATABASE_URL" --clean nga-coa-YYYY-MM-DD.dump`
- R2 objects are write-once (keys are never overwritten). For off-site copies, periodically sync both buckets with `rclone sync` to another bucket or account.

**Changing a template**
1. Replace `app/assets/templates/<slug>/blank-pN.png` at the same size.
2. Re-measure with `npx tsx scripts/measure.ts <image> x0 y0 x1 y1`.
3. Update the definition and **increment its `version`**.
4. Run `npm run render:fixtures -- --clean` and compare the overlays.
5. Regenerate the docs with `npx tsx scripts/gen-mapping-doc.ts`.

Existing published versions keep their original images. New previews use the new definition.

**Marking a template incomplete:** set `status: 'incomplete'` and `incompleteReason` in its definition. Drafts and previews still work; publishing is blocked.

**Rotating secrets**
- Changing `SESSION_SECRET` signs everyone out.
- R2 keys can be rotated freely.
- Changing `SHOPIFY_API_SECRET` requires the same change in the app's Shopify settings.

**Logs:** structured JSON logs in Render. Cookies and authorization headers are redacted.
