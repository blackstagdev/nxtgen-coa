import type { DateFormat } from './types.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseIsoDate(v: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Formats an ISO date (YYYY-MM-DD) the way the templates print it. */
export function formatDate(v: string, fmt: DateFormat): string {
  const p = parseIsoDate(v);
  if (!p) return v;
  if (fmt === 'mdy') return `${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}/${p.y}`;
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}
