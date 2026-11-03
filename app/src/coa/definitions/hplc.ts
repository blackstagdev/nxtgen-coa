import type { CoaDefinition, FieldDef, LayoutOp } from '../types.js';
import { f, reportDateField, reportDateOpsA, v, VKEY_LARGE } from './shared.js';

// ---- Fields shared by the HPLC / mass-spectrometry family -------------------

const client = () => f.text('client', 'Client', { required: true, help: 'Printed after "Client:". Usually the brand or company name.' });
const sampleName = () => f.text('sample_name', 'Sample name', { required: true, placeholder: 'e.g. compound and fill amount' });
const lot = () => f.text('lot_number', 'Lot #', { required: true, maxLength: 60 });
const purity = () =>
  f.decimal('purity_percent', 'Purity', { required: true, unit: '%', help: 'Enter the number only; "%" is added on the certificate. Precision is kept exactly as typed.' });
const qty = (n: 1 | 2 | 3) => f.decimal(`sample${n}_quantity`, `Sample ${n} quantity`, { required: true, unit: 'mg', span: 3 });
const avgQty = () =>
  f.decimal('average_quantity', 'Average quantity', {
    required: true,
    unit: 'mg',
    span: 3,
    help: 'Entered by the analyst. The system does not calculate this value.',
  });
const note = (maxLength: number) => f.multiline('note', 'Note', { maxLength, help: 'Optional. Printed inside the "Note:" box.' });
const chromatogram = () =>
  f.image('chromatogram', 'HPLC chromatogram', { required: true, help: 'Screenshot/export of the chromatogram (PNG, JPEG or WEBP).' });
const peakTable = () =>
  f.image('peak_table', 'Peak chart', { required: true, help: 'Screenshot of the instrument peak table (Peak, RT, Area, Area Sum %).' });
const spectrum = (label = 'Mass spectrum') => f.image('mass_spectrum', label, { required: true, help: 'Screenshot/export of the spectrum.' });
const expectedMass = () =>
  f.measure('expected_mass', 'Expected mass', { help: 'Include the unit (e.g. Da). No completed example was supplied for this field.' });
const measuredMass = () =>
  f.measure('measured_mass', 'Measured mass', { help: 'Include the unit (e.g. Da). No completed example was supplied for this field.' });

const sampleSection = (extra: FieldDef[] = []) => ({
  title: 'Sample',
  fields: [client(), sampleName(), lot(), reportDateField(), ...extra],
});

// ---- Layout blocks ---------------------------------------------------------

/** Header block used by "Purity & Quantity" and page 1 of "Purity, Quantity & Identification". */
const pqHeader = (): LayoutOp[] => [
  v('client', 241, 565, 780 - 241),
  v('sample_name', 335, 611, 780 - 335),
  v('lot_number', 231, 657, 780 - 231),
  v('purity_percent', 280, 702, 780 - 280, { suffix: '%' }),
  v('sample1_quantity', 1036, 565, 1285 - 1036, { suffix: 'mg' }),
  v('sample2_quantity', 1036, 611, 1285 - 1036, { suffix: 'mg' }),
  v('sample3_quantity', 1036, 657, 1285 - 1036, { suffix: 'mg' }),
  v('average_quantity', 1023, 702, 1285 - 1023, { suffix: 'mg' }),
  { kind: 'image', field: 'chromatogram', box: { x0: 146, y0: 902, x1: 1268, y1: 1296 } },
  { kind: 'image', field: 'peak_table', box: { x0: 153, y0: 1341, x1: 666, y1: 1476 }, padding: 3 },
  {
    kind: 'value',
    field: 'note',
    x: 783,
    y: 1371,
    maxWidth: 1262 - 783,
    contX: 715,
    contMaxWidth: 1262 - 715,
    size: 28,
    minSize: 18,
    maxHeight: 1470 - 1371,
    lineHeight: 30,
  },
];

/** Mass-spectrometry identification block (stand-alone MS page and page 2 of PQ+ID). */
const msBlock = (imageBottom: number): LayoutOp[] => [
  v('client', 254, 559, 760 - 254),
  v('sample_name', 348, 605, 760 - 348),
  v('lot_number', 242, 651, 760 - 242),
  v('expected_mass', 976, 559, 1290 - 976),
  v('measured_mass', 985, 605, 1290 - 985),
  { kind: 'image', field: 'mass_spectrum', box: { x0: 152, y0: 766, x1: 1290, y1: imageBottom } },
];

const vkey = (): LayoutOp => ({ kind: 'vkey', box: VKEY_LARGE, size: 30 });

const COMMON_NOTES = [
  'Signatures and signer details are pre-printed on the blank template and are not editable.',
  'Method "HPLC-UV-MS" is pre-printed on the template where shown.',
];

export const hplcPurity: CoaDefinition = {
  slug: 'hplc-purity',
  name: 'HPLC – Purity Test',
  version: 1,
  status: 'complete',
  source: { folder: 'Products/HPLC-PURITY', blanks: ['blank - pg 1.png'], filled: ['Filled - pg1.png'] },
  sections: [
    sampleSection(),
    { title: 'Results', fields: [purity()] },
    { title: 'Instrument output', fields: [chromatogram(), peakTable()] },
  ],
  pages: [
    {
      blank: 'blank-p1.png',
      ops: [
        ...reportDateOpsA(),
        v('client', 242, 574, 745 - 242),
        v('sample_name', 336, 620, 745 - 336),
        v('lot_number', 231, 662, 745 - 231),
        v('purity_percent', 896, 574, 1285 - 896, { suffix: '%' }),
        { kind: 'image', field: 'chromatogram', box: { x0: 146, y0: 792, x1: 1268, y1: 1208 } },
        { kind: 'image', field: 'peak_table', box: { x0: 153, y0: 1263, x1: 693, y1: 1441 }, padding: 4 },
        vkey(),
      ],
    },
  ],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client' },
  notes: [
    ...COMMON_NOTES,
    'The completed example includes a "Phone" line in the signer blocks that the supplied blank does not have; the blank is used as-is.',
  ],
};

export const hplcPurityQuantity: CoaDefinition = {
  slug: 'hplc-purity-quantity',
  name: 'HPLC – Purity & Quantity Test',
  version: 1,
  status: 'complete',
  source: { folder: 'Products/HPLC - Purity & Quantity Test', blanks: ['Blank -pg 1.png'], filled: ['Filled- pg 1 .png'] },
  sections: [
    sampleSection(),
    { title: 'Results', fields: [purity(), qty(1), qty(2), qty(3), avgQty()] },
    { title: 'Instrument output', fields: [chromatogram(), peakTable()] },
    { title: 'Note', fields: [note(240)] },
  ],
  pages: [{ blank: 'blank-p1.png', ops: [...reportDateOpsA(), ...pqHeader(), vkey()] }],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client' },
  notes: [...COMMON_NOTES, 'Average quantity is entered by staff; it is never calculated by the system.'],
};

export const hplcQuantity: CoaDefinition = {
  slug: 'hplc-quantity',
  name: 'HPLC – Quantity Test',
  version: 1,
  status: 'complete',
  source: { folder: 'Products/HPLC Quantity Test', blanks: ['Blank - pg 1.png'], filled: ['Filled -pg 1.png'] },
  sections: [
    sampleSection(),
    { title: 'Results', fields: [qty(1), qty(2), qty(3), avgQty()] },
    {
      title: 'Instrument output',
      description: 'The template heading for this image reads "Mass Spectrum".',
      fields: [spectrum('Image under "Mass Spectrum" heading')],
    },
    { title: 'Note', fields: [note(220)] },
  ],
  pages: [
    {
      blank: 'blank-p1.png',
      ops: [
        ...reportDateOpsA(),
        v('client', 252, 544, 780 - 252),
        v('sample_name', 346, 590, 780 - 346),
        v('sample1_quantity', 406, 634, 780 - 406, { suffix: 'mg' }),
        v('sample2_quantity', 406, 678, 780 - 406, { suffix: 'mg' }),
        v('sample3_quantity', 406, 722, 780 - 406, { suffix: 'mg' }),
        v('average_quantity', 393, 766, 780 - 393, { suffix: 'mg' }),
        v('lot_number', 867, 544, 1285 - 867),
        { kind: 'image', field: 'mass_spectrum', box: { x0: 168, y0: 872, x1: 1244, y1: 1358 } },
        {
          kind: 'value',
          field: 'note',
          x: 253,
          y: 1402,
          maxWidth: 1237 - 253,
          contX: 185,
          contMaxWidth: 1237 - 185,
          size: 28,
          minSize: 18,
          maxHeight: 1450 - 1402,
          lineHeight: 30,
        },
        vkey(),
      ],
    },
  ],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client' },
  notes: [
    ...COMMON_NOTES,
    'The image heading on this HPLC template reads "Mass Spectrum" (not "Chromatogram"); kept as printed. Confirm with the lab.',
    'The blank prints "Lot #:" in regular weight while the completed example shows it bold; the blank is used as-is.',
  ],
};

export const msIdentification: CoaDefinition = {
  slug: 'ms-identification',
  name: 'Mass Spectrometry (QTOF-HRMS) – Compound Identification',
  version: 1,
  status: 'complete',
  source: { folder: 'Products/HLPC compound identification', blanks: ['blank - pg1.png'], filled: ['Filled -pg1.png'] },
  sections: [
    sampleSection(),
    { title: 'Results', description: '"Identity confirmed using QTOF-HRMS" and the conclusion paragraph are pre-printed.', fields: [expectedMass(), measuredMass()] },
    { title: 'Instrument output', fields: [spectrum()] },
  ],
  pages: [{ blank: 'blank-p1.png', ops: [...reportDateOpsA(), ...msBlock(1366), vkey()] }],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client' },
  notes: [
    ...COMMON_NOTES,
    'Folder name says "HLPC compound identification" but the template is Mass Spectrometry QTOF-HRMS.',
    'Expected/Measured Mass are empty in the completed example, so their format is unconfirmed (free text with unit).',
    'The pre-printed conclusion states identity was confirmed; the template cannot express a non-confirming result.',
  ],
};

export const hplcPqIdentification: CoaDefinition = {
  slug: 'hplc-pq-identification',
  name: 'HPLC – Purity, Quantity & Compound Identification Test',
  version: 1,
  status: 'complete',
  source: {
    folder: 'Products/HPLC - Purity, Quantity, AND Compound identification Test',
    blanks: ['blank-pg 1.png', 'blank-pg 2.png'],
    filled: ['Filled-pg 1.png', 'Filled-pg 2.png'],
  },
  sections: [
    { ...sampleSection(), description: 'Client, sample name and lot are printed on both pages.' },
    { title: 'Purity & quantity (page 1)', fields: [purity(), qty(1), qty(2), qty(3), avgQty()] },
    { title: 'Instrument output (page 1)', fields: [chromatogram(), peakTable()] },
    { title: 'Note (page 1)', fields: [note(240)] },
    { title: 'Compound identification (page 2)', fields: [expectedMass(), measuredMass(), spectrum()] },
  ],
  pages: [
    { blank: 'blank-p1.png', ops: [...reportDateOpsA(), ...pqHeader(), vkey()] },
    { blank: 'blank-p2.png', ops: [...reportDateOpsA(), ...msBlock(1322), vkey()] },
  ],
  summary: { sampleName: 'sample_name', lot: 'lot_number', reportDate: 'report_date', client: 'client' },
  notes: [
    ...COMMON_NOTES,
    'Page 1 has no signature block on the template; signatures appear on page 2.',
    'Expected/Measured Mass are empty in the completed example, so their format is unconfirmed (free text with unit).',
  ],
};
