import { allFields } from './definitions/index.js';
import { parseIsoDate } from './format.js';
import type { CoaData, CoaDefinition, FieldDef } from './types.js';

export type ValidationMode = 'draft' | 'strict';

export interface FieldError {
  field: string;
  message: string;
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters other than tab/newline are never accepted.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Normalises raw form input into CoaData containing only known fields.
 * Strings are trimmed (multiline keeps inner newlines); empty strings are dropped.
 */
export function normalizeData(def: CoaDefinition, input: Record<string, unknown>): CoaData {
  const out: CoaData = {};
  for (const field of allFields(def)) {
    const raw = input[field.key];
    if (field.type === 'image') {
      const arr = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw])
        .map((x) => String(x).trim())
        .filter(Boolean);
      if (arr.length) out[field.key] = arr;
      continue;
    }
    if (raw === undefined || raw === null) continue;
    let s = Array.isArray(raw) ? String(raw[raw.length - 1] ?? '') : String(raw);
    s = field.type === 'multiline' ? s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim() : s.replace(/\s+/g, ' ').trim();
    if (s) out[field.key] = s;
  }
  return out;
}

function checkField(field: FieldDef, value: string | string[] | undefined, mode: ValidationMode): string | null {
  const empty = value === undefined || (Array.isArray(value) ? value.length === 0 : value === '');
  if (empty) return mode === 'strict' && field.required ? 'This field is required.' : null;
  if (field.type === 'image') {
    const arr = Array.isArray(value) ? value : [value as string];
    if (arr.some((id) => !UUID.test(id))) return 'Invalid image reference.';
    const max = field.maxImages ?? 1;
    if (arr.length > max) return `At most ${max} image${max > 1 ? 's' : ''} allowed.`;
    if (mode === 'strict' && field.minImages && arr.length < field.minImages) return `At least ${field.minImages} image(s) required.`;
    return null;
  }
  const s = Array.isArray(value) ? value.join(' ') : (value as string);
  if (CONTROL.test(s)) return 'Contains unsupported control characters.';
  const max = field.maxLength ?? (field.type === 'multiline' ? 600 : 120);
  if (Array.from(s).length > max) return `Must be ${max} characters or fewer.`;
  switch (field.type) {
    case 'decimal':
      if (!DECIMAL.test(s)) return 'Enter a number (digits with an optional decimal point, e.g. 99.96).';
      break;
    case 'integer':
      if (!INTEGER.test(s)) return 'Enter a whole number.';
      break;
    case 'date':
      if (!parseIsoDate(s)) return 'Enter a valid date.';
      break;
    case 'email':
      if (!EMAIL.test(s)) return 'Enter a valid email address.';
      break;
    case 'enum':
      if (!field.options?.includes(s)) return `Choose one of: ${field.options?.join(', ')}.`;
      break;
  }
  if (field.pattern && !field.pattern.test(s)) return field.patternHint ?? 'Contains characters that are not allowed.';
  return null;
}

export function validateData(def: CoaDefinition, data: CoaData, mode: ValidationMode): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of allFields(def)) {
    const msg = checkField(field, data[field.key], mode);
    if (msg) errors.push({ field: field.key, message: msg });
  }
  if (mode === 'strict' && def.rules) {
    for (const issue of def.rules(data)) errors.push({ field: issue.field ?? '_form', message: issue.message });
  }
  return errors;
}

export function imageIds(def: CoaDefinition, data: CoaData): { field: string; id: string }[] {
  const out: { field: string; id: string }[] = [];
  for (const field of allFields(def)) {
    if (field.type !== 'image') continue;
    const v = data[field.key];
    for (const id of Array.isArray(v) ? v : v ? [v] : []) out.push({ field: field.key, id });
  }
  return out;
}
