/**
 * Issue #141 — the delivery challan, checked against CGST Rule 55 and the issue's four "done when"s:
 *
 *  - a challan can be created against a customer with items and quantities, and no tax totals
 *    (where the law allows none — Rule 55(1)(vii) requires tax on a challan for a sale);
 *  - it has its own number series, separate from the invoice series;
 *  - (printing is checked in packages/invoice-templates);
 *  - it can carry an e-way bill, and the invoice raised later can be linked back to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, toDecimalString } from '@invoice/kernel';
import { CHALLAN_NUMBER_MAX_LENGTH, formatChallanNumber, validateChallanSeries } from '../src/challan-numbering.ts';
import { CHALLAN_REASONS, challanReason } from '../src/challan-model.ts';
import { ABC, GURUGRAM, ALL_PERMISSIONS, actorWith, inr, on, qty } from './fixtures.ts';
import { crateChallan, makeDispatchDesk } from './challan-fixtures.ts';
import type { DraftInvoiceInput } from '../src/model.ts';

const refusedWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
  assert.equal(error.code, code, error.message);
  return true;
};

const issueInvoice = async (desk: Awaited<ReturnType<typeof makeDispatchDesk>>, key: string, overrides: Partial<DraftInvoiceInput> = {}) => {
  const draft = await desk.till.service.createDraft(desk.till.actor, {
    idempotencyKey: `inv-${key}`,
    input: {
      partyId: ABC,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: on('2026-05-12'),
      lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }],
      ...overrides,
    },
  });
  return (await desk.till.service.finalise(desk.till.actor, { idempotencyKey: `fin-${key}`, invoiceId: draft.id })).invoice;
};

test('a job-work challan carries the value of the goods and no tax — Rule 55(1)(vi) and (vii)', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'c1', input: crateChallan() });

  assert.equal(challan.state, 'ISSUED');
  assert.equal(challan.showsTax, false);
  assert.equal(challan.lines[0]?.itemName, 'Plastic crate');
  assert.equal(challan.lines[0]?.hsnOrSac, '3923');
  assert.equal(toDecimalString(challan.totals.taxableValue), '8400.00', '40 crates at ₹210 is ₹8,400');
  assert.equal(challan.totals.totalTax.minor, 0n, 'no tax on goods sent for job work');
  assert.equal(challan.lines[0]?.ratePercentTimes100, null);
  assert.equal(challan.placeOfSupplyStateCode, null, 'a movement inside Delhi that is not a sale needs no place of supply');
  assert.equal(challanReason(challan.reason).legalBasis, 'CGST Rule 55(1)(b)');
});

test('a sale challan carries the tax rate and tax amount — Rule 55(1)(vii) — and the place of supply', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, {
    idempotencyKey: 'c-sale',
    input: crateChallan({ partyId: GURUGRAM, reason: 'SUPPLY_INVOICE_TO_FOLLOW' }),
  });

  assert.equal(challan.showsTax, true);
  assert.equal(challan.interState, true, 'Delhi to Haryana crosses a state border');
  assert.equal(challan.placeOfSupplyStateCode, '06');
  assert.equal(challan.split, 'IGST');
  assert.equal(challan.lines[0]?.ratePercentTimes100, 1800n);
  assert.equal(toDecimalString(challan.totals.igst), '1512.00', '18% of ₹8,400');
  assert.equal(challan.totals.cgst.minor, 0n);
});

test('a job-work challan across a state border still prints the place of supply — Rule 55(1)(viii)', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'c-jw-inter', input: crateChallan({ partyId: GURUGRAM }) });
  assert.equal(challan.showsTax, false);
  assert.equal(challan.placeOfSupplyStateCode, '06');
});

test('liquid gas marks its quantity provisional — Rule 55(1)(v)', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'c-gas', input: crateChallan({ reason: 'LIQUID_GAS' }) });
  assert.equal(challan.lines[0]?.quantityProvisional, true);
  assert.equal(challan.showsTax, true);
});

test('challans have their own number series, and it never touches the invoice series', async () => {
  const desk = await makeDispatchDesk();
  const first = await desk.challans.issue(desk.actor, { idempotencyKey: 'n1', input: crateChallan() });
  const invoice = await issueInvoice(desk, 'n');
  const second = await desk.challans.issue(desk.actor, { idempotencyKey: 'n2', input: crateChallan() });

  assert.equal(first.number, 'DC/26-27/00001');
  assert.equal(second.number, 'DC/26-27/00002', 'consecutive, with no gap for the invoice issued in between');
  assert.equal(invoice.number, 'INV/KB/2026-27/00001', 'the invoice series started at 1, untouched by challans');
  assert.ok(first.number.length <= CHALLAN_NUMBER_MAX_LENGTH, 'Rule 55(1): at most sixteen characters');
});

test('a retry returns the challan already issued, and a refused challan does not use a number', async () => {
  const desk = await makeDispatchDesk();
  await assert.rejects(
    desk.challans.issue(desk.actor, { idempotencyKey: 'bad', input: crateChallan({ lines: [{ lineId: 'l1', itemId: 'MYSTERY', quantity: qty('1', 'PCS'), unitPrice: inr(10) }] }) }),
    refusedWith('CHALLAN_NOT_READY'),
  );
  const once = await desk.challans.issue(desk.actor, { idempotencyKey: 'same', input: crateChallan() });
  const twice = await desk.challans.issue(desk.actor, { idempotencyKey: 'same', input: crateChallan() });
  assert.equal(once.id, twice.id);
  assert.equal(once.number, 'DC/26-27/00001', 'the refused challan left no gap');
  assert.equal((await desk.challans.list(desk.actor)).length, 1);
});

test('everything stopping a challan is listed at once, and nothing is guessed', async () => {
  const desk = await makeDispatchDesk();
  const working = await desk.challans.preview(desk.actor, {
    partyId: ABC,
    reason: 'OTHER_NOT_A_SUPPLY',
    documentDate: on('2026-05-10'),
    lines: [
      { lineId: 'a', itemId: 'MYSTERY', quantity: qty('1', 'PCS'), unitPrice: inr(10) },
      { lineId: 'b', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(10) },
      { lineId: 'c', itemId: 'CRATE-P', quantity: qty('0', 'PCS'), unitPrice: inr(10) },
    ],
  });
  assert.equal(working.ok, false);
  const codes = working.ok ? [] : working.problems.map((p) => p.code);
  assert.deepEqual(codes.sort(), ['CHALLAN_HSN_MISSING', 'CHALLAN_NOT_GOODS', 'CHALLAN_QUANTITY', 'CHALLAN_REASON_NOTE_REQUIRED'].sort());
});

test('a series that could print a number over sixteen characters, or look like an invoice, is refused', () => {
  assert.throws(() => validateChallanSeries({ prefix: 'CHALLAN', branchCode: 'MAIN', padding: 5 }), refusedWith('CHALLAN_NUMBER_TOO_LONG'));
  assert.throws(() => validateChallanSeries({ prefix: 'INV', branchCode: '', padding: 5 }, 'INV'), refusedWith('CHALLAN_SERIES_SHARES_INVOICE_PREFIX'));
  assert.doesNotThrow(() => validateChallanSeries({ prefix: 'DC', branchCode: 'KB', padding: 4 }));
  assert.equal(formatChallanNumber({ prefix: 'DC', branchCode: 'KB', padding: 4 }, on('2027-02-01'), 7), 'DC/KB/26-27/0007');
});

test('every reason is one Rule 55 or section 31(7) allows, and only a sale carries tax', () => {
  for (const reason of CHALLAN_REASONS) {
    assert.match(reason.legalBasis, /^CGST (Rule 55\(|Act section 31\(7\))/);
    assert.equal(reason.showsTax, reason.movementReason === 'SUPPLY', `${reason.reason}: tax prints exactly when the goods move as a sale`);
    assert.equal(reason.invoiceFollows, reason.movementReason === 'SUPPLY');
  }
});

test('the invoice raised after delivery links back to the challan — Rule 55(4)', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'l1', input: crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW' }) });
  const invoice = await issueInvoice(desk, 'l1');

  const linked = await desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: invoice.id });
  assert.equal(linked.state, 'INVOICED');
  assert.equal(linked.invoice?.invoiceNumber, invoice.number);
  assert.deepEqual(linked.invoice?.differences, []);
  assert.deepEqual((await desk.challans.forInvoice(desk.actor, invoice.id)).map((c) => c.number), ['DC/26-27/00001']);

  // Linking again is harmless; linking it to a second invoice is not.
  assert.equal((await desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: invoice.id })).version, linked.version);
  const other = await issueInvoice(desk, 'l1b');
  await assert.rejects(desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: other.id }), refusedWith('CHALLAN_ALREADY_INVOICED'));
});

test('a week of challans can be billed on one invoice, and a short invoice is noted', async () => {
  const desk = await makeDispatchDesk();
  const monday = await desk.challans.issue(desk.actor, { idempotencyKey: 'mon', input: crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW' }) });
  const tuesday = await desk.challans.issue(desk.actor, { idempotencyKey: 'tue', input: crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW', documentDate: on('2026-05-11') }) });
  const saturday = await issueInvoice(desk, 'sat', {
    lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('30', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }],
  });

  const a = await desk.challans.linkInvoice(desk.actor, { challanId: monday.id, invoiceId: saturday.id });
  const b = await desk.challans.linkInvoice(desk.actor, { challanId: tuesday.id, invoiceId: saturday.id });
  assert.equal(a.state, 'INVOICED');
  assert.equal(b.state, 'INVOICED');
  assert.deepEqual(a.invoice?.differences, ['Plastic crate: 40 PCS went out on the challan, but the invoice bills only 30 PCS.']);
  assert.equal((await desk.challans.forInvoice(desk.actor, saturday.id)).length, 2);
});

test('an invoice that cannot be the one for these goods is refused, with the reason', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'r1', input: crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW' }) });

  const otherCustomer = await issueInvoice(desk, 'other', { partyId: GURUGRAM });
  await assert.rejects(desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: otherCustomer.id }), refusedWith('CHALLAN_INVOICE_OTHER_PARTY'));

  const earlier = await issueInvoice(desk, 'early', { documentDate: on('2026-05-01') });
  await assert.rejects(desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: earlier.id }), refusedWith('CHALLAN_INVOICE_BEFORE_CHALLAN'));

  const apples = await issueInvoice(desk, 'apples', {
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', quantity: qty('5', 'BOX'), unitPrice: inr(800), priceBasis: 'EXCLUSIVE' }],
  });
  await assert.rejects(desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: apples.id }), refusedWith('CHALLAN_INVOICE_MISSING_ITEMS'));

  const draft = await desk.till.service.createDraft(desk.till.actor, {
    idempotencyKey: 'draft-only',
    input: { partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-05-12'), lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }] },
  });
  await assert.rejects(desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: draft.id }), refusedWith('CHALLAN_INVOICE_NOT_ISSUED'));
});

test('goods sent for job work are not sold, so no invoice links to that challan', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'jw', input: crateChallan() });
  const invoice = await issueInvoice(desk, 'jw');
  await assert.rejects(desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: invoice.id }), refusedWith('CHALLAN_NO_INVOICE_FOLLOWS'));
});

test('the e-way bill goes on the challan, typed or from the portal — Rule 55(3)', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'e1', input: crateChallan() });

  await assert.rejects(
    desk.challans.attachEwayBill(desk.actor, { challanId: challan.id, ewayBillNumber: '1234', source: 'TYPED' }),
    refusedWith('CHALLAN_EWAY_NUMBER_INVALID'),
  );
  const withEway = await desk.challans.attachEwayBill(desk.actor, {
    challanId: challan.id,
    ewayBillNumber: '3210 0123 4567',
    transporter: 'Sharma Roadlines',
    vehicleNumber: 'DL01AB1234',
    source: 'TYPED',
  });
  assert.equal(withEway.ewayBill?.number, '321001234567');
  assert.equal(withEway.ewayBill?.source, 'TYPED', 'the record says a person entered it');
  assert.ok(desk.audit.events.some((e) => e.action === 'challan.eway_bill_recorded' && e.summary.includes('typed in by a person')));
});

test('a challan with a live e-way bill is cancelled only once the person confirms the portal side', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'x1', input: crateChallan() });
  await desk.challans.attachEwayBill(desk.actor, { challanId: challan.id, ewayBillNumber: '321001234567', source: 'PORTAL' });

  await assert.rejects(desk.challans.cancel(desk.actor, { challanId: challan.id, reason: 'Lorry did not come' }), refusedWith('CHALLAN_EWAY_STILL_LIVE'));
  await assert.rejects(desk.challans.cancel(desk.actor, { challanId: challan.id, reason: ' ', ewayBillCancelledOnPortal: true }), refusedWith('CHALLAN_REASON_REQUIRED'));
  const cancelled = await desk.challans.cancel(desk.actor, { challanId: challan.id, reason: 'Lorry did not come', ewayBillCancelledOnPortal: true });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.number, 'DC/26-27/00001', 'the number stays used, so the series keeps no gap');

  const next = await desk.challans.issue(desk.actor, { idempotencyKey: 'x2', input: crateChallan() });
  assert.equal(next.number, 'DC/26-27/00002');
});

test('a billed challan cannot be cancelled — the goods really moved', async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, { idempotencyKey: 'b1', input: crateChallan({ reason: 'SUPPLY_INVOICE_TO_FOLLOW' }) });
  const invoice = await issueInvoice(desk, 'b1');
  await desk.challans.linkInvoice(desk.actor, { challanId: challan.id, invoiceId: invoice.id });
  await assert.rejects(desk.challans.cancel(desk.actor, { challanId: challan.id, reason: 'mistake' }), refusedWith('CHALLAN_ALREADY_INVOICED'));
});

test('issuing a challan needs its own permission', async () => {
  const desk = await makeDispatchDesk({ permissions: ALL_PERMISSIONS });
  await assert.rejects(desk.challans.issue(desk.actor, { idempotencyKey: 'p1', input: crateChallan() }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.kind, 'FORBIDDEN');
    return true;
  });
  const other = actorWith(['challan.issue']);
  assert.equal((await (await makeDispatchDesk()).challans.issue(other, { idempotencyKey: 'p2', input: crateChallan() })).state, 'ISSUED');
});
