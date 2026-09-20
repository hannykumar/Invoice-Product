/**
 * Issue #191 — the page the driver is handed at a checkpoint.
 *
 * Every figure below is the one the portal answered with, or one the business itself recorded. The
 * last test is the important one: the provider gives us no QR content, so the page must carry no QR
 * at all rather than a square of our own making on a government document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { templateById, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderEwayBill } from '../src/render.ts';
import { ewayPrintBanner } from '../src/eway.ts';
import { interStateMovement, lorry, makeEwayDesk } from '../../transport/src/fixtures.ts';
import type { EwayBillRecord, Movement } from '../../transport/src/types.ts';

const snapshot = captureSnapshot(templateById('india-standard') as TemplateDefinition, 'en-IN', '2026-09-11');

/** Bengaluru → Pune, ₹94,400 of steel, raised against the synthetic portal. */
const raise = async (movement: Movement = interStateMovement({ vehicle: lorry() })): Promise<{ record: EwayBillRecord; movement: Movement; desk: ReturnType<typeof makeEwayDesk> }> => {
  const desk = makeEwayDesk();
  const record = await desk.service.generate(desk.actor, movement);
  return { record, movement, desk };
};

test('an active e-way bill prints all five of the portal sections', async () => {
  const { record, movement } = await raise();
  const html = renderEwayBill(record, movement, { snapshot });

  assert.match(html, /E-way Bill Details/);
  assert.match(html, /Address Details/);
  assert.match(html, /Goods Details/);
  assert.match(html, /Transportation Details/);
  assert.match(html, /Vehicle Details/);

  assert.match(record.acknowledgement?.ewayBillNumber ?? '', /^\d{12}$/);
  assert.ok(html.includes(record.acknowledgement?.ewayBillNumber ?? 'missing'));
  assert.match(html, /Valid Upto/);
  assert.match(html, /Mode/);
  assert.ok(html.includes('Road'));
  assert.ok(html.includes('840 km'));
  assert.ok(html.includes('Outward-Supply'));
  assert.ok(html.includes('Tax invoice-SAM/2026/0117-21/08/2026'));
  assert.ok(html.includes(movement.consignor.gstin), 'the From GSTIN');
  assert.ok(html.includes(movement.billTo.gstin), 'the To GSTIN');
  assert.ok(html.includes('560058'), 'the dispatch PIN code');
  assert.ok(html.includes('411030'), 'the ship-to PIN code');
  assert.ok(html.includes('72142090'), 'the HSN code');
  assert.ok(html.includes('2000 KGS'), 'the quantity with its unit');
  assert.ok(html.includes('0.00+0.00+18.00+0.00+0.00'), 'the C+S+I+Cess+Cess Non.Advol column');
  assert.ok(html.includes('94400.00'), 'the total invoice amount');
  assert.ok(html.includes('KA01AB1234'), 'the vehicle row');
  assert.ok(html.includes('Regular'), 'the transaction type');
});

test('a bill with no vehicle yet says so across the page, and still prints', async () => {
  const { record, movement } = await raise(interStateMovement());

  assert.equal(record.status, 'PART_A_ONLY');
  assert.equal(ewayPrintBanner(record)?.kind, 'WARNING');
  const html = renderEwayBill(record, movement, { snapshot });
  assert.ok(html.includes('PART-B NOT ENTERED — the goods may not move on this e-way bill yet'));
  assert.ok(html.includes('No vehicle has been entered on this e-way bill.'));
});

test('a cancelled bill prints, marked cancelled, because the paper still exists', async () => {
  const { record, movement, desk } = await raise();
  const cancelled = await desk.service.cancel(desk.actor, movement.movementId, { reasonCode: 'ORDER_CANCELLED', reason: 'The buyer called it off.' });

  assert.equal(cancelled.status, 'CANCELLED');
  const html = renderEwayBill(cancelled, movement, { snapshot });
  assert.match(html, /CANCELLED on \d{2}\/\d{2}\/\d{4}/);
});

test('a bill the portal never answered for cannot be printed at all', () => {
  const failed = { status: 'FAILED', vehicleLegs: [] } as unknown as EwayBillRecord;

  const banner = ewayPrintBanner(failed);

  assert.equal(banner?.kind, 'REFUSED');
  assert.match(banner?.message ?? '', /has not given an e-way bill number/);
  assert.throws(() => renderEwayBill(failed, interStateMovement(), { snapshot }), /cannot be printed/);
});

test('no QR code is drawn, because the provider supplies no QR content', async () => {
  const { record, movement } = await raise();

  const html = renderEwayBill(record, movement, { snapshot });

  // The shared stylesheet carries `.qr-slot` rules for the invoice, so the question is whether a QR
  // element was drawn on this page, not whether the word appears anywhere in the file.
  assert.equal(/<svg/.test(html), false);
  assert.equal(/class="qr|<img/.test(html), false);
});
