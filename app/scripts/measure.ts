/**
 * Calibration helper: prints text lines (dark-pixel clusters) inside a region
 * of a template image. Used to measure slot coordinates on the blank templates.
 *
 * usage: tsx scripts/measure.ts <image> [x0 y0 x1 y1] [--thr 140] [--gap 14]
 */
import sharp from 'sharp';

async function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const nums = args.slice(1, 5).filter((a) => /^\d+$/.test(a)).map(Number);
  const thrIdx = args.indexOf('--thr');
  const gapIdx = args.indexOf('--gap');
  const thr = thrIdx > 0 ? Number(args[thrIdx + 1]) : 140;
  const gap = gapIdx > 0 ? Number(args[gapIdx + 1]) : 14;
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [x0, y0, x1, y1] = nums.length === 4 ? nums : [0, 0, info.width, info.height];
  const dark = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum < thr;
  };
  // row profile
  const rows: boolean[] = [];
  for (let y = y0; y < y1; y++) {
    let any = false;
    for (let x = x0; x < x1 && !any; x++) if (dark(x, y)) any = true;
    rows.push(any);
  }
  const lines: [number, number][] = [];
  let start = -1;
  rows.forEach((v, i) => {
    if (v && start < 0) start = i;
    if (!v && start >= 0) { lines.push([y0 + start, y0 + i - 1]); start = -1; }
  });
  if (start >= 0) lines.push([y0 + start, y1 - 1]);
  for (const [ta, tb] of lines) {
    const cols: boolean[] = [];
    for (let x = x0; x < x1; x++) {
      let any = false;
      for (let y = ta; y <= tb && !any; y++) if (dark(x, y)) any = true;
      cols.push(any);
    }
    const clusters: string[] = [];
    let cs = -1; let last = -1;
    cols.forEach((v, i) => {
      if (v) {
        if (cs < 0) cs = i;
        else if (i - last > gap) { clusters.push(`${x0 + cs}-${x0 + last}`); cs = i; }
        last = i;
      }
    });
    if (cs >= 0) clusters.push(`${x0 + cs}-${x0 + last}`);
    // baseline estimate: last row whose dark count >= 30% of the densest row
    const counts: number[] = [];
    for (let y = ta; y <= tb; y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) if (dark(x, y)) n++;
      counts.push(n);
    }
    const max = Math.max(...counts);
    let base = tb;
    for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= max * 0.3) { base = ta + i; break; }
    console.log(`y ${ta}-${tb} (h${tb - ta + 1}) base~${base}: ${clusters.join('  ')}`);
  }
}
main();
