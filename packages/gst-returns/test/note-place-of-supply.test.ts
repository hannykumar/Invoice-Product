/**
 * Issue #232 — a credit note counts in the state of the bill it corrects.
 *
 * Every sales-return note used to be given the seller's own state. A note against a Karnataka →
 * Maharashtra sale carries IGST, so the return called it "a sale inside your own state that
 * carries IGST" and would have reported it under Karnataka.
 *
 * The worked note is the full trade check's step 9: 50 KGS of TMT bar at ₹90 = ₹4,500, IGST 18% =
 * ₹810, total ₹5,310. Every name and GST number is synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, quantityFromString, type CompanyId, type Money } from '@invoice/kernel';
import { B2clThresholdTable } from '../src/thresholds.ts';
import { classifyDocument } from '../src/classify.ts';
import { buildGstr1 } from '../src/gstr1.ts';
import { validateDocuments } from '../src/validate.ts';
import { toGstr1Json } from '../src/json-export.ts';
import { returnNoteToDocument, type NoteOriginalFacts, type ReturnNoteLike } from '../src/adapters.ts';
import { taxPeriod } from '../src/types.ts';
import { BENGALURU_KIRANA_GSTIN } from '../src/fixtures.ts';

const COMPANY = asId<'Company'>('00000000-0000-4000-8000-000000000001') as CompanyId;
const OUR_GSTIN = '29AAAAA0000A1ZY';
const PERIOD = taxPeriod('2026-09');
const context = { thresholds: new B2clThresholdTable(), mode: 'development' as const };
const supplier = { gstin: OUR_GSTIN, stateCode: '29' };
const mehta = { name: 'Mehta Construction Supplies', gstin: '27AAACM1234K1ZN', stateCode: '27', unregisteredConfirmed: false };

const rupees = (value: number): Money => ({ currency: 'INR', minor: BigInt(value * 100) });

/** 50 KGS back at ₹90, taxed the way the original bill was: IGST across a state line, else CGST + SGST. */
const noteOf = (split: 'IGST' | 'LOCAL'): ReturnNoteLike => ({
  id: 'note-1', companyId: COMPANY, kind: 'SALES_RETURN', number: 'CN/26-27/0000001',
  documentDate: '2026-09-20', partyId: 'mehta', voucherId: 'v-note-1',
  originalDocument: { number: 'INV/26-27/000004', date: '2026-09-17' },
  lines: [{
    originalLineId: 'l1', itemId: 'tmt12', description: 'TMT Steel Bar 12mm', supplyKind: 'GOODS',
    quantity: quantityFromString('50', 'KGS'), hsnOrSac: '72142090', ratePercentTimes100: 1800n,
    amounts: {
      taxableValue: rupees(4500),
      cgst: rupees(split === 'LOCAL' ? 405 : 0), sgst: rupees(split === 'LOCAL' ? 405 : 0),
      utgst: rupees(0), igst: rupees(split === 'IGST' ? 810 : 0), cess: rupees(0), total: rupees(5310),
    },
  }],
  totals: { total: rupees(5310) },
});

const document = (split: 'IGST' | 'LOCAL', original: NoteOriginalFacts | null, counterparty = mehta) =>
  returnNoteToDocument(noteOf(split), counterparty, supplier, {
    original, hsnByItem: {},
  });

const findingsOf = (doc: ReturnType<typeof document>) =>
  validateDocuments({ period: PERIOD, supplierGstin: OUR_GSTIN, supplierStateCode: '29', documents: [doc] });

const cdnrRow = (doc: ReturnType<typeof document>) =>
  buildGstr1({ period: PERIOD, gstin: OUR_GSTIN, documents: [doc] }, context)
    .return.sections.find((section) => section.id === 'CDNR')?.rows[0];

test('#232 a credit note against a Karnataka → Maharashtra IGST bill is reported under Maharashtra, with no warning', () => {
  const note = document('IGST', { placeOfSupplyStateCode: '27' });
  assert.equal(note.placeOfSupplyStateCode, '27');
  assert.deepEqual(findingsOf(note).filter((f) => f.severity === 'BLOCKING').map((f) => f.code), []);
  assert.equal(classifyDocument(note, context).outcome, 'CLASSIFIED');

  const row = cdnrRow(note);
  assert.equal(row?.placeOfSupplyStateCode, '27');
  assert.equal(row?.amounts.taxableValue.minor, -450_000n);
  assert.equal(row?.amounts.igst.minor, -81_000n);
});

test('#232 a credit note against a bill inside Karnataka is reported under Karnataka', () => {
  const local = { ...mehta, name: 'Nandi Hardware', gstin: BENGALURU_KIRANA_GSTIN, stateCode: '29' };
  const note = document('LOCAL', { placeOfSupplyStateCode: '29' }, local);
  assert.equal(note.placeOfSupplyStateCode, '29');
  assert.deepEqual(findingsOf(note).filter((f) => f.severity === 'BLOCKING').map((f) => f.code), []);
  const row = cdnrRow(note);
  assert.equal(row?.placeOfSupplyStateCode, '29');
  assert.equal(row?.amounts.cgst.minor, -40_500n);
  assert.equal(row?.amounts.sgst.minor, -40_500n);
});

test('#232 a note against a bill shipped to a third state reports that state, not the buyer\'s', () => {
  // Mehta is registered in Maharashtra, but the goods were sent to a site in Gujarat, so the bill's
  // place of supply is Gujarat (24). The note follows the bill, not the GST number.
  const note = document('IGST', { placeOfSupplyStateCode: '24' });
  assert.equal(note.placeOfSupplyStateCode, '24');
  assert.equal(cdnrRow(note)?.placeOfSupplyStateCode, '24');
  assert.deepEqual(findingsOf(note).filter((f) => f.severity === 'BLOCKING').map((f) => f.code), []);
});

test('#232 a note whose original bill cannot be found is a question, not our own state', () => {
  const note = document('IGST', null);
  assert.equal(note.placeOfSupplyStateCode, null, 'never defaulted to the seller\'s state');
  const decision = classifyDocument(note, context);
  assert.equal(decision.outcome, 'UNRESOLVED');
  const [question] = decision.findings;
  assert.equal(question?.code, 'GSTR1_NOTE_ORIGINAL_MISSING');
  assert.equal(question?.severity, 'BLOCKING');
  assert.match(question?.message['en-IN'] ?? '', /INV\/26-27\/000004/);
  // It is not also reported as "a local sale carrying IGST": that check needs a state to compare.
  assert.equal(findingsOf(note).some((f) => f.code === 'GSTR1_SPLIT_SHOULD_BE_LOCAL'), false);
});

test('#232 the "inside your own state but carries IGST" check still catches a wrong note', () => {
  // The check was right; its input was wrong. A note whose original bill was local but which carries
  // IGST is still refused.
  const wrong = document('IGST', { placeOfSupplyStateCode: '29' });
  assert.equal(findingsOf(wrong).some((f) => f.code === 'GSTR1_SPLIT_SHOULD_BE_LOCAL' && f.severity === 'BLOCKING'), true);
});


test('#232 the government file carries the note under Maharashtra, at 18%, with its code in the summary', () => {
  // The rate and code come from the note itself, copied from the original bill when it was posted.
  // Without them the file carried the note at 0% with ₹810 of IGST on it.
  const note = document('IGST', { placeOfSupplyStateCode: '27' });
  const built = buildGstr1({ period: PERIOD, gstin: OUR_GSTIN, documents: [note] }, context);
  const file = toGstr1Json(built.return);
  const cdnr = file['cdnr'] as { ctin: string; nt: { nt_num: string; pos: string; val: number; itms: { itm_det: { rt: number; txval: number; iamt: number } }[] }[] }[];
  assert.equal(cdnr[0]?.ctin, '27AAACM1234K1ZN');
  assert.equal(cdnr[0]?.nt[0]?.pos, '27');
  assert.equal(cdnr[0]?.nt[0]?.val, 5310);
  assert.deepEqual(cdnr[0]?.nt[0]?.itms[0]?.itm_det, { rt: 18, txval: 4500, iamt: 810, camt: 0, samt: 0, csamt: 0 });
  const hsn = built.return.hsn.find((row) => row.hsnOrSac === '72142090');
  assert.equal(hsn?.ratePercentTimes100, 1800n);
  assert.equal(hsn?.amounts.igst.minor, -81_000n);
});
