/**
 * Issue #296 — a composition dealer's bill of supply: the Rule 5 words at the top, the title
 * "Bill of Supply", and no GST anywhere on the paper — on every design and every paper size.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnoverAnsweredEveryYear } from '../../masters/src/fixtures.ts';
import { COMPOSITION_LEGEND } from '../../gst-returns/src/composition.ts';
import { ABC, inr, makeTill, on, qty } from '../../sales/test/fixtures.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { SHIPPED_TEMPLATES } from '../src/template.ts';
import { toInvoiceDocument } from '../src/from-sales.ts';
import { MANDATORY_FIELDS } from '../src/mandatory.ts';

const SELLER = { name: 'Sharma Fruit Traders', addressLines: ['Karol Bagh, New Delhi 110005'], gstin: '07AAAAA0000A1Z4', stateCode: '07', stateName: 'Delhi' };
const BUYER = { name: 'ABC Traders', addressLines: ['Shop 8, Azadpur Mandi'], gstin: '07DDDDD3333D1ZV', stateCode: '07', stateName: 'Delhi' };

const issue = async (registration: 'COMPOSITION' | 'REGULAR') => {
  const till = await makeTill();
  till.masterData.putCompany({ companyId: till.actor.companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration, turnoverAbove5Crore: turnoverAnsweredEveryYear('NO') });
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: `bos-${registration}`,
    input: { partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-04-10'), lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('10', 'PCS'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }] },
  });
  const final = await till.service.finalise(till.actor, { idempotencyKey: `bos-f-${registration}`, invoiceId: draft.id });
  return final.invoice;
};

const pages = (invoice: Awaited<ReturnType<typeof issue>>, composition: boolean) =>
  SHIPPED_TEMPLATES.flatMap((template) =>
    (['A4', 'THERMAL_80MM', 'THERMAL_58MM'] as const).map((format) => ({
      where: `${template.id}/${format}`,
      html: renderInvoice(
        toInvoiceDocument(invoice, { title: composition ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE', seller: SELLER, buyer: BUYER, placeOfSupplyStateName: 'Delhi', compositionLegend: composition ? COMPOSITION_LEGEND : null }),
        captureSnapshot(template, 'en-IN', '2026-04-10'), { format, locale: 'en-IN' }),
    })));

test('a composition bill prints the Rule 5 words, the title and the number, and no GST on every design and paper', async () => {
  const invoice = await issue('COMPOSITION');
  assert.match(invoice.number!, /^BOS\//);
  for (const { where, html } of pages(invoice, true)) {
    assert.ok(html.includes(COMPOSITION_LEGEND), `${where}: the legend`);
    assert.ok(html.includes('Bill of Supply'), `${where}: the title`);
    assert.ok(!html.includes('Tax Invoice'), `${where}: it is not a tax invoice`);
    assert.ok(html.includes(invoice.number!), `${where}: the number`);
    for (const forbidden of ['CGST', 'SGST', 'IGST', 'Tax Rate', 'Tax Amount', 'Total Taxable Value']) {
      assert.ok(!html.includes(forbidden), `${where}: must not show "${forbidden}"`);
    }
    const body = html.slice(html.indexOf('<body'));
    assert.ok(body.indexOf(COMPOSITION_LEGEND) < body.indexOf(invoice.number!), `${where}: the words are at the top, above the number`);
  }
});

test('an ordinary tax invoice still shows its GST and has no composition words', async () => {
  const invoice = await issue('REGULAR');
  assert.match(invoice.number!, /^INV\//);
  for (const { where, html } of pages(invoice, false)) {
    assert.ok(!html.includes(COMPOSITION_LEGEND), `${where}: no legend on a tax invoice`);
    assert.ok(html.includes('CGST') || html.includes('GST'), `${where}: tax still shown`);
  }
});

test('the amount in words and the total are still there', async () => {
  const html = pages(await issue('COMPOSITION'), true)[0]!.html;
  assert.ok(html.includes('10,000.00'));
  assert.ok(/Ten Thousand/i.test(html));
  assert.ok(MANDATORY_FIELDS.length > 0);
});
