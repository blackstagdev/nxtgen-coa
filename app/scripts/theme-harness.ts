/**
 * Local visual harness for the NEW theme sections (development QA only).
 *
 * Renders theme/sections/{order-tests,faq,coa-verify,coa-customer-reports}.liquid and
 * snippets/order-test-form.liquid with liquidjs + stubbed Shopify filters, inside a page
 * that loads the theme's real base.css and the new assets. Storefront API calls go to an
 * in-process copy of the COA app through a *signed* app-proxy shim, exactly like Shopify.
 * It then captures desktop and mobile screenshots to app/.renders/theme/.
 *
 * Fixture products/prices below are placeholders for layout only (clearly not real data).
 * This does NOT replace previewing the theme on Shopify (`shopify theme dev`).
 *
 *   npx tsx scripts/theme-harness.ts            # screenshots
 *   npx tsx scripts/theme-harness.ts --serve    # keep the harness running on :4100
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { Liquid, Tag, type Context, type Emitter, type TagToken, type TopLevelToken } from 'liquidjs';
import { chromium } from 'playwright';
import { APP_ROOT } from '../src/config.js';
import { createReport, publish, renderPreview, saveDraft, uploadImage } from '../src/reports/service.js';
import { FIXTURES } from '../test/fixtures/coa-fixtures.js';
import { makeUser, proxyUrl, startTestEnv } from '../test/helpers.js';

const REPO = path.resolve(APP_ROOT, '..');
const THEME = path.join(REPO, 'theme');
const OUT = path.join(APP_ROOT, '.renders', 'theme');
const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- Liquid engine with Shopify-ish stubs ----------
const engine = new Liquid({ root: [path.join(THEME, 'sections'), path.join(THEME, 'snippets')], extname: '.liquid', strictFilters: false });
class IgnoreBlock extends Tag {
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    const name = token.name;
    while (remain.length) {
      const t = remain.shift()!;
      if ((t as TagToken).name === `end${name}`) return;
    }
  }
  *render(_ctx: Context, _emitter: Emitter) {}
}
for (const n of ['schema', 'doc', 'stylesheet', 'javascript']) engine.registerTag(n, IgnoreBlock);
const money = (cents: unknown) => `$${(Number(cents) / 100).toFixed(2)}`;
engine.registerFilter('asset_url', (f: string) => `/theme-assets/${f}`);
engine.registerFilter('stylesheet_tag', (u: string) => `<link rel="stylesheet" href="${u}">`);
engine.registerFilter('money', money);
engine.registerFilter('money_without_trailing_zeros', (c: unknown) => money(c).replace(/\.00$/, ''));
engine.registerFilter('image_url', (img: { src?: string } | string) => (typeof img === 'string' ? img : img?.src ?? ''));
engine.registerFilter('image_tag', (src: string, ...args: unknown[]) => {
  const attrs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (Array.isArray(a)) attrs.push(`${a[0]}="${a[1]}"`);
    else { attrs.push(`${a}="${args[i + 1]}"`); i++; }
  }
  return `<img src="${src}" ${attrs.join(' ')}>`;
});
engine.registerFilter('structured_data', () => '{}');
engine.registerFilter('url_encode', (s: string) => encodeURIComponent(s));

function schemaDefaults(file: string): Record<string, unknown> {
  const src = fs.readFileSync(path.join(THEME, 'sections', file), 'utf8');
  const json = JSON.parse(/\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(src)![1]);
  const out: Record<string, unknown> = {};
  for (const s of json.settings) if ('default' in s) out[s.id] = s.default;
  return out;
}

function themeJson(file: string) {
  const raw = fs.readFileSync(path.join(THEME, 'templates', file), 'utf8');
  return JSON.parse(raw.replace(/^\/\*[\s\S]*?\*\//, ''));
}

// Placeholder products (layout fixtures only)
const svgThumb = (label: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#efe8f6"/><text x="80" y="88" font-size="14" text-anchor="middle" fill="#701379" font-family="sans-serif">${label}</text></svg>`)}`;
const products = [
  ['Sterility Test', 'sterility-testing', 'sterility-atp'],
  ['Endotoxin Test', 'endotoxin-testing', 'endotoxin'],
  ['pH Test (USP <791>)', 'ph-test-usp-791', 'ph-usp-791'],
  ['Purity & Quantity Test', 'purity-quantity-test', 'hplc-purity-quantity'],
  ['Quantity, Purity and Compound Identification Test', 'quantity-purity-and-compound-identification', 'hplc-pq-identification'],
].map(([title, handle, ref], i) => ({
  has_only_default_variant: i === 1,
  variants: i === 1 ? [{ title: 'Default Title' }] : [{ title: 'Vial' }, { title: 'Powder' }],
  title,
  handle,
  url: `/products/${handle}`,
  available: true,
  price: 10000 + i * 2500,
  price_min: 10000 + i * 2500,
  price_varies: i % 2 === 0,
  featured_image: { src: `/ref/${ref}/filled-p1.png` },
  description: '<p>HARNESS FIXTURE description text used only to check the layout of the order list on desktop and mobile.</p>',
}));
const collection = { title: 'Order Tests', handle: 'order-test', description: '<p>HARNESS FIXTURE collection description.</p>', products, products_count: products.length };

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · harness</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@500;700&family=Red+Hat+Text:ital,wght@0,400;0,500;0,700;1,500&display=swap">
<style>
:root{--font-body--family:'Red Hat Text',sans-serif;--font-heading--family:'Red Hat Display',sans-serif;--font-heading--weight:700;--font-subheading--family:'Red Hat Text',sans-serif;
--normal-page-width:1200px;--style-border-radius-inputs:0;--style-border-radius-buttons-primary:0;--style-border-radius-buttons-secondary:36px;}
.color-scheme-1{--color-background:#fff;--color-background-rgb:255 255 255;--color-foreground:#000;--color-foreground-rgb:0 0 0;--color-foreground-heading:#000;
--color-primary-button-background:#000;--color-primary-button-text:#fff;--color-primary-button-hover-background:#383838;--color-secondary-button-background:#fff;--color-secondary-button-text:#000;--color-secondary-button-border:#000;--color-input-background:#fff;--color-input-border:#c9c9c9;--color-input-text:#000;--color-border:#e6e6e6}
body{margin:0;font-family:var(--font-body--family);background:#fff}
.section{position:relative;padding-inline:max(16px,calc((100vw - 1200px)/2))}
.section-background{display:none}
.spacing-style{padding-block:var(--padding-block-start,0) var(--padding-block-end,0)}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 28px;border:0;background:var(--color-primary-button-background);color:var(--color-primary-button-text);font:600 0.85rem/1 var(--font-body--family);text-transform:uppercase;letter-spacing:.08em;text-decoration:none;cursor:pointer}
.button-secondary.button{background:var(--color-secondary-button-background);color:var(--color-secondary-button-text);border:1px solid var(--color-secondary-button-border);border-radius:36px}
.rte p{margin:0 0 .6em}
.harness-bar{background:#c62828;color:#fff;font:600 12px/1 sans-serif;padding:8px 16px;letter-spacing:.06em}
.harness-nav{display:flex;gap:16px;padding:14px max(16px,calc((100vw - 1200px)/2));background:#000;color:#fff;font:600 13px 'Red Hat Text';text-transform:uppercase;letter-spacing:.06em}
.harness-nav a{color:#fff;text-decoration:none}
</style></head><body class="color-scheme-1">
<div class="harness-bar">LOCAL HARNESS — fixture data, not the live store</div>
<nav class="harness-nav"><a href="/home">Home</a><a href="/collections/order-test">Order Tests</a><a href="/pages/verify">Verify COA</a><a href="/pages/order-details">Test Reports</a></nav>
${body}</body></html>`;
}

async function renderSection(file: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const section = { id: file.replace('.liquid', ''), settings: { ...schemaDefaults(file), ...settings }, blocks: (extra.blocks as unknown[]) ?? [] };
  return engine.renderFile(file.replace('.liquid', ''), {
    section,
    collections: { 'order-test': collection },
    routes: { cart_add_url: '/cart/add', account_login_url: '/account/login' },
    request: { design_mode: false, path: '/pages/order-details' },
    page: { title: 'Page' },
    ...extra,
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // ---------- in-process COA app with a published TEST report ----------
  const fake = {
    configured: true,
    async customerEmail(id: string) {
      return id === '111' ? { email: 'client@example.test', verified: true } : null;
    },
    async installationStatus() {
      return { installed: true, via: 'harness' };
    },
  };
  const env = await startTestEnv({}, fake, `${BASE}/public-assets`);
  const admin = await makeUser(env.db, 'admin', 'harness-admin@example.test');
  const deps = { db: env.db, store: env.store };
  const keys: string[] = [];
  for (const slug of ['hplc-purity-quantity', 'endotoxin', 'sterility-visual']) {
    const fx = FIXTURES.find((f) => f.slug === slug)!;
    const r = await createReport(deps, admin, slug, { isTestFixture: true, clientEmail: 'client@example.test' });
    const data: Record<string, unknown> = { ...fx.data };
    for (const [field, crops] of Object.entries(fx.images)) {
      const ids: string[] = [];
      for (const c of crops) {
        const [x0, y0, x1, y1] = c.crop;
        const buf = await sharp(path.join(REPO, c.src)).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
        ids.push((await uploadImage(deps, admin, r.id, field, buf, `${field}.png`, 8e6)).id);
      }
      data[field] = ids;
    }
    await saveDraft(deps, admin, r.id, { data, clientEmail: 'client@example.test' });
    await renderPreview(deps, admin, r.id);
    await publish(deps, admin, r.id);
    keys.push(r.verification_key);
  }

  // ---------- pages ----------
  const idx = themeJson('index.json');
  const homeOrder = idx.sections.order_tests_home.settings;
  const faq = idx.sections.faq_home;
  const faqBlocks = faq.block_order.map((k: string) => ({ ...faq.blocks[k], shopify_attributes: '' }));
  const coll = themeJson('collection.order-test.json').sections.order_tests.settings;
  const verifyS = themeJson('page.pdf-upload.json').sections.verify.settings;
  const reportsS = themeJson('page.test-reports.json').sections.reports.settings;
  const product = {
    id: 1,
    title: 'Endotoxin Test',
    url: '/products/endotoxin-testing',
    description: '<p>HARNESS FIXTURE product description. The real page shows the product description from Shopify admin here, including any lists and paragraphs the lab has written.</p><ul><li>Fixture bullet one</li><li>Fixture bullet two</li></ul>',
    media: ['endotoxin', 'hplc-purity'].map((r) => ({ media_type: 'image', src: `/ref/${r}/filled-p1.png`, alt: 'Sample report' })),
    has_only_default_variant: false,
    selected_or_first_available_variant: { id: 11, price: 15000, available: true },
    metafields: { custom: { technique_options: { value: [{ technique: 'Vial', min_samples_needed: { value: 2 } }] } } },
    variants: [
      { id: 11, title: 'Vial', price: 15000, available: true },
      { id: 12, title: 'Powder', price: 17500, available: true },
      { id: 13, title: 'Solution', price: 17500, available: false },
    ],
  };
  product.selected_or_first_available_variant = product.variants[0] as never;

  const routes: Record<string, () => Promise<string>> = {
    '/home': async () =>
      page('Home', (await renderSection('order-tests.liquid', { ...homeOrder, collection: collection })) +
        (await renderSection('faq.liquid', { ...faq.settings, background_image: '' }, { blocks: faqBlocks }))),
    '/collections/order-test': async () => page('Order Tests', await renderSection('order-tests.liquid', coll, { collection })),
    '/products/endotoxin-testing': async () => {
      const pdp = themeJson('product.json');
      const faqP = pdp.sections.faq_product;
      return page('Product', (await renderSection('lab-test-product.liquid', pdp.sections.main.settings, { product, routes: { cart_add_url: '/cart/add', root_url: '/' } })) +
        (await renderSection('faq.liquid', faqP.settings, { blocks: faqP.block_order.map((k: string) => ({ ...faqP.blocks[k], shopify_attributes: '' })) })));
    },
    '/pages/verify': async () => page('Verify COA', await renderSection('coa-verify.liquid', { ...verifyS, contact_link: '/pages/contact' })),
    '/pages/order-details': async () => page('Test Reports', await renderSection('coa-customer-reports.liquid', reportsS, { customer: { id: 111 } })),
    '/pages/order-details-signed-out': async () => page('Test Reports', await renderSection('coa-customer-reports.liquid', reportsS, { customer: null })),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url!, BASE);
      if (u.pathname.startsWith('/theme-assets/')) {
        const f = path.join(THEME, 'assets', path.basename(u.pathname));
        res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript' });
        return res.end(fs.readFileSync(f));
      }
      if (u.pathname.startsWith('/ref/')) {
        const f = path.join(REPO, 'docs', 'reference', ...u.pathname.slice(5).split('/').map((x) => path.basename(x)));
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(fs.readFileSync(f));
      }
      if (u.pathname.startsWith('/public-assets/')) {
        const obj = env.store.objects.get(`public:${u.pathname.replace('/public-assets/', '')}`);
        if (!obj) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': obj.opts.contentType, 'access-control-allow-origin': '*' });
        return res.end(obj.body);
      }
      if (u.pathname.startsWith('/apps/coa/')) {
        // Shopify app-proxy shim: forwards with a valid signature and the signed-in customer.
        const params = Object.fromEntries(u.searchParams.entries());
        const target = proxyUrl(u.pathname.replace('/apps/coa', '/proxy'), params, u.searchParams.get('_cid') ?? '111');
        const r = await env.app.inject({ method: 'GET', url: target, headers: { 'x-forwarded-for': '198.51.100.7' } });
        res.writeHead(r.statusCode, { 'content-type': 'application/json' });
        return res.end(r.body);
      }
      const handler = routes[u.pathname];
      if (!handler) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await handler());
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
  console.log(`harness on ${BASE} — keys: ${keys.join(', ')}`);
  if (process.argv.includes('--serve')) return;

  const browser = await chromium.launch();
  const shots: [string, string, (p: import('playwright').Page) => Promise<void>][] = [
    ['home', '/home', async () => {}],
    ['order-tests-collection', '/collections/order-test', async () => {}],
    ['product-form', '/products/endotoxin-testing', async () => {}],
    ['product-form-errors', '/products/endotoxin-testing', async (p) => { await p.click('[data-submit]'); await p.waitForSelector('[data-errors]:not([hidden])'); }],
    ['verify-empty', '/pages/verify', async () => {}],
    ['verify-invalid', '/pages/verify', async (p) => { await p.fill('[data-input]', 'abc'); await p.click('[data-submit]'); }],
    ['verify-not-found', '/pages/verify?key=NGA-0000-0000-0000', async (p) => { await p.waitForSelector('.nga-status--warn'); }],
    ['verify-found', `/pages/verify?key=${keys[0]}`, async (p) => { await p.waitForSelector('.nga-page img'); await p.waitForTimeout(500); }],
    ['verify-found-multipage', `/pages/verify?key=${keys[2].toLowerCase()}`, async (p) => { await p.waitForSelector('.nga-page img'); await p.waitForTimeout(500); }],
    ['reports-list', '/pages/order-details', async (p) => { await p.waitForSelector('.nga-table'); }],
    ['reports-no-match', '/pages/order-details?q=zzzz', async (p) => { await p.waitForSelector('.nga-empty'); }],
    ['reports-signed-out', '/pages/order-details-signed-out', async () => {}],
  ];
  const errors: string[] = [];
  for (const [vpName, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: vpName === 'mobile' ? 2 : 1 });
    for (const [name, url, act] of shots) {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await p.goto(BASE + url, { waitUntil: 'networkidle' });
      await act(p);
      await p.waitForTimeout(250);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) errors.push(`${name} (${vpName}): horizontal overflow`);
      await p.screenshot({ path: path.join(OUT, `${name}-${vpName}.png`), fullPage: true });
      await p.close();
    }
    await ctx.close();
  }
  await browser.close();
  server.close();
  await env.close();
  if (errors.length) {
    console.error('ISSUES:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`OK — ${shots.length * 2} screenshots in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
