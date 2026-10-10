/**
 * Issue #363 — in memory, as on PostgreSQL: when the action a bill was issued in is undone, its
 * audit records are undone with it (the "Paid now" path, where the receipt fails after the bill).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ABC, inr, makeTill, on, qty } from './fixtures.ts';

test('a bill issued inside an action that then fails leaves no audit record of being issued', async () => {
  const queued: string[] = [];
  const till = await makeTill({
    compliance: {
      async onInvoiceFinalised(invoice) { queued.push(invoice.id); return []; },
      async onInvoiceCancelled() {},
    },
  });
  till.store.join(till.audit);
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k1',
    input: {
      partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-04-10'),
      lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('3', 'PCS'), unitPrice: inr(333, 33), priceBasis: 'EXCLUSIVE' }],
    },
  });
  const before = till.audit.events.length;

  await assert.rejects(till.store.transaction(till.actor.companyId, async () => {
    const issued = await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id });
    assert.equal(issued.invoice.state, 'FINAL');
    assert.equal(till.audit.events.length, before + 2, 'inside the action, the posting and the bill are both on record');
    assert.deepEqual(queued, [draft.id], 'the government request is queued inside the action, not after it');
    throw new Error('the receipt was refused');
  }), /the receipt was refused/);

  assert.equal((await till.service.get(till.actor, draft.id))?.state, 'DRAFT');
  assert.equal(till.audit.events.length, before, 'no record says a bill was issued that was not');

  // Issued on its own, the same bill is recorded once for the posting and once for the bill.
  await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id });
  assert.deepEqual(till.audit.events.slice(before).map((e) => e.action), ['ledger.voucher_posted', 'sales.invoice_finalised']);
});
