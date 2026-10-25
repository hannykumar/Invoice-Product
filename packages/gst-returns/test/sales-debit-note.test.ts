/**
 * Issue #293 — a debit note to a customer who was under-charged (CGST Act s.34(3)) goes on GSTR-1
 * with the credit notes, against the same bill, as note type "D"; a price correction moves no goods,
 * so the HSN summary counts no quantity for it.
 *
 * The note: 10 KGS of TMT bar re-priced from ₹90 to ₹95 = ₹50 more, IGST 18% = ₹9, total ₹59.
 * Every name and GST number is synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, quantityFromString, type CompanyId, type Money } from '@invoice/kernel';
import { B2clThresholdTable } from '../src/thresholds.ts';
import { buildGstr1 } from '../src/gstr1.ts';
import { toGstr1Json } from '../src/json-export.ts';
import { returnNoteToDocument, type ReturnNoteLike } from '../src/adapters.ts';
import { taxPeriod } from '../src/types.ts';

const COMPANY = asId<'Company'>('00000000-0000-4000-8000-000000000001') as CompanyId;
const OUR_GSTIN = '29AAAAA0000A1ZY';
const PERIOD = taxPeriod('2026-09');
const context = { thresholds: new B2clThresholdTable(), mode: 'development' as const };
const supplier = { gstin: OUR_GSTIN, stateCode: '29' };
const mehta = { name: 'Mehta Construction Supplies', gstin: '27AAACM1234K1ZN', stateCode: '27', unregisteredConfirmed: false };
const paise = (value: bigint): Money => ({ currency: 'INR', minor: value });

const note = (kind: 'SALES_RETURN' | 'SALES_DEBIT_NOTE' | 'PURCHASE_RETURN', priceCorrection = true): ReturnNoteLike => ({
  id: `note-${kind}`, companyId: COMPANY, kind, number: kind === 'SALES_RETURN' ? 'CN/26-27/0000002' : 'DN/26-27/0000001',
  documentDate: '2026-09-22', partyId: 'mehta', voucherId: `v-${kind}`,
  originalDocument: { number: 'INV/26-27/000004', date: '2026-09-17' },
  lines: [{
    originalLineId: 'l1', itemId: 'tmt12', description: 'TMT Steel Bar 12mm', supplyKind: 'GOODS',
    quantity: quantityFromString('10', 'KGS'), hsnOrSac: '72142090', ratePercentTimes100: 1800n,
    amounts: { taxableValue: paise(5000n), cgst: paise(0n), sgst: paise(0n), utgst: paise(0n), igst: paise(900n), cess: paise(0n), total: paise(5900n) },
  }],
  totals: { total: paise(5900n) },
  ...(priceCorrection ? { priceCorrection: true } : {}),
});
const facts = { original: { placeOfSupplyStateCode: '27' }, hsnByItem: {} };

test('#293: a sales debit note is a DEBIT_NOTE against its bill, listed in CDNR and exported as type D', () => {
  const doc = returnNoteToDocument(note('SALES_DEBIT_NOTE'), mehta, supplier, facts);
  assert.equal(doc.kind, 'DEBIT_NOTE');
  assert.equal(doc.sourceKind, 'debit_note');
  assert.equal(doc.originalDocument?.number, 'INV/26-27/000004');
  const built = buildGstr1({ period: PERIOD, gstin: OUR_GSTIN, documents: [doc] }, context);
  const row = built.return.sections.find((section) => section.id === 'CDNR')?.rows[0];
  assert.ok(row, 'the debit note is in CDNR');
  const json = JSON.stringify(toGstr1Json(built.return), (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  assert.match(json, /"ntty":"D"/);
});

test('#293: a price correction reports no quantity in the HSN summary; a goods return still does', () => {
  assert.equal(returnNoteToDocument(note('SALES_RETURN'), mehta, supplier, facts).lines[0]?.quantity, '0');
  assert.notEqual(returnNoteToDocument(note('SALES_RETURN', false), mehta, supplier, facts).lines[0]?.quantity, '0');
});

test('#293: a purchase return is still refused on GSTR-1', () => {
  assert.throws(() => returnNoteToDocument(note('PURCHASE_RETURN', false), mehta, supplier, facts), /purchase return/);
});
