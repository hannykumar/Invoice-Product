/**
 * Issue #293 — a discount on the sale itself, and a price changed after the sale without pretending
 * goods came back.
 *
 * Mehta Steel (Pune, so IGST 18%) was last charged ₹90 a kg for TMT bar. Every figure is worked here:
 *   10 kg × ₹90 = ₹900; 5% off = ₹45; taxable ₹855; IGST ₹153.90; ₹1,008.90, rounded to a bill of ₹1,009.
 *   Re-priced to ₹85: 10 × ₹5 = ₹50 off, IGST ₹9 → credit note ₹59. Then to ₹95: 10 × ₹10 = ₹100
 *   more, IGST ₹18 → debit note ₹118.
 * Every name and GST number is synthetic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { appToday, useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = appToday();

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(Buffer.isBuffer(response.body) ? '{}' : String(response.body)) as Record<string, any> };
};
const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

const setUp = (() => {
  let done: Promise<{ owner: string; customerId: string; serviceId: string }> | null = null;
  return () => done ??= (async () => {
    const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
    const bought = await request('POST', '/api/purchases/record', {
      supplierId: SHREE_RAM, reference: 'SRS-293', date: DATE,
      lines: [{ item: 'TMT Steel Bar 12mm', quantity: '3000', rate: '50', gst: '1800' }],
    }, owner);
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    const added = await request('POST', '/api/customers', {
      legalName: 'Mehta Steel Traders', registration: 'regular', gstin: '27AAPFU0939F1ZV', line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
    }, owner);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const customerId = String(added.body.customer.id);
    const first = await request('POST', '/api/sales/record', sale(customerId, 'mehta-293-first'), owner);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const service = await request('POST', '/api/items', { name: 'Bar cutting service', kind: 'service', hsnSac: '998898', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' }, owner);
    assert.equal(service.status, 200, JSON.stringify(service.body));
    return { owner, customerId, serviceId: String(service.body.item.id) };
  })();
})();

const sale = (customerId: string, requestId: string, more: Record<string, unknown> = {}) => ({
  customerId, item: 'TMT Steel Bar 12mm', quantity: '10', rate: '90', date: DATE, terms: '30', requestId, ...more,
});

const lineOf = async (session: string, invoiceId: string) => {
  const documents = (await request('GET', '/api/returns/documents', {}, session)).body.documents as Record<string, any>[];
  return documents.find((document) => document.id === invoiceId)!.lines[0] as { id: string; rate: number; returned: number };
};

test('#293: a line discount, in rupees or as a percentage, comes off before GST', async () => {
  const { owner, customerId } = await setUp();
  const plain = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-293-plain'), owner);
  assert.equal(plain.body.amount, 1062, JSON.stringify(plain.body));
  for (const discount of [{ discountPercent: '5' }, { discount: '45' }, { lines: [{ item: 'TMT Steel Bar 12mm', quantity: '10', rate: '90', discountPercent: '5' }] }, { billDiscount: '45' }]) {
    const checked = await request('POST', '/api/sales/preview', sale(customerId, `mehta-293-${JSON.stringify(discount).length}`, discount), owner);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.amount, 1009, `${JSON.stringify(discount)}: ₹855 + IGST ₹153.90, rounded to the rupee`);
  }
});

test('#293: a wrong discount is refused, and nothing is saved', async () => {
  const { owner, customerId } = await setUp();
  const both = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-293-both', { discount: '10', discountPercent: '5' }), owner);
  assert.equal(both.body.code, 'SALE_DISCOUNT_TWICE');
  const over = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-293-over', { discount: '901' }), owner);
  assert.equal(over.body.code, 'SALE_DISCOUNT_TOO_LARGE');
  const percent = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-293-pct', { discountPercent: '101' }), owner);
  assert.equal(percent.body.code, 'SALE_DISCOUNT_TOO_LARGE');
  const bill = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-293-bill', { billDiscount: '901' }), owner);
  assert.equal(bill.body.code, 'SALE_BILL_DISCOUNT_TOO_LARGE');
});

test('#293: a discount past the limit needs #11 approval, like a lowered rate', async () => {
  const { owner, customerId } = await setUp();
  const checked = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-293-big', { discountPercent: '30' }), owner);
  assert.equal(checked.body.terms.outcome, 'NEEDS_APPROVAL', JSON.stringify(checked.body.terms));
  const refused = await request('POST', '/api/sales/record', sale(customerId, 'mehta-293-big', { discountPercent: '30' }), owner);
  assert.equal(refused.body.code, 'SALE_APPROVAL_REQUIRED', JSON.stringify(refused.body));
  const approved = await request('POST', '/api/sales/record', sale(customerId, 'mehta-293-big', { discountPercent: '30', approvalReason: 'Old stock, cleared at 30% off.' }), owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

test('#293: the printed bill shows the discount in its Discount column', async () => {
  const { owner, customerId } = await setUp();
  const sold = await request('POST', '/api/sales/record', sale(customerId, 'mehta-293-print', { discount: '45' }), owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const printed = await request('POST', '/api/sales/print', { invoice: sold.body.invoice.id }, owner);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  const visible = text(String(printed.body.html));
  assert.ok(visible.includes('Discount'), 'the column');
  assert.ok(visible.includes('45.00'), 'the ₹45 off, on the line');
  assert.ok(visible.includes('855.00'), 'the taxable value after it');
});

test('#293: a lower price after the sale is a credit note, a higher one a debit note; no goods move, and both go to GSTR-1', async () => {
  const { owner, customerId } = await setUp();
  const sold = await request('POST', '/api/sales/record', sale(customerId, 'mehta-293-reprice'), owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const invoice = sold.body.invoice as { id: string; number: string };
  const line = await lineOf(owner, invoice.id);
  assert.equal(line.rate, 90);
  const correction = (reference: string, more: Record<string, unknown>) => ({
    mode: 'PRICE', cause: 'INVOICE_ERROR', kind: 'SALES_RETURN', documentId: invoice.id, lineId: line.id, date: DATE, reference, reason: 'Rate agreed on the phone was different.', ...more,
  });

  const looked = await request('POST', '/api/returns/preview', correction('mehta-293-cn', { newRate: '85' }), owner);
  assert.equal(looked.status, 200, JSON.stringify(looked.body));
  assert.equal(looked.body.amount, 59);
  assert.equal(looked.body.noteKind, 'SALES_RETURN');
  assert.ok((looked.body.effects as string[]).some((effect) => /only the price changes/.test(effect)));
  assert.ok(!(looked.body.effects as string[]).some((effect) => /back into stock/.test(effect)));

  const credit = await request('POST', '/api/returns/record', correction('mehta-293-cn', { newRate: '85' }), owner);
  assert.equal(credit.status, 200, JSON.stringify(credit.body));
  assert.match(credit.body.note.number, /^CN\//);
  assert.equal(credit.body.note.priceCorrection, true);
  const retried = await request('POST', '/api/returns/record', correction('mehta-293-cn', { newRate: '85' }), owner);
  assert.equal(retried.body.deduplicated, true);
  assert.equal(retried.body.note.id, credit.body.note.id);
  assert.equal((await lineOf(owner, invoice.id)).returned, 0, 'nothing came back');

  const debit = await request('POST', '/api/returns/record', correction('mehta-293-dn', { newRate: '95' }), owner);
  assert.equal(debit.status, 200, JSON.stringify(debit.body));
  assert.equal(debit.body.note.kind, 'SALES_DEBIT_NOTE');
  assert.match(debit.body.note.number, /^DN\//);
  assert.equal(debit.body.note.amount, 118);

  const printed = text(String((await request('POST', '/api/returns/print', { note: debit.body.note.id }, owner)).body.html));
  assert.ok(printed.includes('Debit Note') && printed.includes(`Against Invoice No. ${invoice.number}`), printed.slice(0, 400));

  const workspace = (await request('POST', '/api/gst-returns', { period: DATE.slice(0, 7) }, owner)).body;
  const cdnr = (workspace.sections as Record<string, any>[]).find((section) => section.id === 'CDNR');
  const labels = ((cdnr?.rows ?? []) as Record<string, any>[]).map((row) => row.label);
  assert.ok(labels.includes(credit.body.note.number), `credit note in CDNR: ${labels.join(', ')}`);
  assert.ok(labels.includes(debit.body.note.number), `debit note in CDNR: ${labels.join(', ')}`);

  const wrong = await request('POST', '/api/returns/preview', correction('mehta-293-wrong', { newRate: '95', amountOff: '5' }), owner);
  assert.equal(wrong.body.code, 'PRICE_CORRECTION_ONE_FIGURE');
  const same = await request('POST', '/api/returns/preview', correction('mehta-293-same', { newRate: '95' }), owner);
  assert.equal(same.body.code, 'PRICE_CORRECTION_NO_CHANGE');
  const afterSale = await request('POST', '/api/returns/record', correction('mehta-293-after', { cause: 'DISCOUNT_AFTER_SALE', newRate: '80' }), owner);
  assert.equal(afterSale.body.code, 'PRICE_CORRECTION_DISCOUNT_AFTER_SALE');
  const noCause = await request('POST', '/api/returns/preview', correction('mehta-293-nocause', { cause: '', newRate: '80' }), owner);
  assert.equal(noCause.body.code, 'PRICE_CORRECTION_CAUSE_REQUIRED');
  const supplier = await request('POST', '/api/returns/preview', correction('mehta-293-supplier', { kind: 'PURCHASE_RETURN', newRate: '80' }), owner);
  assert.equal(supplier.body.code, 'PRICE_CORRECTION_SALES_ONLY');
});

test('#293: a return on a service line never talks about stock', async () => {
  const { owner, customerId, serviceId } = await setUp();
  const sold = await request('POST', '/api/sales/record', { customerId, lines: [{ itemId: serviceId, quantity: '2', rate: '500' }], date: DATE, terms: '30', requestId: 'mehta-293-service' }, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const line = await lineOf(owner, sold.body.invoice.id);
  const preview = await request('POST', '/api/returns/preview', {
    kind: 'SALES_RETURN', documentId: sold.body.invoice.id, lineId: line.id, quantity: '1', unit: 'NOS', disposition: 'ACCEPTED',
    date: DATE, reference: 'mehta-293-service-back', reason: 'One cut was not done.',
  }, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.stockMoves, false);
  assert.ok(!(preview.body.effects as string[]).some((effect) => /stock\./.test(effect) && /back into/.test(effect)), (preview.body.effects as string[]).join(' | '));
});

test('#293: someone who may not record returns cannot correct a price', async () => {
  const { customerId } = await setUp();
  const counter = await signInAs('counter@sampoorna.example.invalid', SAMPOORNA);
  const refused = await request('POST', '/api/returns/preview', { mode: 'PRICE', documentId: 'x', lineId: 'line-1', newRate: '1', date: DATE, reason: 'r', customerId }, counter);
  assert.ok([403, 404].includes(refused.status), JSON.stringify(refused.body));
});
