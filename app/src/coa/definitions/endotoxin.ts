import type { CellOp, CoaDefinition, LayoutOp, ValueOp } from '../types.js';
import { f, FAIL_RED, LAVENDER, PASS_GREEN, reportDateField, reportDateOpsB } from './shared.js';

const STATUS = ['PASS', 'FAIL'];
const statusColors = { PASS: PASS_GREEN, FAIL: FAIL_RED };
const G = 23.5; // grid font size (px) measured from the blank's labels

const status = (key: string, label: string) =>
  f.enumOf(key, label, STATUS, { required: true, span: 3, help: 'PASS is printed in green (as in the example), FAIL in red.' });

/** Grid value placed after a pre-printed label. */
function g(field: string, x: number, y: number, right: number, extra: Partial<ValueOp> = {}): ValueOp {
  return { kind: 'value', field, x, y, maxWidth: right - x, size: G, minSize: 17, ...extra };
}

/** Grid value in a tall band: wraps to a second line and moves the label up, like the completed example. */
function tall(
  field: string,
  label: string,
  labelX: number,
  labelRight: number,
  valueX: number,
  y: number,
  right: number,
  band: { top: number; bottom: number },
  bg: string,
): ValueOp {
  return {
    kind: 'value',
    field,
    x: valueX,
    y,
    maxWidth: right - valueX,
    contX: labelX,
    contMaxWidth: right - labelX,
    band,
    size: G,
    minSize: 18,
    maxLines: 2,
    lineHeight: 31,
    relabel: { text: label, x: labelX, size: G, bold: true, bg, coverRight: labelRight + 4 },
  };
}

function cell(field: string, x0: number, x1: number, y0: number, y1: number, extra: Partial<CellOp> = {}): CellOp {
  return { kind: 'cell', field, box: { x0, x1, y0, y1 }, size: G, minSize: 16, align: 'center', padX: 4, ...extra };
}

const R1 = [1456, 1500] as const;
const R2 = [1500, 1542] as const;
const RM = [1456, 1542] as const;

const BAND_LOT = { top: 752, bottom: 829 };
const BAND_LIMIT = { top: 1097, bottom: 1174 };
const BAND_ALERT = { top: 1176, bottom: 1251 };

const layout: LayoutOp[] = [
  ...reportDateOpsB(),
  // Header (28px)
  { kind: 'value', field: 'report_id', x: 554, y: 428, maxWidth: 1295 - 554, size: 28, minSize: 20, bold: true },
  { kind: 'value', field: 'analyst', x: 255, y: 479, maxWidth: 700 - 255, size: 28, minSize: 20 },
  { kind: 'value', field: 'lab_name', x: 289, y: 518, maxWidth: 700 - 289, size: 28, minSize: 20 },
  { kind: 'value', field: 'instrument_type', x: 366, y: 557, maxWidth: 700 - 366, size: 28, minSize: 20 },
  { kind: 'value', field: 'assay_datetime', x: 945, y: 479, maxWidth: 1295 - 945, size: 28, minSize: 18 },
  { kind: 'value', field: 'instrument_serial', x: 1064, y: 518, maxWidth: 1295 - 1064, size: 28, minSize: 18 },
  // SAMPLE RESULTS grid (23.5px)
  g('serial_bay', 358, 692, 710),
  g('start_end_temp', 944, 692, 1295),
  g('sample_name', 303, 737, 1295),
  tall('sample_id', 'Sample ID:', 151, 262, 270, 798, 710, BAND_LOT, LAVENDER),
  tall('sample_lot', 'Sample Lot:', 721, 842, 850, 798, 1020, BAND_LOT, LAVENDER),
  tall('dil_conc', 'Dil./Conc.:', 1028, 1133, 1141, 798, 1295, BAND_LOT, LAVENDER),
  g('dilution', 245, 859, 1295),
  g('sample_comments', 353, 904, 1295, { minSize: 15 }),
  g('cartridge_lot', 394, 949, 710),
  g('cartridge_range', 904, 949, 1295),
  g('calibration_code', 338, 993, 710),
  g('archived_spike_conc', 1041, 993, 1295),
  g('range', 227, 1038, 710),
  g('y_intercept', 846, 1038, 1020),
  g('slope', 1095, 1038, 1295),
  g('endotoxin_value', 331, 1082, 710),
  g('sample_cv_limit', 911, 1082, 1020),
  g('sample_cv_status', 1103, 1082, 1295, { colorMap: statusColors }),
  tall('endotoxin_limit', 'Endotoxin Limit:', 150, 323, 331, 1143, 415, BAND_LIMIT, LAVENDER),
  g('endotoxin_limit_status', 500, 1143, 710, { colorMap: statusColors }),
  tall('spike_cv_limit', 'Spike CV Limit:', 721, 884, 892, 1143, 1020, BAND_LIMIT, LAVENDER),
  g('spike_cv_status', 1103, 1143, 1295, { colorMap: statusColors }),
  tall('alert_limit', 'Alert Limit:', 150, 270, 278, 1221, 710, BAND_ALERT, '#ffffff'),
  tall('spike_recovery_range', 'Spike Recovery Range:', 721, 953, 961, 1221, 1020, BAND_ALERT, '#ffffff'),
  g('spike_recovery_status', 1103, 1221, 1295, { colorMap: statusColors }),
  g('cartridge_type', 318, 1283, 710),
  g('performed_with', 899, 1283, 1295),
  // The "Sample Value" cell is pre-printed green. If the endotoxin result FAILs it is
  // neutralised to white rather than implying a pass.
  {
    kind: 'when',
    test: (d) => d.endotoxin_limit_status === 'FAIL',
    ops: [{ kind: 'cover', x: 557, y: 1455, w: 160, h: 88, color: '#ffffff' }],
  },
  // SAMPLE DATA / SPIKE DATA
  cell('sample_ch1', 150, 280, ...R1),
  cell('sample_ch2', 150, 280, ...R2),
  cell('sample_rt1', 285, 420, ...R1),
  cell('sample_rt2', 285, 420, ...R2),
  cell('sample_cv', 425, 555, ...RM),
  cell('sample_value', 557, 717, ...RM, { maxLines: 2 }),
  cell('spike_ch1', 719, 830, ...R1),
  cell('spike_ch2', 719, 830, ...R2),
  cell('spike_rt1', 832, 945, ...R1),
  cell('spike_rt2', 832, 945, ...R2),
  cell('spike_cv', 947, 1027, ...RM),
  cell('spike_value', 1029, 1165, ...RM, { maxLines: 2, lineHeight: 32 }),
  cell('spike_recovery', 1167, 1298, ...RM, { maxLines: 2 }),
  // Report comments (bold value, as in the example)
  { kind: 'value', field: 'report_comments', x: 392, y: 1580, maxWidth: 1295 - 392, size: 28, minSize: 18, bold: true },
  { kind: 'vkey', box: { x0: 630, y0: 1903, x1: 923, y1: 1930 }, size: 20 },
];

const m = (key: string, label: string, required = false) => f.measure(key, label, { required, span: 4 });

export const endotoxin: CoaDefinition = {
  slug: 'endotoxin',
  name: 'Endotoxin Report (LAL)',
  version: 1,
  status: 'complete',
  source: { folder: 'Products/ENDOTOXIn Report', blanks: ['blank-pg 1.png'], filled: ['Filled-pg 1.png'] },
  reportNumberField: 'report_id',
  sections: [
    {
      title: 'Report',
      fields: [
        f.text('report_id', 'Detailed LAL Endotoxin Report ID', {
          required: true,
          maxLength: 60,
          pattern: /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/,
          patternHint: 'Letters, numbers, "-", "_", "." and "/" only.',
          help: 'Must be unique. Printed after "Detailed LAL Endotoxin Report:".',
          span: 6,
        }),
        reportDateField(),
        f.text('analyst', 'Analyst', { required: true, span: 4 }),
        f.text('lab_name', 'Lab name', { span: 4 }),
        f.text('instrument_type', 'Instrument type', { span: 4 }),
        f.text('assay_datetime', 'Assay date/time', {
          required: true,
          span: 6,
          help: 'Free text exactly as it should appear (the example shows a date with AM/EST).',
        }),
        f.text('instrument_serial', 'Instrument serial number', { span: 6 }),
      ],
    },
    {
      title: 'Sample results',
      fields: [
        m('serial_bay', 'Serial number/bay'),
        m('start_end_temp', 'Start/End temp (°C)'),
        f.text('sample_name', 'Sample name', { required: true, span: 4 }),
        m('sample_id', 'Sample ID'),
        m('sample_lot', 'Sample lot'),
        m('dil_conc', 'Dil./Conc.'),
        m('dilution', 'Dilution'),
        f.measure('sample_comments', 'Sample comments', { span: 12, maxLength: 120 }),
        m('cartridge_lot', 'Cartridge lot number'),
        m('cartridge_range', 'Cartridge range'),
        m('calibration_code', 'Calibration code'),
        m('archived_spike_conc', 'Archived spike concentration'),
        m('range', 'Range'),
        m('y_intercept', 'Y-intercept'),
        m('slope', 'Slope'),
        m('cartridge_type', 'Cartridge type'),
        m('performed_with', 'Performed with'),
      ],
    },
    {
      title: 'Limits and status',
      description: 'Values are printed exactly as entered (e.g. "<2.17 EU/mg"). Status is chosen by the analyst; nothing is calculated.',
      fields: [
        m('endotoxin_value', 'Endotoxin value', true),
        m('endotoxin_limit', 'Endotoxin limit', true),
        status('endotoxin_limit_status', 'Endotoxin limit status'),
        m('sample_cv_limit', 'Sample CV limit'),
        status('sample_cv_status', 'Sample CV status'),
        m('spike_cv_limit', 'Spike CV limit'),
        status('spike_cv_status', 'Spike CV status'),
        m('alert_limit', 'Alert limit'),
        m('spike_recovery_range', 'Spike recovery range'),
        status('spike_recovery_status', 'Spike recovery status'),
      ],
    },
    {
      title: 'Sample data',
      fields: [
        m('sample_ch1', 'Channel (row 1)'),
        m('sample_rt1', 'Reaction time (row 1)'),
        m('sample_ch2', 'Channel (row 2)'),
        m('sample_rt2', 'Reaction time (row 2)'),
        m('sample_cv', 'CV%'),
        m('sample_value', 'Sample value'),
      ],
    },
    {
      title: 'Spike data',
      fields: [
        m('spike_ch1', 'Channel (row 1)'),
        m('spike_rt1', 'Reaction time (row 1)'),
        m('spike_ch2', 'Channel (row 2)'),
        m('spike_rt2', 'Reaction time (row 2)'),
        m('spike_cv', 'CV%'),
        m('spike_value', 'Spike value'),
        m('spike_recovery', 'Spike recovery'),
      ],
    },
    { title: 'Comments', fields: [f.measure('report_comments', 'Report comments', { span: 12, maxLength: 100 })] },
  ],
  pages: [{ blank: 'blank-p1.png', ops: layout }],
  summary: { sampleName: 'sample_name', lot: 'sample_lot', reportDate: 'report_date' },
  notes: [
    'The blank has "Report Date: 30 Jun 2025" pre-printed; it is covered and replaced with the entered report date.',
    'The pre-printed label reads "Start/End Temp CC):" (unmatched parenthesis) — template defect, not changed.',
    'The "Sample Value" cell is pre-printed green. When the endotoxin limit status is FAIL the cell is rendered white instead.',
    'FAIL is rendered in red; the examples only show PASS (green), so the red colour is a styling assumption.',
    'The completed example was not produced from this exact blank (header labels are offset by ~9px); positions follow the blank.',
  ],
};
