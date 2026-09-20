/**
 * Issue #191 — the e-way bill page a driver is handed.
 *
 * Every case here goes through the real service and the synthetic portal that `npm run demo:eway`
 * uses, so what is printed is what the portal actually answered rather than a record assembled by
 * hand for the renderer's convenience.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEwayBill, ewayPrintRefusal } from '../src/eway.ts';
import { interStateMovement, lorry, makeEwayDesk } from '../../transport/src/fixtures.ts';

test('an active e-way bill prints all five of the portal\'s sections', async () => {
  const desk = makeEwayDesk();
  const movement = interStateMovement({ vehicle: lorry() });
  const record = await desk.service.generate(desk.actor, movement);
  assert.equal(record.status, 'ACTIVE');
  const html = renderEwayBill(record, movement, { now: desk.clock.now() });

  // The five headings, in the portal's own words and in its order.
  const order = ['E-Way Bill Details', 'Address Details', 'Goods Details', 'Transportation Details', 'Vehicle Details']
    .map((heading) => html.indexOf(heading));
  assert.ok(order.every((at) => at > -1), 'every section heading is on the page');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections are in the portal\'s order');

  const number = record.acknowledgement?.ewayBillNumber ?? '';
  assert.match(number, /^\d{12}$/);
  assert.ok(html.includes(number), 'the 12-digit number is on the page');
  assert.ok(html.includes('Valid Upto'));
  assert.ok(html.includes('Mode'));
  assert.ok(html.includes('Road'));
  assert.ok(html.includes('840 KM'), 'the approximate distance');
  assert.ok(html.includes('Outward-Supply'));
  assert.ok(html.includes('Tax invoice-SAM/2026/0117-21/08/2026'), 'the document details, as the portal writes them');
  assert.ok(html.includes(movement.consignor.gstin), 'the from GSTIN');
  assert.ok(html.includes(movement.billTo.gstin), 'the to GSTIN');
  assert.ok(html.includes('560058'), 'the from PIN code');
  assert.ok(html.includes('411030'), 'the to PIN code');
  assert.ok(html.includes('72142090'), 'the HSN code');
  assert.ok(html.includes('2000 KGS'), 'the quantity with its unit');
  assert.ok(html.includes('0.00+0.00+18.00+0.00+0.00'), 'the tax rate as C+S+I+Cess+Cess Non.Advol');
  assert.ok(html.includes('94400.00'), 'the total invoice amount');
  assert.ok(html.includes('KA01AB1234'), 'the vehicle row');
  assert.ok(!html.includes('PART-B NOT ENTERED'));
});

test('a Part A only e-way bill says on its face that the goods may not move', async () => {
  const desk = makeEwayDesk();
  const movement = interStateMovement();
  const record = await desk.service.generate(desk.actor, movement);
  assert.equal(record.status, 'PART_A_ONLY');
  const html = renderEwayBill(record, movement, { now: desk.clock.now() });
  assert.ok(html.includes('PART-B NOT ENTERED — the goods may not move on this e-way bill yet'));
  assert.ok(html.includes('Not started — no vehicle on this e-way bill yet'), 'validity has not begun');
});

test('a cancelled e-way bill prints CANCELLED across the header', async () => {
  const desk = makeEwayDesk();
  const movement = interStateMovement({ vehicle: lorry() });
  await desk.service.generate(desk.actor, movement);
  const cancelled = await desk.service.cancel(desk.actor, 'mov-001', {
    reasonCode: 'ORDER_CANCELLED',
    reason: 'The buyer called off the order before the lorry left.',
  });
  assert.equal(cancelled.status, 'CANCELLED');
  const html = renderEwayBill(cancelled, movement, { now: desk.clock.now() });
  assert.match(html, /CANCELLED on \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (AM|PM)/);
});

test('an e-way bill the portal never gave a number for cannot be printed', async () => {
  const desk = makeEwayDesk();
  desk.portal.setMode('outage');
  const movement = interStateMovement({ vehicle: lorry() });
  const failed = await desk.service.generate(desk.actor, movement);
  assert.equal(failed.status, 'FAILED');
  const refusal = ewayPrintRefusal(failed);
  assert.ok(refusal !== null);
  assert.match(refusal, /has not given an e-way bill number/);
  assert.throws(() => renderEwayBill(failed, movement), /has not given an e-way bill number/);
});

test('no QR code is invented when the provider\'s response carries none', async () => {
  const desk = makeEwayDesk();
  const movement = interStateMovement({ vehicle: lorry() });
  const record = await desk.service.generate(desk.actor, movement);
  const html = renderEwayBill(record, movement, { now: desk.clock.now() });
  assert.ok(!html.includes('<svg'), 'nothing QR-shaped is drawn');
  assert.ok(!html.includes('class="qr"'), 'and no empty square stands in for it');
});

test('an e-way bill whose validity has run out prints EXPIRED with the moment it ran out', async () => {
  const desk = makeEwayDesk();
  const movement = interStateMovement({ vehicle: lorry() });
  await desk.service.generate(desk.actor, movement);
  desk.clock.travelTo('2026-09-30T10:00:00.000Z');
  const expired = await desk.service.forMovement(desk.actor, 'mov-001');
  assert.equal(expired?.status, 'EXPIRED');
  const html = renderEwayBill(expired!, movement, { now: desk.clock.now() });
  assert.match(html, /EXPIRED at \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (AM|PM)/);
});

test('an item a shopkeeper could type is escaped rather than printed as markup', async () => {
  const desk = makeEwayDesk();
  const base = interStateMovement({ vehicle: lorry() });
  const document = base.documents[0]!;
  const movement = {
    ...base,
    documents: [{ ...document, lines: [{ ...document.lines[0]!, description: '<script>alert(1)</script>' }] }],
  };
  const record = await desk.service.generate(desk.actor, movement);
  const html = renderEwayBill(record, movement, { now: desk.clock.now() });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
