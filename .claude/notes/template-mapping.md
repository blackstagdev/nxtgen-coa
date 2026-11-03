# Template mapping notes (for Claude)

- Full generated mapping: `docs/product-template-mapping.md` (regenerate with `cd app && npx tsx scripts/gen-mapping-doc.ts` after changing definitions).
- Template defects & open questions: `docs/findings.md` §5.
- Calibration workflow: measure on BLANK (`app/assets/templates/<slug>/blank-pN.png`) with `npx tsx scripts/measure.ts <img> x0 y0 x1 y1 --gap N` (prints text lines with clusters + baseline estimate), edit the definition, then `npm run render:fixtures -- --clean --only=<slug>` and inspect `app/.renders/<slug>-pN.webp` / `-overlay.png` (red = generated ink over grey example).
- Value x = label right edge + ~10px. Baselines: label bottom row (or measure "base~" estimate). Header text 28px; Endotoxin/Sterility grids 23.5px.
- Verification key inner boxes: large x580–1066 y1800–1847; small x630–923 (y 1903–1930 endotoxin, 1881–1908 pH, 1869–1896 sterility ATP p2).
- Family B report-date cover rect: x1126 y124 w170 h38, redraw at x1129 baseline 148.
- When a layout or field changes, bump the definition `version` so new versions are traceable.
