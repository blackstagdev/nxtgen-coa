import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, ASSETS_DIR } from '../src/config.js';
import { allFields, DEFINITIONS, getDefinition, layoutFieldKeys } from '../src/coa/definitions/index.js';
import { renderDefinition, RenderError } from '../src/coa/render/renderer.js';
import { normalizeData, validateData } from '../src/coa/validate.js';
import { formatDate } from '../src/coa/format.js';
import { FIXTURES } from './fixtures/coa-fixtures.js';

const REPO = path.resolve(APP_ROOT, '..');

async function fixtureData(slug: string) {
  const fx = FIXTURES.find((f) => f.slug === slug)!;
  const uploads = new Map<string, Buffer>();
  const data = { ...fx.data };
  for (const [field, crops] of Object.entries(fx.images)) {
    data[field] = [];
    for (const c of crops) {
      const [x0, y0, x1, y1] = c.crop;
      const buf = await sharp(path.join(REPO, c.src)).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
      const id = crypto.randomUUID();
      uploads.set(id, buf);
      (data[field] as string[]).push(id);
    }
  }
  return { data, uploads };
}

describe('COA definitions', () => {
  it('covers all 8 product folders (sterility split into ATP and visual)', () => {
    const folders = new Set(DEFINITIONS.map((d) => d.source.folder));
    expect(folders.size).toBe(8);
    for (const f of folders) expect(fs.existsSync(path.join(REPO, f))).toBe(true);
  });

  for (const def of DEFINITIONS) {
    describe(def.slug, () => {
      it('references existing source files and normalized blanks at 1414x2000', async () => {
        for (const b of def.source.blanks) expect(fs.existsSync(path.join(REPO, def.source.folder, b))).toBe(true);
        for (const fl of def.source.filled) expect(fs.existsSync(path.join(REPO, def.source.folder, fl))).toBe(true);
        for (const p of def.pages) {
          const meta = await sharp(path.join(ASSETS_DIR, 'templates', def.slug, p.blank)).metadata();
          expect([meta.width, meta.height]).toEqual([1414, 2000]);
        }
      });

      it('maps every form field to the template and every layout field to the form', () => {
        const formKeys = new Set(allFields(def).map((f) => f.key));
        const layoutKeys = layoutFieldKeys(def);
        for (const k of layoutKeys) expect(formKeys, `layout field ${k} missing from form`).toContain(k);
        // Confirmation-only fields are intentionally not printed.
        const unprinted = [...formKeys].filter((k) => !layoutKeys.has(k) && k !== 'no_growth_confirmed');
        expect(unprinted, 'form fields never printed').toEqual([]);
      });

      it('has unique field keys', () => {
        const keys = allFields(def).map((f) => f.key);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('accepts its representative test fixture in strict mode', async () => {
        const { data } = await fixtureData(def.slug);
        expect(validateData(def, data, 'strict')).toEqual([]);
      });

      it('rejects an empty submission in strict mode with required-field errors', () => {
        const errors = validateData(def, {}, 'strict');
        const required = allFields(def).filter((f) => f.required).map((f) => f.key);
        expect(errors.map((e) => e.field)).toEqual(expect.arrayContaining(required));
      });

      it('renders WEBP pages at the template size', async () => {
        const { data, uploads } = await fixtureData(def.slug);
        const pages = await renderDefinition(def, data, {
          verificationKey: 'NGA-TEST-0000-0000',
          loadUpload: async (id) => uploads.get(id) ?? null,
          watermark: 'TEST DATA',
        });
        expect(pages).toHaveLength(def.pages.length);
        for (const p of pages) {
          expect(p.webp.subarray(0, 4).toString('ascii')).toBe('RIFF');
          expect(p.webp.subarray(8, 12).toString('ascii')).toBe('WEBP');
          const meta = await sharp(p.webp).metadata();
          expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1414, 2000]);
        }
      }, 60_000);
    });
  }
});

describe('validation', () => {
  const purity = getDefinition('hplc-purity')!;
  it('keeps numeric precision exactly as typed', () => {
    const d = normalizeData(purity, { purity_percent: ' 99.960 ' });
    expect(d.purity_percent).toBe('99.960');
    expect(validateData(purity, d, 'draft')).toEqual([]);
  });
  it('rejects units typed into decimal fields', () => {
    expect(validateData(purity, { purity_percent: '99.96%' }, 'draft')[0]?.field).toBe('purity_percent');
  });
  it('rejects invalid dates and unknown enum values', () => {
    const ph = getDefinition('ph-usp-791')!;
    const errs = validateData(ph, { report_date: '2025-02-30', status: 'MAYBE' }, 'draft').map((e) => e.field);
    expect(errs).toEqual(expect.arrayContaining(['report_date', 'status']));
  });
  it('preserves scientific symbols in measurement fields', () => {
    const endo = getDefinition('endotoxin')!;
    const d = normalizeData(endo, { endotoxin_value: '<2.17 EU/mg', spike_value: '0.083 EU/mL', start_end_temp: '37.1:37.0 °C ±' });
    expect(validateData(endo, d, 'draft')).toEqual([]);
    expect(d.endotoxin_value).toBe('<2.17 EU/mg');
  });
  it('blocks a non-negative sterility sample result (template prints "no growth")', async () => {
    const def = getDefinition('sterility-atp')!;
    const { data } = await fixtureData('sterility-atp');
    const errs = validateData(def, { ...data, tsb_sample_result: 'Positive' }, 'strict');
    expect(errs.some((e) => e.field === 'tsb_sample_result')).toBe(true);
  });
  it('ignores unknown fields', () => {
    expect(normalizeData(purity, { evil: 'x', purity_percent: '1' })).toEqual({ purity_percent: '1' });
  });
  it('formats dates like the templates', () => {
    expect(formatDate('2025-06-30', 'dmy-short')).toBe('30 Jun 2025');
    expect(formatDate('2025-11-06', 'mdy')).toBe('11/06/2025');
  });
});

describe('renderer safety', () => {
  it('fails with a field-specific error instead of clipping overlong text', async () => {
    const def = getDefinition('hplc-purity')!;
    const { data, uploads } = await fixtureData('hplc-purity');
    await expect(
      renderDefinition(def, { ...data, client: 'An extremely long client name that cannot possibly fit '.repeat(3) }, {
        verificationKey: 'NGA-TEST-0000-0000',
        loadUpload: async (id) => uploads.get(id) ?? null,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof RenderError && e.field === 'client');
  });

  it('wraps long multi-line notes inside the note box', async () => {
    const def = getDefinition('hplc-purity-quantity')!;
    const { data, uploads } = await fixtureData('hplc-purity-quantity');
    const pages = await renderDefinition(def, { ...data, note: 'Word '.repeat(48).trim() }, {
      verificationKey: 'NGA-TEST-0000-0000',
      loadUpload: async (id) => uploads.get(id) ?? null,
    });
    expect(pages).toHaveLength(1);
  });

  it('rejects notes longer than the field limit', () => {
    const def = getDefinition('hplc-purity-quantity')!;
    expect(validateData(def, { note: 'x'.repeat(241) }, 'draft')[0]?.field).toBe('note');
  });

  it('fails clearly when an uploaded image is missing from storage', async () => {
    const def = getDefinition('hplc-purity')!;
    const { data } = await fixtureData('hplc-purity');
    await expect(
      renderDefinition(def, data, { verificationKey: 'NGA-TEST-0000-0000', loadUpload: async () => null }),
    ).rejects.toBeInstanceOf(RenderError);
  });
});
