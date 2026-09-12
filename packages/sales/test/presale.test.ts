/**
 * Issue #142 — the quotation and the proforma invoice, checked against the issue's four "done when"s:
 *
 *  - both can be created, numbered in their own series (printing is checked in invoice-templates);
 *  - neither touches the books, stock or GST;
 *  - a quotation can be turned into a sale without retyping it;
 *  - a proforma records what it was for, and the eventual invoice can be linked to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, toDecimalString } from '@invoice/kernel';
import { formatPreSaleNumber, validatePreSaleSeries, PRESALE_NUMBER_MAX_LENGTH } from '../src/presale-numbering.ts';
import { hasLapsed } from '../src/presale-model.ts';
import { ABC, GURUGRAM, ALL_PERMISSIONS, actorWith, inr, on, qty } from './fixtures.ts';
import { crateOffer, makeSalesCounter, PRESALE_PERMISSIONS_FOR_TESTS, type SalesCounter } from './presale-fixtures.ts';
import type { DraftInvoiceInput } from '../src/model.ts';

const refusedWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
  assert.equal(error.code, code, error.message);
  return true;
};

const vouchers = async (counter: SalesCounter) =>
  counter.till.store.transaction(counter.till.actor.companyId, async (uow) => uow.vouchers.list(counter.till.actor.companyId, {}));

const issueInvoice = async (counter: SalesCounter, key: string, overrides: Partial<DraftInvoiceInput> = {}) => {
  const draft = await counter.till.service.createDraft(counter.till.actor, {
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
  return (await counter.till.service.finalise(counter.till.actor, { idempotencyKey: `fin-${key}`, invoiceId: draft.id })).invoice;
};

test('a quotation and a proforma are each numbered in a series of their own, and the invoice series is untouched', async () => {
  const counter = await makeSalesCounter();
  const q1 = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q1', input: crateOffer() });
  const q2 = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q2', input: crateOffer() });
  const p1 = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p1', input: crateOffer({ purpose: 'Advance before dispatch' }) });
  assert.deepEqual([q1.number, q2.number, p1.number], ['QTN/26-27/00001', 'QTN/26-27/00002', 'PI/26-27/00001']);
  assert.equal(q1.financialYear, '2026-27');

  // Three documents issued, and the first tax invoice is still number one.
  const invoice = await issueInvoice(counter, 'first');
  assert.equal(invoice.number, 'INV/26-27/00001');
});

test('the tax shown is worked out by the invoice calculator, so the quote and the bill agree', async () => {
  const counter = await makeSalesCounter();
  const local = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'local', input: crateOffer() });
  assert.equal(toDecimalString(local.pricing.totals.taxableValue), '8400.00');
  assert.equal(local.pricing.split, 'CGST_SGST');
  assert.equal(toDecimalString(local.pricing.totals.cgst), '756.00');
  assert.equal(toDecimalString(local.pricing.totals.invoiceValue), '9912.00');

  const across = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'across', input: crateOffer({ partyId: GURUGRAM, purpose: 'Advance' }) });
  assert.equal(across.pricing.split, 'IGST');
  assert.equal(across.pricing.placeOfSupplyStateCode, '06');
  assert.equal(toDecimalString(across.pricing.totals.igst), '1512.00');

  const invoice = await issueInvoice(counter, 'same');
  assert.equal(invoice.pricing?.totals.invoiceValue.minor, local.pricing.totals.invoiceValue.minor, 'the bill charges what the quotation showed');
});

test('neither paper touches the books, the stock or GST', async () => {
  const counter = await makeSalesCounter();
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p', input: crateOffer({ purpose: 'Advance' }) });
  assert.equal((await vouchers(counter)).length, 0, 'no entry in the books');
  assert.deepEqual(counter.inventory.calls, [], 'no stock held or moved');
  assert.equal((await counter.till.repository.list(counter.till.actor.companyId)).length, 0, 'no invoice exists, so nothing can be reported');

  // Even turning the quotation into a sale only starts a draft: still no entry, no stock, no number.
  const { invoice } = await counter.presale.convertToSale(counter.actor, { quotationId: quotation.id });
  assert.equal(invoice.state, 'DRAFT');
  assert.equal(invoice.number, null);
  assert.equal((await vouchers(counter)).length, 0);
  assert.deepEqual(counter.inventory.calls, []);
});

test('checking a document uses no number, and a retried issue returns the same one', async () => {
  const counter = await makeSalesCounter();
  const checked = await counter.presale.preview(counter.actor, 'QUOTATION', crateOffer());
  assert.ok(checked.ok);
  const first = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'same-key', input: crateOffer() });
  const again = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'same-key', input: crateOffer() });
  assert.equal(first.number, 'QTN/26-27/00001');
  assert.equal(again.id, first.id);
  assert.equal((await counter.presale.list(counter.actor)).length, 1);
});

test('everything stopping a document is listed at once, and a refused one uses no number', async () => {
  const counter = await makeSalesCounter();
  const working = await counter.presale.preview(counter.actor, 'PROFORMA', crateOffer({
    validUntil: on('2026-05-01'),
    lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('0', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }],
  }));
  assert.ok(!working.ok);
  assert.deepEqual(
    working.problems.map((p) => p.code).sort(),
    ['PRESALE_PURPOSE_REQUIRED', 'PRESALE_QUANTITY', 'PRESALE_VALIDITY_BEFORE_DATE'],
  );

  const unknown = await counter.presale.preview(counter.actor, 'QUOTATION', crateOffer({
    lines: [{ lineId: 'l1', itemId: 'MYSTERY', quantity: qty('1', 'PCS'), unitPrice: inr(10), priceBasis: 'EXCLUSIVE' }],
  }));
  assert.ok(!unknown.ok, 'an item with no HSN cannot be priced, on a quotation as on a bill');

  await assert.rejects(
    counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'no-purpose', input: crateOffer() }),
    refusedWith('PRESALE_NOT_READY'),
  );
  const next = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'ok', input: crateOffer({ purpose: 'Advance' }) });
  assert.equal(next.number, 'PI/26-27/00001', 'the refused proforma used no number');
});

test('a proforma records what it was for; a quotation keeps none of the proforma fields', async () => {
  const counter = await makeSalesCounter();
  const proforma = await counter.presale.issue(counter.actor, {
    kind: 'PROFORMA',
    idempotencyKey: 'p',
    input: crateOffer({ purpose: '  Advance for order of 40 crates before dispatch ', buyerOrderNumber: 'PO-4471', paymentTerms: '100% advance', validUntil: on('2026-05-25') }),
  });
  assert.equal(proforma.purpose, 'Advance for order of 40 crates before dispatch');
  assert.equal(proforma.buyerOrderNumber, 'PO-4471');
  assert.equal(proforma.paymentTerms, '100% advance');
  assert.equal(proforma.validUntil, '2026-05-25');

  const quotation = await counter.presale.issue(counter.actor, {
    kind: 'QUOTATION',
    idempotencyKey: 'q',
    input: crateOffer({ purpose: 'ignored', buyerOrderNumber: 'ignored', paymentTerms: 'ignored' }),
  });
  assert.equal(quotation.purpose, null);
  assert.equal(quotation.buyerOrderNumber, null);
  assert.equal(quotation.paymentTerms, null);
  assert.equal(quotation.validUntil, null, 'no validity is invented for the business');
  assert.equal(quotation.terms, null, 'no terms are invented for the business');
});

test('a series that could be mistaken for another document, or print too long, is refused', () => {
  assert.throws(() => validatePreSaleSeries('QUOTATION', { prefix: 'INV', branchCode: '', padding: 5 }, ['INV', 'DC']), refusedWith('PRESALE_SERIES_SHARES_PREFIX'));
  assert.throws(() => validatePreSaleSeries('PROFORMA', { prefix: 'DC', branchCode: '', padding: 5 }, ['INV', 'DC']), refusedWith('PRESALE_SERIES_SHARES_PREFIX'));
  assert.throws(() => validatePreSaleSeries('PROFORMA', { prefix: 'PROFORMA', branchCode: 'KB', padding: 5 }), refusedWith('PRESALE_NUMBER_TOO_LONG'));
  assert.throws(() => validatePreSaleSeries('QUOTATION', { prefix: 'Q T', branchCode: '', padding: 5 }), refusedWith('PRESALE_SERIES_CHARACTERS'));
  assert.equal(formatPreSaleNumber('PROFORMA', { prefix: 'PI', branchCode: 'KB', padding: 4 }, on('2027-02-01'), 7), 'PI/KB/26-27/0007');
  assert.ok('QTN/26-27/00001'.length <= PRESALE_NUMBER_MAX_LENGTH);
});

test('an accepted quotation becomes a draft bill without retyping, and only the bill posts', async () => {
  const counter = await makeSalesCounter();
  const quotation = await counter.presale.issue(counter.actor, {
    kind: 'QUOTATION',
    idempotencyKey: 'q',
    input: crateOffer({
      partyId: GURUGRAM,
      freight: inr(500),
      lines: [
        { lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE', discount: { kind: 'PERCENT', percentTimes100: 500n } },
        { lineId: 'l2', itemId: 'REPAIR', quantity: qty('2', 'JOB'), unitPrice: inr(300), priceBasis: 'EXCLUSIVE' },
      ],
    }),
  });

  const converted = await counter.presale.convertToSale(counter.actor, { quotationId: quotation.id });
  assert.equal(converted.quotation.state, 'CONVERTED');
  assert.equal(converted.quotation.sale?.invoiceId, converted.invoice.id);
  assert.deepEqual(converted.invoice.lines, quotation.lines, 'every line, quantity, rate and discount carried over');
  assert.equal(converted.invoice.partyId, GURUGRAM);
  assert.equal(converted.invoice.freight.minor, inr(500).minor);
  assert.equal(converted.invoice.documentDate, '2026-05-12', 'dated today unless the person says otherwise');
  assert.equal(converted.invoice.pricing?.totals.invoiceValue.minor, quotation.pricing.totals.invoiceValue.minor);
  assert.deepEqual(converted.notes, []);

  // Converting twice returns the same draft rather than starting a second bill.
  const again = await counter.presale.convertToSale(counter.actor, { quotationId: quotation.id });
  assert.equal(again.invoice.id, converted.invoice.id);
  assert.equal((await counter.till.repository.list(counter.till.actor.companyId)).length, 1);

  // The bill is issued through the ordinary sale, and that is the only thing that posts.
  const final = await counter.till.service.finalise(counter.till.actor, { idempotencyKey: 'fin', invoiceId: converted.invoice.id });
  assert.equal(final.invoice.number, 'INV/26-27/00001');
  assert.equal((await vouchers(counter)).length, 1);
  assert.deepEqual((await counter.presale.forInvoice(counter.actor, final.invoice.id)).map((d) => d.number), ['QTN/26-27/00001']);
});

test('a lapsed quotation can still become a sale, but the person is told', async () => {
  const counter = await makeSalesCounter();
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer({ validUntil: on('2026-05-11') }) });
  assert.equal(hasLapsed(quotation, on('2026-05-11')), false, 'valid through the last day');
  assert.equal(hasLapsed(quotation, on('2026-05-12')), true);
  const converted = await counter.presale.convertToSale(counter.actor, { quotationId: quotation.id });
  assert.equal(converted.notes.length, 1);
  assert.match(converted.notes[0] as string, /was valid until 11 May 2026/);
});

test('a quotation cannot be used to get round the permission to sell', async () => {
  const counter = await makeSalesCounter({ permissions: ['quotation.issue'] });
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  await assert.rejects(counter.presale.convertToSale(counter.actor, { quotationId: quotation.id }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.kind, 'FORBIDDEN');
    return true;
  });
  assert.equal((await counter.presale.get(counter.actor, quotation.id))?.state, 'ISSUED', 'nothing changed');
});

test('only a quotation becomes a sale, and only one still on offer', async () => {
  const counter = await makeSalesCounter();
  const proforma = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p', input: crateOffer({ purpose: 'Advance' }) });
  await assert.rejects(counter.presale.convertToSale(counter.actor, { quotationId: proforma.id }), refusedWith('PRESALE_NOT_A_QUOTATION'));
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  await counter.presale.cancel(counter.actor, { id: quotation.id, reason: 'Customer bought elsewhere' });
  await assert.rejects(counter.presale.convertToSale(counter.actor, { quotationId: quotation.id }), refusedWith('PRESALE_CANCELLED'));
});

test('the invoice raised after a proforma links back to it, and what differs is noted, not refused', async () => {
  const counter = await makeSalesCounter();
  const proforma = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p', input: crateOffer({ purpose: 'Advance for 40 crates' }) });

  // Only 30 crates went, at the same rate: a part dispatch.
  const invoice = await issueInvoice(counter, 'part', {
    lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('30', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }],
  });
  const linked = await counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: invoice.id });
  assert.equal(linked.state, 'INVOICED');
  assert.equal(linked.invoice?.invoiceNumber, invoice.number);
  assert.deepEqual(linked.invoice?.differences, [
    'Plastic crate: the proforma asked for 40 PCS; the invoice bills 30 PCS.',
    `The proforma came to ₹9,912.00; invoice ${invoice.number} comes to ₹7,434.00.`,
  ]);
  assert.deepEqual((await counter.presale.forInvoice(counter.actor, invoice.id)).map((d) => d.number), ['PI/26-27/00001']);

  // Linking again is harmless; linking it to a second invoice is not.
  assert.equal((await counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: invoice.id })).version, linked.version);
  const second = await issueInvoice(counter, 'second');
  await assert.rejects(counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: second.id }), refusedWith('PRESALE_ALREADY_INVOICED'));
});

test('a proforma is linked only to an issued invoice, for the same customer, dated on or after it', async () => {
  const counter = await makeSalesCounter();
  const proforma = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p', input: crateOffer({ purpose: 'Advance' }) });
  const otherCustomer = await issueInvoice(counter, 'other', { partyId: GURUGRAM });
  await assert.rejects(counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: otherCustomer.id }), refusedWith('PRESALE_INVOICE_OTHER_PARTY'));
  const earlier = await issueInvoice(counter, 'earlier', { documentDate: on('2026-05-09') });
  await assert.rejects(counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: earlier.id }), refusedWith('PRESALE_INVOICE_BEFORE_PROFORMA'));
  const draft = await counter.till.service.createDraft(counter.till.actor, {
    idempotencyKey: 'draft',
    input: { partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-05-12'), lines: proforma.lines },
  });
  await assert.rejects(counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: draft.id }), refusedWith('PRESALE_INVOICE_NOT_ISSUED'));

  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  const invoice = await issueInvoice(counter, 'ok');
  await assert.rejects(counter.presale.linkInvoice(counter.actor, { proformaId: quotation.id, invoiceId: invoice.id }), refusedWith('PRESALE_NOT_A_PROFORMA'));
});

test('a withdrawn offer is cancelled with a reason; its number stays used', async () => {
  const counter = await makeSalesCounter();
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q1', input: crateOffer() });
  await assert.rejects(counter.presale.cancel(counter.actor, { id: quotation.id, reason: ' ' }), refusedWith('PRESALE_REASON_REQUIRED'));
  const cancelled = await counter.presale.cancel(counter.actor, { id: quotation.id, reason: 'Customer bought elsewhere' });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.cancelReason, 'Customer bought elsewhere');
  const next = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q2', input: crateOffer() });
  assert.equal(next.number, 'QTN/26-27/00002', 'no gap, no reuse');

  const converted = await counter.presale.convertToSale(counter.actor, { quotationId: next.id });
  await assert.rejects(counter.presale.cancel(counter.actor, { id: converted.quotation.id, reason: 'mistake' }), refusedWith('PRESALE_ALREADY_CONVERTED'));

  const proforma = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p', input: crateOffer({ purpose: 'Advance' }) });
  const invoice = await issueInvoice(counter, 'bill');
  await counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: invoice.id });
  await assert.rejects(counter.presale.cancel(counter.actor, { id: proforma.id, reason: 'mistake' }), refusedWith('PRESALE_ALREADY_INVOICED'));
});

test('each paper needs its own permission, and every act is in the audit log', async () => {
  const counter = await makeSalesCounter({ permissions: ALL_PERMISSIONS });
  for (const kind of ['QUOTATION', 'PROFORMA'] as const) {
    await assert.rejects(counter.presale.issue(counter.actor, { kind, idempotencyKey: kind, input: crateOffer({ purpose: 'Advance' }) }), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.kind, 'FORBIDDEN');
      return true;
    });
  }
  const quoter = actorWith(['quotation.issue']);
  const quotation = await counter.presale.issue(quoter, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  await assert.rejects(counter.presale.cancel(quoter, { id: quotation.id, reason: 'x' }), (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN');

  const full = actorWith(PRESALE_PERMISSIONS_FOR_TESTS);
  await counter.presale.cancel(full, { id: quotation.id, reason: 'Withdrawn' });
  assert.deepEqual(counter.audit.events.map((e) => e.action), ['quotation.issued', 'quotation.cancelled']);
  assert.match(counter.audit.events[0]?.summary ?? '', /Nothing was posted to the books/);
});
