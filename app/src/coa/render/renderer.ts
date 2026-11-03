import crypto from 'node:crypto';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import sharp from 'sharp';
import { ASSETS_DIR } from '../../config.js';
import type { CoaData, CoaDefinition, LayoutOp, ValueStyle } from '../types.js';
import { formatDate } from '../format.js';

export const RENDERER_VERSION = 'r1';

const SERIF = 'Tinos, "DejaVu Serif"';
const SANS = '"DejaVu Sans"';
let fontsReady = false;
export function registerFonts() {
  if (fontsReady) return;
  const dir = path.join(ASSETS_DIR, 'fonts');
  GlobalFonts.registerFromPath(path.join(dir, 'Tinos-Regular.ttf'), 'Tinos');
  GlobalFonts.registerFromPath(path.join(dir, 'Tinos-Bold.ttf'), 'Tinos');
  GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSerif.ttf'), 'DejaVu Serif');
  GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans.ttf'), 'DejaVu Sans');
  GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans-Bold.ttf'), 'DejaVu Sans');
  fontsReady = true;
}

export class RenderError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface RenderedPage {
  pageNo: number;
  webp: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export interface RenderOptions {
  verificationKey: string;
  /** Loads an uploaded image by id (from the private bucket). */
  loadUpload: (id: string) => Promise<Buffer | null>;
  /** Draws a diagonal "TEST DATA" style watermark (fixtures / development). */
  watermark?: string;
  /** Labels for error messages. */
  fieldLabel?: (key: string) => string;
}

const blankCache = new Map<string, Image>();
async function loadBlank(slug: string, file: string): Promise<Image> {
  const p = path.join(ASSETS_DIR, 'templates', slug, file);
  let img = blankCache.get(p);
  if (!img) {
    img = await loadImage(p);
    blankCache.set(p, img);
  }
  return img;
}

function fontString(style: { size: number; bold?: boolean; font?: 'serif' | 'sans' }) {
  return `${style.bold ? 'bold ' : ''}${style.size}px ${style.font === 'sans' ? SANS : SERIF}`;
}

interface Laid {
  size: number;
  lines: string[];
}

/** Breaks a single token that is wider than the available width into chunks. */
function breakToken(ctx: SKRSContext2D, token: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of Array.from(token)) {
    if (cur && ctx.measureText(cur + ch).width > width) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Word-wraps text. firstWidth applies to line 1, restWidth to following lines.
 * Explicit newlines are honoured. Returns null if it does not fit in maxLines.
 */
export function wrapText(
  ctx: SKRSContext2D,
  text: string,
  firstWidth: number,
  restWidth: number,
  maxLines: number,
): string[] | null {
  const lines: string[] = [];
  const paragraphs = text.split(/\r?\n/);
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let cur = '';
    const width = () => (lines.length === 0 ? firstWidth : restWidth);
    for (const w of words) {
      const candidate = cur + w;
      if (ctx.measureText(candidate.trimEnd()).width <= width()) {
        cur = candidate;
        continue;
      }
      if (/^\s+$/.test(w)) {
        // whitespace that overflows: end line here
        lines.push(cur.trimEnd());
        cur = '';
        continue;
      }
      if (cur.trim()) {
        lines.push(cur.trimEnd());
        cur = '';
      } else if (cur === '' && lines.length === 0 && ctx.measureText(w).width > firstWidth && firstWidth < restWidth) {
        // Nothing fits after the label: start the value on the next line.
        lines.push('');
      }
      if (ctx.measureText(w).width > width()) {
        const chunks = breakToken(ctx, w, width());
        for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
        cur = chunks[chunks.length - 1];
      } else cur = w;
      if (lines.length > maxLines) return null;
    }
    lines.push(cur.trimEnd());
    if (lines.length > maxLines) return null;
  }
  return lines;
}

/** Shrinks the font from size to minSize (0.5px steps) until the text fits. */
export function fitText(
  ctx: SKRSContext2D,
  text: string,
  style: ValueStyle,
  firstWidth: number,
  restWidth: number,
): Laid | null {
  const min = style.minSize ?? style.size;
  for (let size = style.size; size >= min - 0.001; size -= 0.5) {
    ctx.font = fontString({ ...style, size });
    const lh = (style.lineHeight ?? style.size * 1.15) * (size / style.size);
    const maxLines = style.maxHeight ? 1 + Math.floor(style.maxHeight / lh) : (style.maxLines ?? 1);
    const lines = wrapText(ctx, text, firstWidth, restWidth, maxLines);
    if (lines) return { size, lines };
  }
  return null;
}

export function displayValue(raw: string, style: ValueStyle): string {
  let v = raw.trim();
  if (style.format) v = formatDate(v, style.format);
  if (style.suffix && v) v = `${v}${style.suffix}`;
  return v;
}

function str(data: CoaData, key: string): string {
  const v = data[key];
  if (Array.isArray(v)) return v.join(', ');
  return (v ?? '').toString();
}

function colorFor(style: ValueStyle, raw: string) {
  return style.colorMap?.[raw.trim()] ?? style.color ?? '#000000';
}

async function decodeUpload(buf: Buffer): Promise<Image> {
  // Normalise orientation/format via sharp; strips metadata.
  const png = await sharp(buf, { limitInputPixels: 60_000_000 }).rotate().png().toBuffer();
  return loadImage(png);
}

export async function renderDefinition(def: CoaDefinition, data: CoaData, opts: RenderOptions): Promise<RenderedPage[]> {
  registerFonts();
  const label = opts.fieldLabel ?? ((k: string) => k);
  const pages: RenderedPage[] = [];
  for (let i = 0; i < def.pages.length; i++) {
    const page = def.pages[i];
    const blank = await loadBlank(def.slug, page.blank);
    const canvas = createCanvas(blank.width, blank.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(blank, 0, 0);
    ctx.textBaseline = 'alphabetic';
    await drawOps(ctx, page.ops, data, opts, label);
    if (opts.watermark) drawWatermark(ctx, opts.watermark, blank.width, blank.height);
    const png = await canvas.encode('png');
    const webp = await sharp(png).webp({ quality: 92, effort: 5, smartSubsample: true }).toBuffer();
    pages.push({
      pageNo: i + 1,
      webp,
      width: blank.width,
      height: blank.height,
      sha256: crypto.createHash('sha256').update(webp).digest('hex'),
    });
  }
  return pages;
}

async function drawOps(
  ctx: SKRSContext2D,
  ops: LayoutOp[],
  data: CoaData,
  opts: RenderOptions,
  label: (k: string) => string,
): Promise<void> {
  for (const op of ops) {
    switch (op.kind) {
      case 'cover':
        ctx.fillStyle = op.color;
        ctx.fillRect(op.x, op.y, op.w, op.h);
        break;
      case 'erase': {
        const ref = ctx.getImageData(op.x, op.refY, op.w, 1);
        const img = ctx.getImageData(op.x, op.y, op.w, op.h);
        for (let yy = 0; yy < op.h; yy++) {
          for (let xx = 0; xx < op.w; xx++) {
            const di = (yy * op.w + xx) * 4;
            const si = xx * 4;
            img.data[di] = ref.data[si];
            img.data[di + 1] = ref.data[si + 1];
            img.data[di + 2] = ref.data[si + 2];
            img.data[di + 3] = 255;
          }
        }
        ctx.putImageData(img, op.x, op.y);
        break;
      }
      case 'static': {
        ctx.font = fontString(op);
        ctx.fillStyle = op.color ?? '#000000';
        ctx.textAlign = op.align ?? 'left';
        ctx.fillText(op.text, op.x, op.y);
        ctx.textAlign = 'left';
        break;
      }
      case 'when':
        if (op.test(data)) await drawOps(ctx, op.ops, data, opts, label);
        break;
      case 'checkmark': {
        const s = op.size;
        ctx.strokeStyle = op.color;
        ctx.lineWidth = s * 0.16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(op.x, op.y - s * 0.45);
        ctx.lineTo(op.x + s * 0.35, op.y - s * 0.08);
        ctx.lineTo(op.x + s, op.y - s * 0.95);
        ctx.stroke();
        break;
      }
      case 'vkey': {
        const { x0, y0, x1, y1 } = op.box;
        const text = opts.verificationKey;
        const style: ValueStyle = { size: op.size, minSize: op.size * 0.6, bold: true, font: 'sans' };
        const laid = fitText(ctx, text, style, x1 - x0 - 16, x1 - x0 - 16);
        if (!laid) throw new RenderError('Verification key does not fit its box');
        ctx.font = fontString({ ...style, size: laid.size });
        ctx.fillStyle = '#1a1a1a';
        ctx.textAlign = 'center';
        const cy = (y0 + y1) / 2 + laid.size * 0.36;
        ctx.fillText(text, (x0 + x1) / 2, cy);
        ctx.textAlign = 'left';
        break;
      }
      case 'image': {
        const raw = data[op.field];
        const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean) as string[];
        const { x0, y0, x1, y1 } = op.box;
        if (op.clear) {
          ctx.fillStyle = op.clear;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        if (!ids.length) break;
        const pad = op.padding ?? 0;
        const gap = op.gap ?? 8;
        const slotW = (x1 - x0 - pad * 2 - gap * (ids.length - 1)) / ids.length;
        const slotH = y1 - y0 - pad * 2;
        for (let k = 0; k < ids.length; k++) {
          const buf = await opts.loadUpload(ids[k]);
          if (!buf) throw new RenderError(`Uploaded image for "${label(op.field)}" is missing from storage`, op.field);
          const img = await decodeUpload(buf);
          const scale = Math.min(slotW / img.width, slotH / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          const sx = x0 + pad + k * (slotW + gap) + (slotW - w) / 2;
          const sy = y0 + pad + (slotH - h) / 2;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, sx, sy, w, h);
        }
        break;
      }
      case 'value': {
        const raw = str(data, op.field);
        if (!raw.trim()) break;
        const text = displayValue(raw, op);
        const contX = op.contX ?? op.x;
        const firstW = op.maxWidth;
        const restW = op.contMaxWidth ?? op.maxWidth;
        const laid = fitText(ctx, text, op, firstW, restW);
        if (!laid) {
          throw new RenderError(`"${label(op.field)}" is too long to fit on the certificate. Shorten the value.`, op.field);
        }
        const lh = (op.lineHeight ?? op.size * 1.15) * (laid.size / op.size);
        let y = op.y;
        if (laid.lines.length > 1 && op.band) {
          const center = op.y; // single-line baseline sits on the band's visual centre
          y = center - ((laid.lines.length - 1) * lh) / 2;
          if (op.relabel) {
            const r = op.relabel;
            ctx.fillStyle = r.bg;
            ctx.fillRect(r.x - 2, op.band.top + 1, r.coverRight - r.x + 2, op.band.bottom - op.band.top - 2);
            ctx.font = fontString({ size: r.size, bold: r.bold });
            ctx.fillStyle = '#000000';
            ctx.fillText(r.text, r.x, y);
          }
        }
        ctx.font = fontString({ ...op, size: laid.size });
        ctx.fillStyle = colorFor(op, raw);
        ctx.textAlign = op.align ?? 'left';
        laid.lines.forEach((line, idx) => {
          if (!line) return;
          ctx.fillText(line, idx === 0 ? op.x : contX, y + idx * lh);
        });
        ctx.textAlign = 'left';
        break;
      }
      case 'cell': {
        const raw = str(data, op.field);
        if (!raw.trim()) break;
        const text = displayValue(raw, op);
        const pad = op.padX ?? 10;
        const { x0, y0, x1, y1 } = op.box;
        const width = x1 - x0 - pad * 2;
        const laid = fitText(ctx, text, op, width, width);
        if (!laid) {
          throw new RenderError(`"${label(op.field)}" is too long to fit in its table cell. Shorten the value.`, op.field);
        }
        const lh = (op.lineHeight ?? op.size * 1.15) * (laid.size / op.size);
        const cap = laid.size * 0.66;
        const blockH = (laid.lines.length - 1) * lh + cap;
        const firstBaseline = (y0 + y1) / 2 - blockH / 2 + cap;
        ctx.font = fontString({ ...op, size: laid.size });
        ctx.fillStyle = colorFor(op, raw);
        const align = op.align ?? 'left';
        ctx.textAlign = align;
        const ax = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 - pad : x0 + pad;
        laid.lines.forEach((line, idx) => ctx.fillText(line, ax, firstBaseline + idx * lh));
        ctx.textAlign = 'left';
        break;
      }
    }
  }
}

function drawWatermark(ctx: SKRSContext2D, text: string, w: number, h: number) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.atan2(h, w));
  ctx.font = `bold 120px ${SANS}`;
  ctx.fillStyle = 'rgba(200, 0, 0, 0.16)';
  ctx.textAlign = 'center';
  ctx.fillText(text, 0, 40);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = 'rgba(200, 0, 0, 0.85)';
  ctx.fillRect(0, 0, w, 34);
  ctx.font = `bold 20px ${SANS}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(`${text} — NOT A REAL CERTIFICATE`, w / 2, 24);
  ctx.restore();
}
