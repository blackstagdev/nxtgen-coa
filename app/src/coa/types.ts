/**
 * COA test-type definitions: form fields (what staff enter) and page layouts
 * (where each value is drawn on the blank template). Coordinates are pixels on
 * the 1414x2000 blank templates in assets/templates/<slug>/.
 */

export type FieldType = 'text' | 'multiline' | 'email' | 'date' | 'decimal' | 'integer' | 'enum' | 'image';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Unit drawn after the value on the COA (e.g. "%" or "mg"). Shown in the form as an adornment. */
  unit?: string;
  maxLength?: number;
  pattern?: RegExp;
  patternHint?: string;
  options?: string[];
  help?: string;
  placeholder?: string;
  /** image fields: maximum number of images (side-by-side in the slot). */
  maxImages?: number;
  minImages?: number;
  /** Grid hint for the dashboard form (columns this field spans out of 12). */
  span?: 3 | 4 | 6 | 12;
}

export interface FormSection {
  title: string;
  description?: string;
  fields: FieldDef[];
}

export type DateFormat = 'dmy-short' | 'mdy';

export interface ValueStyle {
  size: number;
  minSize?: number;
  bold?: boolean;
  color?: string;
  /** Map of field value -> colour (e.g. PASS green). */
  colorMap?: Record<string, string>;
  align?: 'left' | 'center' | 'right';
  maxLines?: number;
  /** Vertical space (px) available below the first baseline; when set, smaller sizes may use more lines. */
  maxHeight?: number;
  lineHeight?: number;
  format?: DateFormat;
  suffix?: string;
  font?: 'serif' | 'sans';
}

/** Value drawn at a baseline position (typically right after a pre-printed label). */
export interface ValueOp extends ValueStyle {
  kind: 'value';
  field: string;
  x: number;
  y: number;
  maxWidth: number;
  /** x for wrapped continuation lines (defaults to x). */
  contX?: number;
  contMaxWidth?: number;
  /** Vertical band used to centre multi-line blocks. */
  band?: { top: number; bottom: number };
  /** Re-draw the pre-printed label on the first line when the value wraps. */
  relabel?: { text: string; x: number; size: number; bold?: boolean; bg: string; coverRight: number };
}

/** Value drawn inside a table cell, vertically centred. */
export interface CellOp extends ValueStyle {
  kind: 'cell';
  field: string;
  box: { x0: number; y0: number; x1: number; y1: number };
  padX?: number;
}

export interface StaticTextOp {
  kind: 'static';
  text: string;
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right';
  font?: 'serif' | 'sans';
}

export interface CoverOp {
  kind: 'cover';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/**
 * Removes pre-printed text by refilling every pixel column of the rectangle with
 * the colour found at row `refY` of that column (keeps the light watermark intact).
 */
export interface EraseOp {
  kind: 'erase';
  x: number;
  y: number;
  w: number;
  h: number;
  refY: number;
}

export interface ImageOp {
  kind: 'image';
  field: string;
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Fill the box with this colour first (hides template placeholder art). */
  clear?: string;
  gap?: number;
  padding?: number;
}

export interface VerificationKeyOp {
  kind: 'vkey';
  box: { x0: number; y0: number; x1: number; y1: number };
  size: number;
}

export interface CheckmarkOp {
  kind: 'checkmark';
  x: number;
  y: number;
  size: number;
  color: string;
}

export interface WhenOp {
  kind: 'when';
  test: (data: CoaData) => boolean;
  /** Fields the condition reads (for mapping checks and documentation). */
  uses?: string[];
  ops: LayoutOp[];
}

export type LayoutOp = ValueOp | CellOp | StaticTextOp | CoverOp | EraseOp | ImageOp | VerificationKeyOp | CheckmarkOp | WhenOp;

export interface PageLayout {
  /** File name inside assets/templates/<slug>/ */
  blank: string;
  ops: LayoutOp[];
}

export type CoaData = Record<string, string | string[] | undefined>;

export interface RuleIssue {
  field?: string;
  message: string;
}

export interface CoaDefinition {
  slug: string;
  name: string;
  /** Increment when fields or layout change; stored with each version for traceability. */
  version: number;
  status: 'complete' | 'incomplete';
  incompleteReason?: string;
  source: { folder: string; blanks: string[]; filled: string[] };
  sections: FormSection[];
  pages: PageLayout[];
  /** Field whose value is also stored as the unique report number. */
  reportNumberField?: string;
  /** Field keys used for the public summary. */
  summary: { sampleName: string; lot?: string; reportDate: string; client?: string };
  /** Cross-field checks that must pass before publishing. */
  rules?: (data: CoaData) => RuleIssue[];
  /** Ambiguities / template defects surfaced to staff in the dashboard. */
  notes: string[];
}
