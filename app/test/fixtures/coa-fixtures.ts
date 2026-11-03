/**
 * TEST FIXTURES — representative data for each COA type.
 *
 * Values mirror the supplied completed examples so renders can be compared
 * against them for placement accuracy. They are NOT defaults and must never be
 * used for real reports. Fixture records are flagged `is_test_fixture` and
 * rendered with a "TEST DATA" watermark everywhere except the comparison sheets.
 */
import type { CoaData } from '../../src/coa/types.js';

export interface ImageCrop {
  /** Path relative to the repository root. */
  src: string;
  crop: [number, number, number, number]; // x0, y0, x1, y1
}

export interface Fixture {
  slug: string;
  data: CoaData;
  images: Record<string, ImageCrop[]>;
}

const ref = (slug: string, page = 1) => `docs/reference/${slug}/filled-p${page}.png`;

const hplcBase: CoaData = {
  client: 'Peptide Brand Name',
  sample_name: 'GLP-2 (11mg)',
  lot_number: 'TIRZ_2385973',
  report_date: '2025-06-30',
};

export const FIXTURES: Fixture[] = [
  {
    slug: 'hplc-purity',
    data: { ...hplcBase, purity_percent: '99.96' },
    images: {
      chromatogram: [{ src: ref('hplc-purity'), crop: [141, 790, 1266, 1170] }],
      peak_table: [{ src: ref('hplc-purity'), crop: [151, 1262, 666, 1399] }],
    },
  },
  {
    slug: 'hplc-quantity',
    data: {
      ...hplcBase,
      sample1_quantity: '11.5',
      sample2_quantity: '11.2',
      sample3_quantity: '11.1',
      average_quantity: '11.26',
      note: 'TEST FIXTURE note text to check wrapping inside the note box across more than one line of the certificate.',
    },
    images: { mass_spectrum: [{ src: ref('hplc-quantity'), crop: [180, 888, 1228, 1292] }] },
  },
  {
    slug: 'hplc-purity-quantity',
    data: {
      ...hplcBase,
      purity_percent: '99.96',
      sample1_quantity: '11.2',
      sample2_quantity: '11.5',
      sample3_quantity: '11.1',
      average_quantity: '11.26',
      note: 'TEST FIXTURE: multi-line note to verify wrapping inside the boxed area without overlapping the border.',
    },
    images: {
      chromatogram: [{ src: ref('hplc-purity-quantity'), crop: [173, 913, 1253, 1235] }],
      peak_table: [{ src: ref('hplc-purity-quantity'), crop: [151, 1342, 668, 1478] }],
    },
  },
  {
    slug: 'hplc-pq-identification',
    data: {
      ...hplcBase,
      purity_percent: '99.96',
      sample1_quantity: '11.2',
      sample2_quantity: '11.5',
      sample3_quantity: '11.1',
      average_quantity: '11.26',
      expected_mass: '3751.2 Da',
      measured_mass: '3751.4 Da',
    },
    images: {
      chromatogram: [{ src: ref('hplc-pq-identification', 1), crop: [160, 915, 1253, 1238] }],
      peak_table: [{ src: ref('hplc-pq-identification', 1), crop: [151, 1356, 668, 1492] }],
      mass_spectrum: [{ src: ref('hplc-pq-identification', 2), crop: [157, 805, 1297, 1245] }],
    },
  },
  {
    slug: 'ms-identification',
    data: { ...hplcBase, expected_mass: '3751.2 Da', measured_mass: '3751.4 Da' },
    images: { mass_spectrum: [{ src: ref('ms-identification'), crop: [151, 798, 1295, 1238] }] },
  },
  {
    slug: 'endotoxin',
    data: {
      report_id: 'NGA-25081040-120251107-001',
      report_date: '2025-06-30',
      analyst: 'Grace Post',
      lab_name: 'NextGen',
      instrument_type: 'nexgen PTS/MCS',
      assay_datetime: '1 1/7/2025 AM EST',
      instrument_serial: '25141213',
      serial_bay: 'MCS 25081040/1',
      start_end_temp: '37.1:37.0',
      sample_name: '2x25-102-002',
      sample_id: 'N/A',
      sample_lot: '2x25-102-002 100825',
      dil_conc: '0.0023 mg/mL',
      dilution: 'N/A',
      sample_comments: 'N/A',
      cartridge_lot: '2520301244',
      cartridge_range: '0.5-0.005 EU/mL',
      calibration_code: '421660646287',
      archived_spike_conc: '0.082 EU/mL',
      range: '216-1006 seconds',
      y_intercept: '+2.234',
      slope: '-0.334',
      endotoxin_value: '<2.17 EU/mg',
      sample_cv_limit: '<25%',
      sample_cv_status: 'PASS',
      endotoxin_limit: '<5 EU/mg',
      endotoxin_limit_status: 'PASS',
      spike_cv_limit: '<25%',
      spike_cv_status: 'PASS',
      alert_limit: 'N/A',
      spike_recovery_range: '50-200%',
      spike_recovery_status: 'PASS',
      cartridge_type: 'LAL Cartridge',
      performed_with: 'N/A',
      sample_ch1: '1',
      sample_rt1: '> 1006',
      sample_ch2: '3',
      sample_rt2: '> 1006',
      sample_cv: '0.0%',
      sample_value: '<2.17 EU/mg',
      spike_ch1: '2',
      spike_rt1: '400',
      spike_ch2: '4',
      spike_rt2: '372',
      spike_cv: '5.1%',
      spike_value: '0.083 EU/mL',
      spike_recovery: '101%',
      report_comments: 'N/A',
    },
    images: {},
  },
  {
    slug: 'ph-usp-791',
    data: {
      client_name: 'RTD Biosciences',
      client_email: 'kasey@rtdbiosciences.com',
      sample_name: 'SER10N103025',
      lot_number: '103025',
      received_date: '2025-10-22',
      articles_tested: '20',
      test_start_date: '2025-10-22',
      test_end_date: '2025-11-06',
      report_date: '2025-06-30',
      specification: '4.00 – 8.00',
      ph_result: '7.12',
      status: 'PASS',
      method: 'Calibrated Digital pH Meter (3-Point: 4.01 / 7.00 / 10.01)',
      gelling_ph: '7.12',
      peptide_pi: '7.0',
      gelling_potential: 'Unlikely',
      instrument: 'Thermo Scientific Orion VersaStar Pro',
      electrode: 'Orion Combination Glass pH Electrode',
      calibration: '3-point NIST-traceable buffer calibration performed same day',
      calibration_due_date: '2026-01-15',
      instrument_id: 'TEST-INSTR-01',
    },
    images: {},
  },
  {
    slug: 'sterility-atp',
    data: {
      client_name: 'RTD Biosciences',
      client_email: 'kasey@rtdbiosciences.com',
      sample_name: 'SER10N103025',
      lot_number: '103025',
      received_date: '2025-10-22',
      articles_tested: '20',
      test_start_date: '2025-10-22',
      test_end_date: '2025-11-06',
      report_date: '2025-06-30',
      tsb_ctrl_sample_id: 'TSB', tsb_ctrl_comments: 'N/A', tsb_ctrl_pos_cutoff: '17412', tsb_ctrl_neg_cutoff: '17412',
      tsb_ctrl_rlu: '5804', tsb_ctrl_bkgnd: '5', tsb_ctrl_cv: '3', tsb_ctrl_notification: 'None', tsb_ctrl_result: 'Calibrator',
      tsb_ctrl_chainpos: '1', tsb_ctrl_rlu1: '5968', tsb_ctrl_rlu2: '5639',
      tsb_sample_sample_id: 'TSB-SER10N103025', tsb_sample_comments: 'N/A', tsb_sample_pos_cutoff: '17412', tsb_sample_neg_cutoff: '17412',
      tsb_sample_rlu: '4978', tsb_sample_bkgnd: '4', tsb_sample_cv: '9', tsb_sample_notification: 'None', tsb_sample_result: 'Negative',
      tsb_sample_chainpos: '3', tsb_sample_rlu1: '4517', tsb_sample_rlu2: '5438',
      ftm_ctrl_sample_id: 'FTM', ftm_ctrl_comments: 'N/A', ftm_ctrl_pos_cutoff: '11520', ftm_ctrl_neg_cutoff: '11520',
      ftm_ctrl_rlu: '3840', ftm_ctrl_bkgnd: '7', ftm_ctrl_cv: '1', ftm_ctrl_notification: 'None', ftm_ctrl_result: 'Calibrator',
      ftm_ctrl_chainpos: '6', ftm_ctrl_rlu1: '3793', ftm_ctrl_rlu2: '3886',
      ftm_sample_sample_id: 'FTM-SER10N103025', ftm_sample_comments: 'N/A', ftm_sample_pos_cutoff: '11520', ftm_sample_neg_cutoff: '11520',
      ftm_sample_rlu: '4125', ftm_sample_bkgnd: '7', ftm_sample_cv: '0', ftm_sample_notification: 'None', ftm_sample_result: 'Negative',
      ftm_sample_chainpos: '8', ftm_sample_rlu1: '4131', ftm_sample_rlu2: '4119',
    },
    images: {},
  },
  {
    slug: 'sterility-visual',
    data: {
      client_name: 'RTD Biosciences',
      client_email: 'kasey@rtdbiosciences.com',
      sample_name: 'SER10N103025',
      lot_number: '103025',
      received_date: '2025-10-22',
      articles_tested: '20',
      test_start_date: '2025-10-22',
      test_end_date: '2025-11-06',
      report_date: '2025-06-30',
      no_growth_confirmed: 'Confirmed',
    },
    images: {
      tsb_control_photos: [
        { src: ref('sterility-visual', 1), crop: [143, 903, 371, 1410] },
        { src: ref('sterility-visual', 1), crop: [379, 903, 611, 1410] },
      ],
      tsb_sample_photos: [
        { src: ref('sterility-visual', 1), crop: [745, 903, 991, 1410] },
        { src: ref('sterility-visual', 1), crop: [996, 903, 1238, 1410] },
      ],
      ftm_control_photos: [{ src: ref('sterility-visual', 2), crop: [146, 557, 668, 1078] }],
      ftm_sample_photos: [{ src: ref('sterility-visual', 2), crop: [718, 557, 1240, 1078] }],
    },
  },
];
