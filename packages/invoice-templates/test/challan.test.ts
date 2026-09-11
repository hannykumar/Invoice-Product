/**
 * Issue #141 — the delivery challan prints on the same engine, marked clearly as a delivery challan
 * and not a tax invoice, with every particular CGST Rule 55 asks for and nothing that belongs only
 * on a bill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate } from '@invoice/kernel';
import type { DeliveryChallan } from '@invoice/sales';
import { templateById, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderChallan, renderChallanCopies, renderChallanCopySet, renderInvoice } from '../src/render.ts';
import { CHALLAN_MANDATORY_FIELDS, deliveryNoteFromChallans, toChallanDocument, type ChallanPrintingContext } from '../src/challan.ts';
import { toInvoiceDocument } from '../src/from-sales.ts';
import { GURUGRAM, on } from '../../sales/test/fixtures.ts';
import { crateChallan, makeDispatchDesk } from '../../sales/test/challan-fixtures.ts';

const india = templateById('india-standard') as TemplateDefinition;
const snapshot = captureSnapshot(india, 'en-IN', '2026-09-11');

const context = (overrides: Partial<ChallanPrintingContext> = {}): ChallanPrintingContext => ({
  consigner: {
    name: 'Sharma Fruit Traders',
    addressLines: ['12/4, Ajmal Khan Road', 'Karol Bagh, New Delhi 110005'],
    gstin: '07AAAAA0000A1Z4',
    stateCode: '07',
    stateName: 'Delhi',
  },
  consignee: {
    name: 'ABC Traders',
    addressLines: ['Shop 8, Azadpur Mandi', 'New Delhi 110033'],
    gstin: '07DDDDD3333D1ZV',
    stateCode: '07',
    stateName: 'Delhi',
  },
  ...overrides,
});

const issue = async (key: string, input = crateChallan()): Promise<DeliveryChallan> => {
  const desk = await makeDispatchDesk();
  return desk.challans.issue(desk.actor, { idempotencyKey: key, input });
};

/** The visible text, with tags stripped, so an assertion about a word is about what a person reads. */
const text = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the page says what it is: a delivery challan, not a tax invoice', async () => {
  const html = renderChallan(toChallanDocument(await issue('t1'), context()), snapshot, { format: 'A4', locale: 'en-IN' });
  const visible = text(html);
  assert.match(visible, /Delivery Challan/);
  assert.match(visible, /Not a tax invoice/);
  assert.doesNotMatch(visible, /Tax Invoice/, 'the invoice title never appears on a challan');
  assert.match(html, /<title>Delivery Challan DC\/26-27\/00001<\/title>/);
  assert.match(html, /data-template="india-standard@/, 'the same engine and stamp as the invoice');
});

test('nothing that belongs only on a bill is printed on a challan', async () => {
  const html = renderChallan(toChallanDocument(await issue('t2', crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW' })), context()), snapshot, { format: 'A4', locale: 'en-IN' });
  const visible = text(html);
  for (const billOnly of ['Amount Chargeable', 'Balance Due', 'Due Date', 'Bank Details', 'Round Off', 'HSN / SAC Summary', 'IRN', 'Pay by scan', 'Government QR']) {
    assert.ok(!visible.includes(billOnly), `a challan must not carry "${billOnly}"`);
  }
});

test('every Rule 55(1) particular is on a job-work challan, and no tax is', async () => {
  const html = renderChallan(toChallanDocument(await issue('t3'), context()), snapshot, { format: 'A4', locale: 'en-IN' });
  const visible = text(html);
  const present: Record<string, boolean> = {
    'challan.number': visible.includes('Challan No.') && visible.includes('DC/26-27/00001'),
    'challan.date': visible.includes('Challan Date') && visible.includes('10 May 2026'),
    'consigner.nameAddressGstin': visible.includes('Sharma Fruit Traders') && visible.includes('Ajmal Khan Road') && visible.includes('07AAAAA0000A1Z4'),
    'consignee.nameAddressGstin': visible.includes('Consignee') && visible.includes('ABC Traders') && visible.includes('Azadpur Mandi') && visible.includes('07DDDDD3333D1ZV'),
    'line.hsnAndDescription': visible.includes('Plastic crate') && visible.includes('3923'),
    'line.quantity': / 40 PCS /.test(visible),
    'line.taxableValue': visible.includes('Taxable Value') && visible.includes('8,400.00'),
    // Not required: goods sent for job work are not moving as a sale.
    'line.taxRateAndAmount': true,
    // Not required: Delhi to Delhi.
    placeOfSupply: true,
    signature: visible.includes('Authorised Signatory') && html.includes('data-reserved="signature"'),
  };
  for (const field of CHALLAN_MANDATORY_FIELDS) assert.ok(present[field.id], `${field.id} (${field.clause}) is missing`);

  assert.ok(!visible.includes('Tax Rate'), 'no tax rate on a job-work challan');
  assert.ok(!/(CGST|SGST|IGST|Cess) ₹/.test(visible), 'no tax amounts on a job-work challan');
  assert.match(visible, /Job work \(CGST Rule 55\(1\)\(b\)\)/, 'the reason, with the rule that allows it');
});

test('a sale challan prints the tax rate, the tax amount and the place of supply', async () => {
  const challan = await issue('t4', crateChallan({ partyId: GURUGRAM, reason: 'SUPPLY_INVOICE_TO_FOLLOW' }));
  const visible = text(
    renderChallan(toChallanDocument(challan, context({ placeOfSupplyStateName: 'Haryana' })), snapshot, { format: 'A4', locale: 'en-IN' }),
  );
  assert.match(visible, /Tax Rate/);
  assert.match(visible, / 18% /);
  assert.match(visible, /IGST ₹1,512\.00/);
  assert.match(visible, /Place of Supply Haryana \(06\)/);
});

test('a quantity not known at dispatch is marked provisional', async () => {
  const visible = text(renderChallan(toChallanDocument(await issue('t5', crateChallan({ reason: 'LIQUID_GAS' })), context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  assert.match(visible, /40 \(provisional\) PCS/);
});

test('three copies, marked in the words of Rule 55(2), separately and together', async () => {
  const doc = toChallanDocument(await issue('t6'), context());
  const set = renderChallanCopySet(doc, snapshot, { format: 'A4', locale: 'en-IN' });
  assert.deepEqual(set.map((c) => c.marking), ['ORIGINAL FOR CONSIGNEE', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR CONSIGNER']);
  const together = renderChallanCopies(doc, snapshot, { format: 'A4', locale: 'en-IN' });
  assert.equal((together.match(/class="sheet"/g) ?? []).length, 3);
  assert.equal((together.match(/<html/g) ?? []).length, 1, 'one document, one press of Print');
});

test('the e-way bill prints on the challan', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 't7', input: crateChallan() });
  const withEway = await desk.challans.attachEwayBill(desk.actor, {
    challanId: challan.id,
    ewayBillNumber: '321001234567',
    transporter: 'Sharma Roadlines',
    vehicleNumber: 'DL01AB1234',
    source: 'TYPED',
  });
  const visible = text(renderChallan(toChallanDocument(withEway, context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  assert.match(visible, /e-Way Bill No\. 321001234567/);
  assert.match(visible, /Vehicle No\. DL01AB1234/);
  assert.match(visible, /Dispatched through Sharma Roadlines/);
});

test('the invoice raised later names the challan in its Delivery Note box', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 't8', input: crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW' }) });
  const draft = await desk.till.service.createDraft(desk.till.actor, {
    idempotencyKey: 'inv-t8',
    input: { partyId: challan.partyId, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-05-12'), lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: challan.lines[0]!.quantity, unitPrice: challan.lines[0]!.unitPrice, priceBasis: 'EXCLUSIVE' }] },
  });
  const invoice = (await desk.till.service.finalise(desk.till.actor, { idempotencyKey: 'fin-t8', invoiceId: draft.id })).invoice;
  const linked = await desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: invoice.id });
  assert.match(
    text(renderChallan(toChallanDocument(linked, context()), snapshot, { format: 'A4', locale: 'en-IN' })),
    /Invoice No\. &amp; Date INV\/KB\/2026-27\/00001, 12 May 2026/,
    'the challan names the invoice that followed it',
  );

  const references = deliveryNoteFromChallans(await desk.challans.forInvoice(desk.actor, invoice.id));
  assert.deepEqual(references, { deliveryNoteNumber: 'DC/26-27/00001', deliveryNoteDate: isoDate('2026-05-10') });
  const bill = text(
    renderInvoice(
      toInvoiceDocument(invoice, { title: 'TAX_INVOICE', seller: context().consigner, buyer: context().consignee, placeOfSupplyStateName: 'Delhi', references }),
      snapshot,
      { format: 'A4', locale: 'en-IN' },
    ),
  );
  assert.match(bill, /Delivery Note DC\/26-27\/00001/);
  assert.match(bill, /Delivery Note Date 10 May 2026/);

  // Several challans on one invoice list every number; a cancelled one is left off.
  assert.deepEqual(
    deliveryNoteFromChallans([
      { number: 'DC/26-27/00001', documentDate: isoDate('2026-05-10'), state: 'INVOICED' },
      { number: 'DC/26-27/00002', documentDate: isoDate('2026-05-11'), state: 'INVOICED' },
      { number: 'DC/26-27/00003', documentDate: isoDate('2026-05-11'), state: 'CANCELLED' },
    ]),
    { deliveryNoteNumber: 'DC/26-27/00001, DC/26-27/00002', deliveryNoteDate: null },
  );
});

test('a cancelled challan says so when reprinted', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 't9', input: crateChallan() });
  const cancelled = await desk.challans.cancel(desk.actor, { challanId: challan.id, reason: 'Lorry did not come' });
  assert.match(text(renderChallan(toChallanDocument(cancelled, context()), snapshot, { format: 'A4', locale: 'en-IN' })), /CANCELLED/);
});

test('every shape prints, in Hindi too, and a typed name cannot break the page', async () => {
  const doc = toChallanDocument(await issue('t10'), context({ consignee: { ...context().consignee, name: '<script>alert(1)</script>' } }));
  for (const format of ['A4', 'MOBILE', 'THERMAL_80MM', 'THERMAL_58MM'] as const) {
    for (const locale of ['en-IN', 'hi-IN'] as const) {
      const html = renderChallan(doc, snapshot, { format, locale });
      assert.ok(!html.includes('<script>alert'), `${format}/${locale} escapes what a person typed`);
      assert.match(text(html), locale === 'hi-IN' ? /Yeh tax invoice nahin hai/ : /Not a tax invoice/);
      // Rule 55(1)(ix): the signature is on every shape, till roll included.
      assert.match(text(html), locale === 'hi-IN' ? /Adhikrit hastakshar/ : /Authorised Signatory/, `${format}/${locale} carries the signature`);
    }
  }
});
