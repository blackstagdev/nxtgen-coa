import type { CoaDefinition, LayoutOp } from '../types.js';
import { CHECK_GREY, f, reportDateField, reportDateOpsB, v } from './shared.js';
import { clientHeaderFields } from './sterility.js';

const RES = { y0: 671, y1: 774 };
const GEL = { y0: 1153, y1: 1225 };

const layout: LayoutOp[] = [
  ...reportDateOpsB(),
  v('client_name', 311, 428, 690 - 311),
  v('client_email', 312, 461, 690 - 312, { minSize: 17 }),
  v('sample_name', 327, 493, 690 - 327),
  v('lot_number', 222, 526, 690 - 222),
  v('received_date', 960, 428, 1285 - 960, { format: 'mdy' }),
  v('articles_tested', 965, 461, 1285 - 965),
  v('test_start_date', 891, 493, 1285 - 891, { format: 'mdy' }),
  v('test_end_date', 878, 526, 1285 - 878, { format: 'mdy' }),
  // Results row. "pH" is the test parameter of this test type.
  { kind: 'static', text: 'pH', x: 152, y: 731, size: 28 },
  { kind: 'cell', field: 'specification', box: { x0: 367, x1: 561, ...RES }, size: 28, minSize: 18, maxLines: 2, padX: 11 },
  { kind: 'cell', field: 'ph_result', box: { x0: 561, x1: 697, ...RES }, size: 28, minSize: 18, padX: 12 },
  { kind: 'cell', field: 'method', box: { x0: 697, x1: 1131, ...RES }, size: 28, minSize: 18, maxLines: 3, lineHeight: 39, padX: 12 },
  {
    kind: 'when',
    test: (d) => d.status === 'PASS',
    uses: ['status'],
    ops: [
      { kind: 'checkmark', x: 1145, y: 735, size: 30, color: CHECK_GREY },
      { kind: 'static', text: 'PASS', x: 1185, y: 731, size: 28 },
    ],
  },
  { kind: 'when', test: (d) => d.status === 'FAIL', uses: ['status'], ops: [{ kind: 'static', text: 'FAIL', x: 1145, y: 731, size: 28 }] },
  // Peptide gelling assessment
  { kind: 'cell', field: 'gelling_ph', box: { x0: 142, x1: 401, ...GEL }, size: 28, minSize: 18, padX: 11 },
  { kind: 'cell', field: 'peptide_pi', box: { x0: 401, x1: 836, ...GEL }, size: 28, minSize: 18, padX: 12 },
  { kind: 'cell', field: 'gelling_potential', box: { x0: 836, x1: 1268, ...GEL }, size: 28, minSize: 18, padX: 12 },
  // Instrument details
  v('instrument', 337, 1346, 1285 - 337, { minSize: 18 }),
  v('electrode', 316, 1385, 1285 - 316, { minSize: 18 }),
  v('calibration', 341, 1424, 1285 - 341, { minSize: 16 }),
  v('calibration_due_date', 468, 1462, 748 - 468, { format: 'mdy' }),
  v('instrument_id', 383, 1501, 791 - 383, { minSize: 18 }),
  { kind: 'vkey', box: { x0: 630, y0: 1881, x1: 923, y1: 1908 }, size: 20 },
];

export const phUsp791: CoaDefinition = {
  slug: 'ph-usp-791',
  name: 'pH Test (USP <791>)',
  version: 1,
  status: 'complete',
  source: { folder: 'Products/pH Test (USP _791_)', blanks: ['blank-pg 1.png'], filled: ['Filled-pg 1.png'] },
  sections: [
    { title: 'Client and sample', fields: [...clientHeaderFields(), reportDateField()] },
    {
      title: 'Result',
      description: 'Specification and status are entered by the analyst exactly as they should be printed.',
      fields: [
        f.measure('specification', 'Specification', { required: true, span: 4, help: 'e.g. a range such as "4.00 – 8.00".' }),
        f.decimal('ph_result', 'Result (pH)', { required: true, span: 4 }),
        f.enumOf('status', 'Status', ['PASS', 'FAIL'], { required: true, span: 4, help: 'PASS is printed with a check mark, as in the example.' }),
        f.multiline('method', 'Method', { required: true, maxLength: 140, help: 'Up to three lines in the Method cell.' }),
      ],
    },
    {
      title: 'Peptide gelling assessment',
      fields: [
        f.decimal('gelling_ph', 'pH', { span: 4, help: 'Entered separately; not copied from the result automatically.' }),
        f.decimal('peptide_pi', 'PI of peptide', { span: 4 }),
        f.enumOf('gelling_potential', 'Gelling potential', ['Possible', 'Unlikely'], {
          span: 4,
          help: 'The example shows "Possible/ Unlikely"; one value is selected here.',
        }),
      ],
    },
    {
      title: 'Instrument details',
      fields: [
        f.text('instrument', 'Instrument', { span: 6 }),
        f.text('electrode', 'Electrode', { span: 6 }),
        f.text('calibration', 'Calibration', { span: 12, maxLength: 90 }),
        f.date('calibration_due_date', 'Calibration due date', { span: 6 }),
        f.text('instrument_id', 'Instrument ID', { span: 6, maxLength: 40 }),
      ],
    },
  ],
  pages: [{ blank: 'blank-p1.png', ops: layout }],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client_name' },
  notes: [
    'The blank header reads "NxtGen Analysis, LLC" (the completed example reads "NextGen") — template defect, not changed.',
    'The blank has "Report Date: 30 Jun 2025" pre-printed; it is covered and replaced with the entered report date.',
    'The procedure paragraph (25 ± 1 °C, <0.01 drift) is pre-printed.',
    '"Gelling Potential" appears as "Possible/ Unlikely" in the example; treated as a choice between the two values (confirm with the lab).',
    'The client email is printed on the certificate, so it is visible to anyone who can open the published COA.',
  ],
};
