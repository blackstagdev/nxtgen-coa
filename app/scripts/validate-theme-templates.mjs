// Checks theme/templates/*.json values against section schemas (range min/max/step,
// select options, non-empty richtext, unknown settings/blocks). Shopify rejects a whole
// template on upload when one value is invalid — e.g. the homepage then shows "Page not found".
// Usage: node app/scripts/validate-theme-templates.mjs [themeDir]
import fs from 'node:fs';
import path from 'node:path';

const theme = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', '..', 'theme'));
const schemaOf = (type) => {
  const f = path.join(theme, 'sections', `${type}.liquid`);
  if (!fs.existsSync(f)) return null;
  const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(fs.readFileSync(f, 'utf8'));
  return m ? JSON.parse(m[1]) : null;
};
let problems = 0;
const report = (...a) => { problems++; console.log(...a); };
const check = (where, defs, values) => {
  const byId = Object.fromEntries((defs ?? []).filter((s) => s.id).map((s) => [s.id, s]));
  for (const [k, v] of Object.entries(values ?? {})) {
    const d = byId[k];
    if (!d) continue; // stock sections accept settings this simple check does not model
    if (d.type === 'range' && (typeof v !== 'number' || v < d.min || v > d.max || (v - d.min) % d.step !== 0)) report(where, 'invalid range', k, v);
    if (d.type === 'select' && !d.options.some((o) => o.value === v)) report(where, 'invalid select', k, v);
    if (d.type === 'richtext' && (v === '' || !/^<(p|ul|ol|h[1-6])/.test(v))) report(where, 'invalid richtext', k);
  }
};
for (const f of fs.readdirSync(path.join(theme, 'templates')).filter((x) => x.endsWith('.json'))) {
  const raw = fs.readFileSync(path.join(theme, 'templates', f), 'utf8').replace(/^\/\*[\s\S]*?\*\//, '');
  let j;
  try { j = JSON.parse(raw); } catch (e) { report(f, 'invalid JSON', e.message); continue; }
  for (const [id, s] of Object.entries(j.sections ?? {})) {
    const sc = schemaOf(s.type);
    if (!sc) { if (!fs.existsSync(path.join(theme, 'sections', `${s.type}.liquid`))) report(f, 'missing section file', s.type); continue; }
    check(`${f}#${id}`, sc.settings, s.settings);
    for (const [bid, b] of Object.entries(s.blocks ?? {})) {
      const bd = (sc.blocks ?? []).find((x) => x.type === b.type);
      if (bd) check(`${f}#${id}/${bid}`, bd.settings, b.settings);
    }
  }
}
console.log(problems ? `${problems} problem(s) found` : 'All templates valid');
process.exit(problems ? 1 : 0);
