/**
 * Renders every COA type with the TEST fixtures and writes comparison sheets
 * (completed example | generated | overlay) to app/.renders/ for visual review.
 *
 *   npm run render:fixtures            # all types, with TEST DATA watermark on the generated pages
 *   npm run render:fixtures -- --clean # no watermark (for placement comparison only)
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { APP_ROOT } from '../src/config.js';
import { DEFINITIONS } from '../src/coa/definitions/index.js';
import { renderDefinition } from '../src/coa/render/renderer.js';
import { validateData } from '../src/coa/validate.js';
import { FIXTURES } from '../test/fixtures/coa-fixtures.js';

const REPO = path.resolve(APP_ROOT, '..');
const OUT = path.join(APP_ROOT, '.renders');

async function main() {
  const clean = process.argv.includes('--clean');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  await fs.mkdir(OUT, { recursive: true });
  for (const def of DEFINITIONS) {
    if (only && def.slug !== only) continue;
    const fx = FIXTURES.find((x) => x.slug === def.slug);
    if (!fx) {
      console.warn(`no fixture for ${def.slug}`);
      continue;
    }
    const uploads = new Map<string, Buffer>();
    const data = { ...fx.data };
    for (const [field, crops] of Object.entries(fx.images)) {
      const ids: string[] = [];
      for (const c of crops) {
        const [x0, y0, x1, y1] = c.crop;
        const buf = await sharp(path.join(REPO, c.src))
          .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
          .png()
          .toBuffer();
        const id = crypto.randomUUID();
        uploads.set(id, buf);
        ids.push(id);
      }
      data[field] = ids;
    }
    const errors = validateData(def, data, 'strict');
    if (errors.length) console.warn(`[${def.slug}] fixture validation:`, errors);
    const pages = await renderDefinition(def, data, {
      verificationKey: 'NGA-TEST-0000-0000',
      loadUpload: async (id) => uploads.get(id) ?? null,
      watermark: clean ? undefined : 'TEST DATA',
    });
    for (const p of pages) {
      const base = path.join(OUT, `${def.slug}-p${p.pageNo}`);
      await fs.writeFile(`${base}.webp`, p.webp);
      const refPath = path.join(REPO, 'docs', 'reference', def.slug, `filled-p${p.pageNo}.png`);
      const gen = await sharp(p.webp).png().toBuffer();
      const refImg = await sharp(refPath).removeAlpha().png().toBuffer();
      // Overlay: example in light grey, generated dark pixels in red.
      const { data: g, info } = await sharp(gen).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const { data: r } = await sharp(refImg).raw().toBuffer({ resolveWithObject: true });
      const ov = Buffer.alloc(info.width * info.height * 3);
      for (let i = 0; i < info.width * info.height; i++) {
        const lg = (g[i * 3] + g[i * 3 + 1] + g[i * 3 + 2]) / 3;
        const lr = (r[i * 3] + r[i * 3 + 1] + r[i * 3 + 2]) / 3;
        const grey = 255 - (255 - lr) * 0.45;
        if (lg < 120) {
          ov[i * 3] = 230; ov[i * 3 + 1] = 0; ov[i * 3 + 2] = 0;
        } else {
          ov[i * 3] = ov[i * 3 + 1] = ov[i * 3 + 2] = grey;
        }
      }
      await sharp(ov, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toFile(`${base}-overlay.png`);
      const half = (b: Buffer) => sharp(b).resize({ width: 707 }).png().toBuffer();
      await sharp({ create: { width: 707 * 2 + 20, height: 1000, channels: 3, background: '#888' } })
        .composite([
          { input: await half(refImg), left: 0, top: 0 },
          { input: await half(gen), left: 727, top: 0 },
        ])
        .png()
        .toFile(`${base}-compare.png`);
      console.log(`[${def.slug}] page ${p.pageNo}: ${p.width}x${p.height}, ${(p.webp.length / 1024).toFixed(0)} KiB`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
