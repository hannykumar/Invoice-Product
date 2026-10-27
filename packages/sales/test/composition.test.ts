/**
 * Issue #296 — a composition business sells on a bill of supply: no GST on it, no tax in the books'
 * output accounts, and its own number series (CGST Rule 49; s.10(4)).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, toDecimalString } from '@invoice/kernel';
import { trialBalance } from '@invoice/ledger';
import { turnoverAnsweredEveryYear } from '../../masters/src/fixtures.ts';
import { ABC, GURUGRAM, inr, makeTill, on, qty } from './fixtures.ts';
import type { DraftInvoiceInput } from '../src/model.ts';

const bill = (overrides: Partial<DraftInvoiceInput> = {}): DraftInvoiceInput => ({
  partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-04-10'),
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('3', 'PCS'), unitPrice: inr(333, 33), priceBasis: 'EXCLUSIVE' }],
  ...overrides,
});

const compositionTill = async () => {
  const till = await makeTill();
  till.masterData.putCompany({ companyId: till.actor.companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'COMPOSITION', turnoverAbove5Crore: turnoverAnsweredEveryYear('NO') });
  return till;
};

test('a composition bill carries no GST, is numbered BOS/…, and the entry balances with no output tax', async () => {
  const till = await compositionTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k1', input: bill() });
  assert.equal(draft.pricing?.supplierRegistration, 'COMPOSITION');
  assert.equal(draft.pricing?.mayChargeGst, false);
  assert.equal(toDecimalString(draft.pricing!.totals.totalTax), '0.00');
  const issued = await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id });
  assert.equal(issued.invoice.number, 'BOS/26-27/000001');
  const voucher = await till.ledger.getVoucher(till.actor, issued.voucherId);
  const credits = voucher!.lines.filter((l) => l.credit.minor > 0n).map((l) => l.accountId);
  assert.ok(!credits.includes(till.account('OUTPUT_CGST')) && !credits.includes(till.account('OUTPUT_SGST')) && !credits.includes(till.account('OUTPUT_IGST')));
  assert.ok((await trialBalance(till.store.read(), till.actor.companyId)).balanced);
});

test('bills of supply keep their own running number, apart from tax invoices', async () => {
  const till = await compositionTill();
  const first = await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: (await till.service.createDraft(till.actor, { idempotencyKey: 'k1', input: bill() })).id });
  const second = await till.service.finalise(till.actor, { idempotencyKey: 'f2', invoiceId: (await till.service.createDraft(till.actor, { idempotencyKey: 'k2', input: bill() })).id });
  assert.deepEqual([first.invoice.number, second.invoice.number], ['BOS/26-27/000001', 'BOS/26-27/000002']);
  // The business leaves the scheme: tax invoices start their own run at 1, untouched by the bills of supply.
  till.masterData.putCompany({ companyId: till.actor.companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR', turnoverAbove5Crore: turnoverAnsweredEveryYear('NO') });
  const tax = await till.service.finalise(till.actor, { idempotencyKey: 'f3', invoiceId: (await till.service.createDraft(till.actor, { idempotencyKey: 'k3', input: bill() })).id });
  assert.equal(tax.invoice.number, 'INV/26-27/000001');
  assert.equal(tax.invoice.pricing?.mayChargeGst, true);
});

test('the same press of Issue twice does not use up a second number', async () => {
  const till = await compositionTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k1', input: bill() });
  const once = await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id });
  const twice = await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id });
  assert.equal(twice.invoice.number, once.invoice.number);
  assert.equal(twice.deduplicated, true);
});

test('a sale to another state is stopped, with a plain reason, and uses no number', async () => {
  const till = await compositionTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k1',
    input: bill({ partyId: GURUGRAM, lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('200', 'PCS'), unitPrice: inr(200), priceBasis: 'EXCLUSIVE' }] }),
  });
  assert.equal(draft.state, 'NEEDS_INFO');
  assert.equal(draft.problems[0]?.code, 'COMPOSITION_INTERSTATE_SUPPLY');
  await assert.rejects(till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id }), (e) => e instanceof DomainError && e.code === 'SALES_NEEDS_INFO');
  const ok = await till.service.finalise(till.actor, { idempotencyKey: 'f2', invoiceId: (await till.service.createDraft(till.actor, { idempotencyKey: 'k2', input: bill() })).id });
  assert.equal(ok.invoice.number, 'BOS/26-27/000001', 'the refused draft consumed no number');
});
