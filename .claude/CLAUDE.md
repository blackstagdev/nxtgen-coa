# NxtGen Analysis — project memory for Claude

Loaded automatically by Claude Code in this repository. Keep it current when decisions change.
Detailed references live next to this file in `.claude/notes/`.

## What this project is
- Client: **NxtGen Analysis, LLC** (lab testing + Certificates of Analysis for peptide businesses). Live store: https://nxtgenanalysis.com (Shopify, theme "Atelier" 3.1.0, Horizon family).
- Lab director / reviewer: **Dr. Nishal M. Egodawaththa**. Analyst printed on templates: Abdulhakim Tofik.
- Goal: one app where staff enter verified results → preview generated COA (WEBP) → publish → visitors verify on Shopify.

## Repository layout (git root = this folder)
- `theme/` — editable copy of the Shopify theme (source of truth for theme work).
- `theme_export__nxtgenanalysis-com-atelier__16OCT2026-0107pm/` — ORIGINAL export, read-only reference, gitignored. Never edit.
- `Products/` — ORIGINAL template images (blank + filled per test type), read-only reference.
- `app/` — the COA application (Node 24 + TypeScript + Fastify + Postgres + Cloudflare R2).
- `docs/` — mapping, findings, deployment docs; `docs/reference/<slug>/filled-pN.png` = normalized filled examples.
- `render.yaml`, `.env.example`, `README.md` at root.

## Confirmed user decisions (do not re-ask)
- **One application** (dashboard + storefront API share backend/DB).
- **Test Reports page = signed-in customer's own published reports** (matched by *verified* Shopify customer email ↔ report's staff-entered `client_email`; customer id cached on report).
- **Legacy reports: cut over, no fallback.** Theme no longer calls the old backend `trekru2.dreamhosters.com` (it was unauthenticated/insecure).
- Do not push to git remotes, publish the live theme, or deploy without explicit authorization.

## App architecture (app/)
- `src/app.ts` builds Fastify; `src/server.ts` entry. Views: Eta in `app/views`, static in `app/public` (CSP `script-src/style-src 'self'` → **no inline scripts or style attributes in views**).
- Auth: argon2id, DB sessions (signed HttpOnly cookie `nga_sid`), CSRF (`_csrf` field or `X-CSRF-Token`), lockout after 5 failures, DB rate limits (`rate_limits` table, `src/lib/rate-limit.ts`).
- Roles: `admin` (users, everything), `reviewer` (publish/unpublish/archive), `staff` (drafts + previews only).
- Data: `migrations/*.sql` (plain SQL, `src/db/migrate.ts`, advisory lock). Tables: users, sessions, reports, report_versions, report_version_pages, report_uploads, audit_events, shopify_installations, oauth_states, rate_limits.
- Workflow (`src/reports/service.ts`): draft (lenient validation) → preview = strict validation + immutable `report_versions` row (data snapshot + `data_hash`) → publish (reviewer/admin) copies pages to public bucket and sets `published_version_id`. Editing a published report changes draft data only; public stays on the snapshot until republished. Unpublish/archive delete public objects. Old public copies deleted on republish; private versions kept forever.
- Storage (`src/storage/index.ts`): R2 two buckets — private (`uploads/…`, `reports/{id}/v{n}/p{page}-{sha}.webp`) and public (`coa/{random}/v{n}-p{page}-{sha}.webp`, `Cache-Control: public, max-age=31536000, immutable`). nxtgenanalysis.com is NOT on Cloudflare (2026-11-04), so there is no R2 custom domain: the app serves published images at `GET /coa-assets/<key>` (strict key regex, public bucket only); `PUBLIC_ASSET_BASE_URL` optional, defaults to `<APP_URL>/coa-assets`. `LocalStore` dev only (refused in production), `MemoryStore` for tests.
- Storefront: Shopify **app proxy** `/apps/coa/*` → `/proxy/*`, HMAC `signature` verified (`src/shopify/shopify.ts`). Endpoints: `/proxy/api/verify?key=`, `/proxy/api/my-reports`, `/proxy/api/test-types`. Only scope: `read_customers`. Test fixtures (`is_test_fixture`) hidden from proxy when NODE_ENV=production.
- Verification key: `NGA-XXXX-XXXX-XXXX` (Crockford base32, server generated, unique). Printed in the template's Verification Key box.

## COA rendering (app/src/coa)
- 9 definitions in `src/coa/definitions/` (sterility split into ATP + Visual). Each = form sections/fields + page layout ops (value, cell, static, cover, erase, image, vkey, checkmark, when).
- Blanks: `app/assets/templates/<slug>/blank-pN.png`, all **1414×2000**. Coordinates measured on the **blanks** (filled examples are offset 9–42px — not made from the supplied blanks). Measure tool: `npx tsx scripts/measure.ts <img> x0 y0 x1 y1 --gap N`.
- Fonts: Tinos (Times-metric) 28px header text, 23.5px grids (Endotoxin, Sterility); DejaVu Sans Bold for the key. Brand purple on templates `#7d41f5`; PASS green `#00bf63`; FAIL red is an assumption.
- Rules: never calculate/infer results (average quantity etc. are typed). Values stored as exact strings. Overflow → field-specific RenderError, never clipping. Sterility/Visual templates pre-print negative conclusions → non-negative results are blocked.
- `npm run render:fixtures -- --clean` writes compare sheets/overlays to `app/.renders/` for visual QA against `docs/reference`.

## Theme changes (theme/)
- New: `sections/order-tests.liquid`, `faq.liquid`, `coa-verify.liquid`, `coa-customer-reports.liquid`, `snippets/order-test-form.liquid`, `assets/nga-coa.css`, `nga-verify.js`, `nga-reports.js`, `templates/collection.order-test.json`.
- `order-tests` section has `layout`: `list` (homepage) or `catalog` (collection page: per-test rows with price, variant "sample types", Order button, framed sample-report image = product featured image). Collection `order-test` must be assigned template `order-test` in Shopify admin, otherwise the stock product grid shows.
- Product page: `templates/product.json` main = `sections/lab-test-product.liquid` (sample-report gallery, sticky order card, sample-type cards + samples stepper via `order-test-form` with `variant_style: 'cards'`, sample types/pricing table from variants + technique_options metafield, How ordering works, What you receive) + `faq_product` + recommendations.
- Templates: `page.pdf-upload.json` (Verify COA, page handle `verify`), `page.test-reports.json` (Test Reports, page handle `order-details`), `index.json` (uses order-tests + faq), `product.json` custom_liquid now `{% render 'order-test-form', product: product %}` (same line-item property names, native /cart/add, quantity 1).
- Removed: `sections/pdf-upload.liquid` (old generator + email allowlist), `sections/get-report.liquid`, old `.liquid` page templates, header report-search modal + ~2,300 lines of commented header copies.
- Store nav: Order Tests `/collections/order-test`, Verify COA `/pages/verify`, Test Reports `/pages/order-details`.
- Brand: Red Hat Display/Text, purple `#701379`, blue `#4281ff`, navy `#2351a4`, square corners, pill secondary buttons, uppercase buttons.
- Don't invent credentials, turnaround times, prices, or policies; preserve existing copy.

## Commands
- Tests: `cd app && npm test` (vitest; Postgres via in-process PGlite). Typecheck: `npm run typecheck`.
- Local dev without Postgres: `npm run db:local` (PGlite on 5433, use `DATABASE_POOL_MAX=1`), then `npm run migrate:dev`, `npm run create-admin:dev`, `npm run dev`.
- Browser walkthrough: `npx tsx scripts/e2e-dashboard.ts` (needs running app; screenshots in `app/.renders/screens`).
- Theme lint: `npx @shopify/cli@3 theme check --path theme` (pre-existing stock offenses exist; compare against the original export).
- Template values check (run before every upload): `node app/scripts/validate-theme-templates.mjs`. Lesson: one invalid value (range not on step, empty richtext) makes Shopify drop the whole template — the homepage then showed "Page not found" (fixed 2026-11-03).
- Upload zip: build with files at the zip ROOT (layout/, templates/ …), forward-slash paths — `nga-theme.zip` at repo root (gitignored). Preferred: `shopify theme push --unpublished --path theme`.

## Status (as of 2026-11-03)
- Implemented and verified locally: app (100 vitest tests passing, typecheck/build OK), all 9 templates rendered & visually checked, dashboard Playwright walkthrough, theme section harness (desktop+mobile, no overflow), theme check shows no new offenses.
- Git: `main` pushed to https://github.com/blackstagdev/nxtgen-coa (first commit 44cc26b, 2026-11-04). Push again only when the user asks.
- NOT verified (need credentials/services): real Cloudflare R2, Render deploy, Shopify app proxy signatures from real Shopify, OAuth install / customer email lookup, live theme rendering on Shopify.
- Theme: user uploaded `nga-theme.zip` as an unpublished theme and approved the design (2026-11-03). Not yet published live.
- Next: Cloudflare R2 buckets + token (no custom domain) → Render Blueprint → Shopify app + proxy → first real COA.
- Pending from client: verification-key format confirmation, template defect fixes (see docs/findings.md §5), assign `order-test` collection template in Shopify admin.

## Known template defects (flag, don't silently fix)
See `.claude/notes/template-mapping.md` and `docs/product-template-mapping.md`.
