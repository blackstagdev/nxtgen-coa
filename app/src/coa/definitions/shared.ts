import type { FieldDef, LayoutOp, ValueOp } from '../types.js';

export const BRAND_PURPLE = '#7d41f5';
export const PASS_GREEN = '#00bf63';
/** Not present in any example (only PASS is shown); chosen as a conventional fail colour. */
export const FAIL_RED = '#c62828';
export const CHECK_GREY = '#546d7a';
export const LAVENDER = '#e1d2ff';

// ---- Field factories ---------------------------------------------------------

const TEXT_SAFE = /^[^<>{}\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;

export const f = {
  text(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'text', maxLength: 120, pattern: TEXT_SAFE, ...extra };
  },
  /** Free text where symbols such as < > are legitimate (e.g. "<2.17 EU/mg"). */
  measure(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'text', maxLength: 60, ...extra };
  },
  multiline(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'multiline', maxLength: 600, span: 12, ...extra };
  },
  decimal(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'decimal', maxLength: 20, ...extra };
  },
  integer(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'integer', maxLength: 12, ...extra };
  },
  date(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'date', ...extra };
  },
  email(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'email', maxLength: 120, ...extra };
  },
  enumOf(key: string, label: string, options: string[], extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'enum', options, ...extra };
  },
  image(key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef {
    return { key, label, type: 'image', maxImages: 1, span: 6, ...extra };
  },
};

export const reportDateField = () =>
  f.date('report_date', 'Report date', { required: true, help: 'Printed in the page header as e.g. "30 Jun 2025".' });

// ---- Layout helpers ------------------------------------------------------------

/** Report date in the header (Family A blanks have an empty "Report Date:" label). */
export const reportDateOpsA = (): LayoutOp[] => [
  { kind: 'value', field: 'report_date', x: 1129, y: 148, size: 28, minSize: 22, maxWidth: 1300 - 1129, format: 'dmy-short' },
];

/**
 * Family B blanks have "30 Jun 2025" pre-printed after "Report Date:". It is
 * covered and the entered report date is drawn instead.
 */
export const reportDateOpsB = (): LayoutOp[] => [
  { kind: 'cover', x: 1126, y: 124, w: 170, h: 38, color: '#ffffff' },
  { kind: 'value', field: 'report_date', x: 1129, y: 148, size: 28, minSize: 22, maxWidth: 1300 - 1129, format: 'dmy-short' },
];

export const VKEY_LARGE = { x0: 580, y0: 1800, x1: 1066, y1: 1847 };

export function v(field: string, x: number, y: number, maxWidth: number, extra: Partial<ValueOp> = {}): ValueOp {
  return { kind: 'value', field, x, y, maxWidth, size: 28, minSize: 20, ...extra };
}
