/**
 * Issue #186 — goods sent back to a supplier print as a "Debit Note", addressed to the supplier and
 * against the supplier's own invoice number and date.
 *
 * The supplier's bill: 500 kg of steel at ₹64 a kilo, 18% IGST, bill SRS/2026/0042 of 21 July 2026.
 * 100 kg go back on 30 August 2026:
 *
 *   taxable value: 100 × ₹64       = ₹6,400.00
 *   IGST 18%:      18% of ₹6,400   = ₹1,152.00
 *   total:         6,400 + 1,152    = ₹7,552.00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, quantityFromString } from '@invoice/kernel';
import { captureSnapshot, renderCreditNote, templateById, toCreditNoteDocument, type TemplateDefinition } from '@invoice/invoice-templates';
import { makeBusiness, purchase } from './harness.ts';

const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

test('a purchase return prints as a Debit Note against the supplier invoice', async () => {
  const shop = await makeBusiness();
  const { bill } = await shop.posting.post(shop.actor, purchase({ id: 'dn-buy', sourceDocumentId: 'dn-src' }), 'dn:purchase');
  const { note } = await shop.returns.postPurchase(shop.actor, {
    idempotencyKey: 'dn:return', originalBillId: bill.id, documentDate: isoDate('2026-08-30'),
    reason: 'Bent bars sent back.',
    lines: [{ originalLineId: '1', quantity: quantityFromString('100', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  });
  assert.match(note.number, /^DN\/26-27\/\d{7}$/);
  assert.equal(note.lines[0]?.ratePercentTimes100, 1800n, 'the rate read back from what the supplier charged');

  const document = toCreditNoteDocument(note, {
    counterparty: { name: 'Shree Ram Steels Private Limited', addressLines: [], gstin: null, stateCode: '', stateName: '' },
    placeOfSupplyStateCode: null,
    placeOfSupplyStateName: null,
  }, { seller: { name: 'Bengaluru Steel Traders', addressLines: ['14, Rajajinagar Industrial Estate'], gstin: '29AAAAA0000A1ZY', stateCode: '29', stateName: 'Karnataka' } });
  const visible = text(renderCreditNote(document, captureSnapshot(templateById('india-standard') as TemplateDefinition, 'en-IN', '2026-08-30'), { format: 'A4', locale: 'en-IN' }));

  assert.ok(visible.includes('Debit Note'), 'the title');
  assert.ok(!visible.includes('Credit Note'), 'never called a credit note');
  assert.ok(visible.includes('Against Supplier Invoice No. SRS/2026/0042 dated 21 July 2026'));
  assert.ok(visible.includes('Supplier') && visible.includes('Shree Ram Steels Private Limited'));
  assert.ok(visible.includes('6,400.00'));
  assert.match(visible, /IGST ₹1,152\.00/);
  assert.match(visible, /Total Debited ₹7,552\.00/);
  assert.ok(!visible.includes('()'), 'no empty state brackets for a supplier whose state is not known');
});
