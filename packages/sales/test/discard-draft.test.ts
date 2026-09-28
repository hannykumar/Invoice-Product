/**
 * Issue #256 — a bill that was only ever a review can be forgotten; an issued bill, or one held for
 * approval, never can. Forgetting a review never touches the bill-number series.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '@invoice/kernel';
import { ABC, inr, makeTill, on, qty } from './fixtures.ts';
import type { DraftInvoiceInput } from '../src/model.ts';

const crateBill = (): DraftInvoiceInput => ({
  partyId: ABC,
  customerType: 'B2B',
  supplyKind: 'GOODS',
  documentDate: on('2026-04-10'),
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('3', 'PCS'), unitPrice: inr(333, 33), priceBasis: 'EXCLUSIVE' }],
});

test('a review is forgotten, its goods let go, and the next bill takes the next number with no gap', async () => {
  const released: string[] = [];
  const till = await makeTill({
    inventory: {
      async reserve() { return { ok: true, reservationId: 'r' }; },
      async release(_actor, documentId) { released.push(documentId); },
      async issue() {},
      async returnToStock() {},
    },
  });
  const first = await till.service.finalise(till.actor, {
    idempotencyKey: 'f1',
    invoiceId: (await till.service.createDraft(till.actor, { idempotencyKey: 'k1', input: crateBill() })).id,
  });
  assert.equal(first.invoice.number, 'INV/26-27/000001');

  // Three reviews of the next sale; the first two are replaced and forgotten.
  const reviews = [];
  for (const key of ['r1', 'r2', 'r3']) reviews.push(await till.service.createDraft(till.actor, { idempotencyKey: key, input: crateBill() }));
  assert.equal(await till.service.discardDraft(till.actor, reviews[0]!.id, 'replaced'), true);
  assert.equal(await till.service.discardDraft(till.actor, reviews[1]!.id, 'replaced'), true);
  assert.deepEqual(released, [reviews[0]!.id, reviews[1]!.id]);
  assert.equal(await till.service.get(till.actor, reviews[0]!.id), null);
  // Forgetting it twice is not an error: there is nothing left to forget.
  assert.equal(await till.service.discardDraft(till.actor, reviews[0]!.id, 'replaced'), false);

  const second = await till.service.finalise(till.actor, { idempotencyKey: 'f3', invoiceId: reviews[2]!.id });
  assert.equal(second.invoice.number, 'INV/26-27/000002', 'the forgotten reviews never had a number, so none is skipped');

  const unfinished = (await till.repository.list(till.actor.companyId)).filter((invoice) => invoice.state !== 'FINAL');
  assert.deepEqual(unfinished, []);
  assert.ok(till.audit.events.some((entry) => entry.action === 'sales.draft_discarded'), 'the audit trail says a review was forgotten');
});

test('an issued bill and a bill held for approval are never forgotten', async () => {
  const till = await makeTill({ policy: { approvalRequiredAtOrAbove: inr(1000) } });
  const held = await till.service.submitForApproval(
    till.actor,
    (await till.service.createDraft(till.actor, { idempotencyKey: 'h1', input: crateBill() })).id,
  );
  assert.equal(held.state, 'PENDING_APPROVAL');
  await assert.rejects(
    () => till.service.discardDraft(till.actor, held.id, 'tidy up'),
    (error: unknown) => error instanceof DomainError && error.code === 'SALES_NOT_DISCARDABLE',
  );

  const plain = await makeTill();
  const issued = await plain.service.finalise(plain.actor, {
    idempotencyKey: 'f1',
    invoiceId: (await plain.service.createDraft(plain.actor, { idempotencyKey: 'k1', input: crateBill() })).id,
  });
  await assert.rejects(
    () => plain.service.discardDraft(plain.actor, issued.invoice.id, 'tidy up'),
    (error: unknown) => error instanceof DomainError && error.code === 'SALES_NOT_DISCARDABLE',
  );
  await assert.rejects(() => plain.repository.remove(plain.actor.companyId, issued.invoice.id), /stays on record/);
  assert.equal((await plain.service.get(plain.actor, issued.invoice.id))?.state, 'FINAL');
});
