/**
 * Browser walkthrough of the staff dashboard against a locally running app
 * (development only). Signs in, creates a TEST report, uploads images, generates
 * a preview, publishes, then checks the storefront API and captures screenshots
 * at desktop and mobile widths into app/.renders/screens/.
 *
 *   APP_URL=http://localhost:3000 ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/e2e-dashboard.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type Page } from 'playwright';
import { APP_ROOT } from '../src/config.js';
import { FIXTURES } from '../test/fixtures/coa-fixtures.js';

const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@nga.local';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Dev-admin-password-123';
const OUT = path.join(APP_ROOT, '.renders', 'screens');
const REPO = path.resolve(APP_ROOT, '..');

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log('  screenshot', name);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const tmp = path.join(APP_ROOT, '.renders', 'uploads');
  await fs.mkdir(tmp, { recursive: true });
  const fx = FIXTURES.find((f) => f.slug === 'hplc-purity-quantity')!;
  const files: Record<string, string> = {};
  for (const [field, crops] of Object.entries(fx.images)) {
    const [x0, y0, x1, y1] = crops[0].crop;
    const p = path.join(tmp, `${field}.png`);
    await sharp(path.join(REPO, crops[0].src)).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toFile(p);
    files[field] = p;
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));

  console.log('login');
  await page.goto(`${BASE}/admin/login`);
  await shot(page, 'login-desktop');
  await page.fill('#email', EMAIL);
  await page.fill('#password', 'wrong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('.alert--error');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/reports');
  await shot(page, 'reports-empty-desktop');

  console.log('create report');
  await page.goto(`${BASE}/admin/reports/new`);
  await page.check('#t-hplc-purity-quantity');
  await page.check('input[name=test_fixture]');
  await shot(page, 'new-report-desktop');
  await page.click('button:has-text("Create draft")');
  await page.waitForURL(/\/admin\/reports\/[0-9a-f-]{36}$/);

  console.log('preview with missing fields (expect error summary)');
  await page.click('button[value=preview]');
  await page.waitForSelector('.alert--error');
  await shot(page, 'editor-validation-desktop');

  console.log('fill form');
  for (const [k, v] of Object.entries(fx.data)) {
    const sel = `[name="f[${k}]"]`;
    if (await page.locator(sel).count()) await page.fill(sel, String(v));
  }
  await page.fill('#f-_client_email', 'client@example.test');
  for (const [field, file] of Object.entries(files)) {
    await page.setInputFiles(`#f-${field}`, file);
    await page.waitForSelector(`[data-field-key="${field}"] [data-item]`);
  }
  await page.click('button[value=preview]');
  await page.waitForURL(/#preview$/);
  await page.waitForSelector('.preview-pages img');
  await shot(page, 'editor-preview-desktop');

  console.log('publish');
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("Publish v")');
  await page.waitForSelector('.alert--success');
  await shot(page, 'editor-published-desktop');
  const key = (await page.locator('.vkey').first().textContent())!.trim();

  console.log('storefront API for', key);
  const api = await page.request.get(`${BASE}/proxy/api/verify?key=${encodeURIComponent(key)}`);
  const body = await api.json();
  if (api.status() !== 200 || body.report.verificationKey !== key) throw new Error(`verify failed: ${api.status()} ${JSON.stringify(body)}`);
  const img = await page.request.get(body.report.pages[0].url);
  console.log('  public image', img.status(), img.headers()['content-type'], img.headers()['cache-control']);
  if (JSON.stringify(body).includes('client@example.test')) throw new Error('private email leaked');

  await page.goto(`${BASE}/admin/reports`);
  await shot(page, 'reports-list-desktop');

  console.log('mobile');
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/admin/reports`);
  await shot(mp, 'reports-list-mobile');
  await mp.goto(page.url().replace(/\/admin\/reports$/, '/admin/reports'));
  const first = mp.locator('.row-link').first();
  await first.click();
  await shot(mp, 'editor-mobile');
  await mp.goto(`${BASE}/admin/users`);
  await shot(mp, 'users-mobile');
  await mp.goto(`${BASE}/admin/settings`);
  await shot(mp, 'settings-mobile');

  await browser.close();
  console.log('OK — dashboard walkthrough passed; verification key', key);
  await fs.writeFile(path.join(OUT, 'last-key.txt'), key);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
