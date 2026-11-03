import type { CellOp, CoaData, CoaDefinition, FieldDef, LayoutOp, RuleIssue } from '../types.js';
import { f, reportDateField, reportDateOpsB } from './shared.js';

const S = 23.5; // header/grid font size measured on the sterility blanks

/** Shared client/sample header fields (pH and sterility templates). */
export function clientHeaderFields(): FieldDef[] {
  return [
    f.text('client_name', 'Client name', { required: true, span: 6 }),
    f.email('client_email', 'Client email', { required: true, span: 6, help: 'Printed on the certificate.' }),
    f.text('sample_name', 'Sample name', { required: true, span: 6 }),
    f.text('lot_number', 'Lot #', { required: true, span: 6, maxLength: 60 }),
    f.date('received_date', 'Test article received', { required: true, span: 6 }),
    f.integer('articles_tested', 'No. of articles tested', { required: true, span: 6 }),
    f.date('test_start_date', 'Test start date', { required: true, span: 6 }),
    f.date('test_end_date', 'Test end date', { required: true, span: 6 }),
  ];
}

interface HeaderPos {
  left: [number, number][]; // [valueX, baseline] for client_name, client_email, sample_name, lot_number
  right: [number, number][]; // received, articles, start, end
}

const STERILITY_HEADER: HeaderPos = {
  left: [[284, 425], [285, 458], [298, 490], [210, 523]],
  right: [[919, 425], [923, 458], [861, 490], [850, 523]],
};

function headerOps(pos: HeaderPos): LayoutOp[] {
  const L = ['client_name', 'client_email', 'sample_name', 'lot_number'];
  const R = ['received_date', 'articles_tested', 'test_start_date', 'test_end_date'];
  const ops: LayoutOp[] = [];
  pos.left.forEach(([x, y], i) =>
    ops.push({ kind: 'value', field: L[i], x, y, maxWidth: 692 - x, size: S, minSize: 16 }),
  );
  pos.right.forEach(([x, y], i) =>
    ops.push({
      kind: 'value',
      field: R[i],
      x,
      y,
      maxWidth: 1290 - x,
      size: S,
      minSize: 16,
      format: R[i] === 'articles_tested' ? undefined : 'mdy',
    }),
  );
  return ops;
}

// ---- ATP (Celsis) blocks ------------------------------------------------------

const BLOCK_FIELDS = [
  ['sample_id', 'Sample ID'],
  ['comments', 'Comments'],
  ['pos_cutoff', 'Positive cut-off'],
  ['neg_cutoff', 'Negative cut-off'],
  ['rlu', 'RLU'],
  ['bkgnd', 'Bkgnd'],
  ['cv', 'CV%'],
  ['notification', 'Notification'],
  ['result', 'Result'],
  ['chainpos', 'ChainPos'],
  ['rlu1', 'RLU1'],
  ['rlu2', 'RLU2'],
] as const;

interface BlockSpec {
  prefix: string;
  title: string;
  isSample: boolean;
}

const BLOCKS: BlockSpec[] = [
  { prefix: 'tsb_ctrl', title: 'TSB media – control', isSample: false },
  { prefix: 'tsb_sample', title: 'TSB media – sample', isSample: true },
  { prefix: 'ftm_ctrl', title: 'FTM media – control', isSample: false },
  { prefix: 'ftm_sample', title: 'FTM media – sample', isSample: true },
];

function blockFields(b: BlockSpec): FieldDef[] {
  return BLOCK_FIELDS.map(([k, label]) => {
    const key = `${b.prefix}_${k}`;
    if (k === 'result' && b.isSample) {
      return f.enumOf(key, label, ['Negative', 'Positive'], {
        required: true,
        span: 4,
        help: 'The template prints this on a green cell and its conclusion states no growth was detected.',
      });
    }
    if (k === 'sample_id') return f.measure(key, label, { required: true, span: 6, maxLength: 80 });
    if (k === 'comments') return f.measure(key, label, { span: 6, maxLength: 100 });
    if (k === 'result') return f.measure(key, label, { required: true, span: 4, help: 'e.g. the instrument result for the control.' });
    return f.measure(key, label, { span: 4, maxLength: 20 });
  });
}

function blockOps(prefix: string, c: number[], r: number[], missing: { neg: boolean; bkgnd: boolean }): LayoutOp[] {
  const cell = (k: string, ci0: number, ci1: number, ri: number): CellOp => ({
    kind: 'cell',
    field: `${prefix}_${k}`,
    box: { x0: c[ci0], x1: c[ci1], y0: r[ri], y1: r[ri + 1] },
    size: S,
    minSize: 15,
    padX: 10,
  });
  const ops: LayoutOp[] = [];
  // Labels missing from the supplied blank are drawn in the same style as their siblings.
  if (missing.neg) {
    ops.push({ kind: 'static', text: 'Negative', x: c[2] + 11, y: r[2] + 37, size: S, bold: true });
    ops.push({ kind: 'static', text: 'Cut-off:', x: c[2] + 11, y: r[2] + 69, size: S, bold: true });
  }
  if (missing.bkgnd) ops.push({ kind: 'static', text: 'Bkgnd', x: c[6] + 11, y: r[2] + 53, size: S, bold: true });
  ops.push(
    cell('sample_id', 1, 8, 0),
    cell('comments', 1, 8, 1),
    cell('pos_cutoff', 1, 2, 2),
    cell('neg_cutoff', 3, 4, 2),
    cell('rlu', 5, 6, 2),
    cell('bkgnd', 7, 8, 2),
    cell('cv', 1, 2, 3),
    cell('notification', 3, 4, 3),
    cell('result', 5, 8, 3),
    cell('chainpos', 1, 2, 4),
    cell('rlu1', 3, 4, 4),
    cell('rlu2', 5, 8, 4),
  );
  return ops;
}

const COLS_P1 = [146, 286, 427, 568, 709, 850, 991, 1132, 1272];
const COLS_P2 = [130, 272, 415, 558, 701, 843, 986, 1129, 1272];

const negativeOnly = (keys: string[]) => (d: CoaData): RuleIssue[] =>
  keys
    .filter((k) => d[k] && d[k] !== 'Negative')
    .map((k) => ({
      field: k,
      message:
        'This template pre-prints a green result cell and a conclusion stating no microbial growth. A non-negative result cannot be published on it — contact the lab director for a suitable template.',
    }));

export const sterilityAtp: CoaDefinition = {
  slug: 'sterility-atp',
  name: 'Sterility Test (ATP / Celsis, USP <73>)',
  version: 1,
  status: 'complete',
  source: {
    folder: 'Products/Sterility Test',
    blanks: ['blank-pg 1.png', 'blank-pg 2.png'],
    filled: ['Filled-pg 1.png', 'Filled-pg 2.png'],
  },
  sections: [
    { title: 'Client and sample', fields: [...clientHeaderFields(), reportDateField()] },
    ...BLOCKS.map((b) => ({ title: b.title, fields: blockFields(b) })),
  ],
  pages: [
    {
      blank: 'blank-p1.png',
      ops: [
        ...reportDateOpsB(),
        ...headerOps(STERILITY_HEADER),
        ...blockOps('tsb_ctrl', COLS_P1, [848, 905, 962, 1052, 1109, 1166], { neg: true, bkgnd: true }),
        ...blockOps('tsb_sample', COLS_P1, [1192, 1248, 1305, 1394, 1451, 1508], { neg: false, bkgnd: false }),
      ],
    },
    {
      blank: 'blank-p2.png',
      ops: [
        ...reportDateOpsB(),
        ...blockOps('ftm_ctrl', COLS_P2, [518, 575, 632, 721, 778, 835], { neg: false, bkgnd: true }),
        ...blockOps('ftm_sample', COLS_P2, [866, 922, 979, 1069, 1126, 1183], { neg: false, bkgnd: false }),
        { kind: 'vkey', box: { x0: 630, y0: 1869, x1: 923, y1: 1896 }, size: 20 },
      ],
    },
  ],
  rules: negativeOnly(['tsb_sample_result', 'ftm_sample_result']),
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client_name' },
  notes: [
    'Page 1, control block: the blank is missing the "Negative Cut-off:" and "Bkgnd" labels; the renderer draws them.',
    'Page 2, control block: the blank is missing the "Bkgnd" label; the renderer draws it.',
    'The FTM conclusion on page 2 says "20–25 °C" although the procedure states FTM at 30–35 °C — template defect, not changed.',
    'Sample result cells are pre-printed green and the conclusions state no growth, so only "Negative" sample results can be published.',
    'The blank has "Report Date: 30 Jun 2025" pre-printed on each page; it is covered and replaced with the entered report date.',
    'The client email is printed on the certificate, so it is visible to anyone who can open the published COA.',
  ],
};

// ---- Visual sterility (USP <71>) ------------------------------------------------

const VISUAL_HEADER: HeaderPos = {
  left: [[284, 425], [285, 458], [298, 490], [210, 523]],
  right: [[919, 425], [928, 458], [861, 490], [850, 523]],
};

/** Visual page 1 blank ships with a previous client's header values; erase them first. */
const visualHeaderErase: LayoutOp[] = [
  // left column: from just after each label to the column edge
  { kind: 'erase', x: 277, y: 404, w: 420, h: 28, refY: 402 },
  { kind: 'erase', x: 278, y: 437, w: 419, h: 30, refY: 402 },
  { kind: 'erase', x: 291, y: 469, w: 406, h: 30, refY: 402 },
  { kind: 'erase', x: 203, y: 502, w: 494, h: 28, refY: 402 },
  // right column
  { kind: 'erase', x: 912, y: 404, w: 380, h: 28, refY: 402 },
  { kind: 'erase', x: 921, y: 437, w: 371, h: 30, refY: 402 },
  { kind: 'erase', x: 854, y: 469, w: 438, h: 30, refY: 402 },
  { kind: 'erase', x: 843, y: 502, w: 449, h: 28, refY: 402 },
];

const photo = (key: string, label: string) =>
  f.image(key, label, { required: true, minImages: 1, maxImages: 2, help: 'One or two photos (e.g. front and back of the bottle). They are placed side by side.' });

export const sterilityVisual: CoaDefinition = {
  slug: 'sterility-visual',
  name: 'Visual Sterility Test (USP <71>)',
  version: 1,
  status: 'complete',
  source: {
    folder: 'Products/Sterility Test',
    blanks: ['blankVisual-pg 3.png', 'blankVisual-pg 4 .png'],
    filled: ['FilledVisual-pg 3.png', 'FilledVisual-pg 4.png'],
  },
  sections: [
    { title: 'Client and sample', fields: [...clientHeaderFields(), reportDateField()] },
    {
      title: 'Photos',
      description: 'The photo headings read "TSB/FTM Control" and "TSB/FTM <sample name>".',
      fields: [
        photo('tsb_control_photos', 'TSB control'),
        photo('tsb_sample_photos', 'TSB sample'),
        photo('ftm_control_photos', 'FTM control'),
        photo('ftm_sample_photos', 'FTM sample'),
      ],
    },
    {
      title: 'Result',
      description: '"Result: Negative" and the conclusions (no microbial growth observed) are pre-printed on this template.',
      fields: [
        f.enumOf('no_growth_confirmed', 'No microbial growth observed in TSB and FTM media', ['Confirmed'], {
          required: true,
          span: 12,
          help: 'Required: the template can only state a negative result.',
        }),
      ],
    },
  ],
  pages: [
    {
      blank: 'blank-p1.png',
      ops: [
        ...reportDateOpsB(),
        ...visualHeaderErase,
        ...headerOps(VISUAL_HEADER),
        // "TSB [Sample Name]" heading: replace the literal placeholder with the sample name.
        { kind: 'erase', x: 815, y: 850, w: 430, h: 46, refY: 846 },
        { kind: 'value', field: 'sample_name', x: 816, y: 878, maxWidth: 1240 - 820, size: 31, minSize: 20, bold: true },
        { kind: 'image', field: 'tsb_control_photos', box: { x0: 140, y0: 900, x1: 668, y1: 1429 }, clear: '#ffffff' },
        { kind: 'image', field: 'tsb_sample_photos', box: { x0: 712, y0: 900, x1: 1241, y1: 1429 }, clear: '#ffffff' },
      ],
    },
    {
      blank: 'blank-p2.png',
      ops: [
        ...reportDateOpsB(),
        { kind: 'erase', x: 829, y: 505, w: 420, h: 44, refY: 502 },
        { kind: 'value', field: 'sample_name', x: 830, y: 533, maxWidth: 1243 - 834, size: 31, minSize: 20, bold: true },
        { kind: 'image', field: 'ftm_control_photos', box: { x0: 143, y0: 553, x1: 672, y1: 1082 }, clear: '#ffffff' },
        { kind: 'image', field: 'ftm_sample_photos', box: { x0: 715, y0: 553, x1: 1244, y1: 1082 }, clear: '#ffffff' },
        { kind: 'vkey', box: { x0: 580, y0: 1800, x1: 1066, y1: 1847 }, size: 30 },
      ],
    },
  ],
  rules: (d) =>
    d.no_growth_confirmed === 'Confirmed'
      ? []
      : [{ field: 'no_growth_confirmed', message: 'Confirm the negative result; this template cannot state any other result.' }],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client_name' },
  notes: [
    'The page 1 blank already contains a previous client\'s header values; they are erased before the entered values are drawn.',
    'The photo heading placeholder "[Sample Name]" (left literal in the completed example) is replaced with the entered sample name.',
    '"Result: Negative" and the conclusions are pre-printed, so this template can only be used for negative results.',
    'Page 2 signer address reads "44401 Piggly Wiggly" — template defect, not changed.',
    'The blank has "Report Date: 30 Jun 2025" pre-printed on each page; it is covered and replaced with the entered report date.',
    'The client email is printed on the certificate, so it is visible to anyone who can open the published COA.',
  ],
};
