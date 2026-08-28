/**
 * Issue #9 [E09] acceptance criteria, enforced automatically.
 *
 *  - "Invoice totals and postings are reproducible"
 *  - "Final numbering is unique and concurrency safe"
 *  - "Cancellation follows configured approval and reversal policy"
 *
 * plus the required intra/inter-state, discount, rounding, concurrency, draft-to-final and
 * cancellation tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, toDecimalString } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { parseNumber } from '../src/numbering.ts';
import { ABC, GURUGRAM, PRIYA, RAJESH, WALK_IN, actorWith, ALL_PERMISSIONS, inr, makeTill, on, OTHER, qty } from './fixtures.ts';
import type { DraftInvoiceInput } from '../src/model.ts';

const crateBill = (overrides: Partial<DraftInvoiceInput> = {}): DraftInvoiceInput => ({
  partyId: ABC,
  customerType: 'B2B',
  supplyKind: 'GOODS',
  documentDate: on('2026-04-10'),
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('3', 'PCS'), unitPrice: inr(333, 33), priceBasis: 'EXCLUSIVE' }],
  ...overrides,
});

test('draft to final — an intra-state bill is priced, issued, numbered and posted', async () => {
  const till = await makeTill();

  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k1', input: crateBill() });
  assert.equal(draft.state, 'DRAFT');
  assert.equal(draft.number, null, 'a draft never consumes a number');
  assert.equal(toDecimalString(draft.pricing?.totals.invoiceValue ?? inr(0)), '1180.00');
  assert.equal(draft.pricing?.split, 'CGST_SGST');

  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f1', invoiceId: draft.id });
  assert.equal(result.invoice.state, 'FINAL');
  assert.equal(result.invoice.number, 'INV/KB/2026-27/00001');
  assert.equal(result.invoice.financialYear, '2026-27');

  const voucher = await till.ledger.getVoucher(till.actor, result.voucherId);
  assert.ok(voucher !== null);
  assert.equal(voucher.type, 'SALE');
  assert.equal(voucher.source?.number, 'INV/KB/2026-27/00001');

  const debits = voucher.lines.reduce((a, l) => a + l.debit.minor, 0n);
  const credits = voucher.lines.reduce((a, l) => a + l.credit.minor, 0n);
  assert.equal(debits, credits, 'the entry balances');
  assert.equal(debits, 118000n);

  const owed = await partyBalance(till.store.read(), till.actor.companyId, ABC);
  assert.equal(toDecimalString(owed.balance), '1180.00', 'ABC Traders owes ₹1,180');
  assert.ok((await trialBalance(till.store.read(), till.actor.companyId)).balanced);
});

test('the posting carries the round-off, so the entry balances after rounding', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k2', input: crateBill() });
  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f2', invoiceId: draft.id });
  const voucher = await till.ledger.getVoucher(till.actor, result.voucherId);

  const roundOffAccount = till.account('ROUND_OFF');
  const roundOffLine = voucher?.lines.find((l) => l.accountId === roundOffAccount);
  assert.ok(roundOffLine !== undefined, 'the rounding difference must be posted');
  assert.equal(toDecimalString(roundOffLine.credit), '0.01');

  const sales = voucher?.lines.find((l) => l.accountId === till.account('SALES_GOODS'));
  assert.equal(toDecimalString(sales?.credit ?? inr(0)), '999.99');
  const cgst = voucher?.lines.find((l) => l.accountId === till.account('OUTPUT_CGST'));
  assert.equal(toDecimalString(cgst?.credit ?? inr(0)), '90.00');
});

test('an inter-state bill posts one combined GST and no CGST or SGST', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k3',
    input: crateBill({
      partyId: GURUGRAM,
      lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('200', 'PCS'), unitPrice: inr(200), priceBasis: 'EXCLUSIVE' }],
    }),
  });
  assert.equal(draft.pricing?.split, 'IGST');

  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f3', invoiceId: draft.id });
  const voucher = await till.ledger.getVoucher(till.actor, result.voucherId);
  const igst = voucher?.lines.find((l) => l.accountId === till.account('OUTPUT_IGST'));
  assert.equal(toDecimalString(igst?.credit ?? inr(0)), '7200.00');
  assert.equal(
    voucher?.lines.some((l) => l.accountId === till.account('OUTPUT_CGST')),
    false,
    'an inter-state sale must not touch CGST',
  );
});

test('a discount reduces the taxable value, and the posting follows it', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k4',
    input: crateBill({
      lines: [
        {
          lineId: 'l1',
          itemId: 'CRATE-P',
          quantity: qty('10', 'PCS'),
          unitPrice: inr(100),
          priceBasis: 'EXCLUSIVE',
          discount: { kind: 'PERCENT', percentTimes100: 500n },
        },
      ],
    }),
  });
  assert.equal(toDecimalString(draft.pricing?.totals.taxableValue ?? inr(0)), '950.00');
  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f4', invoiceId: draft.id });
  const voucher = await till.ledger.getVoucher(till.actor, result.voucherId);
  const sales = voucher?.lines.find((l) => l.accountId === till.account('SALES_GOODS'));
  assert.equal(toDecimalString(sales?.credit ?? inr(0)), '950.00');
  assert.equal(toDecimalString(result.invoice.pricing?.totals.invoiceValue ?? inr(0)), '1121.00');
});

test('totals and postings are reproducible: the same bill priced twice is the same bill', async () => {
  const till = await makeTill();
  const first = await till.service.createDraft(till.actor, { idempotencyKey: 'k5', input: crateBill() });
  const second = await till.service.price(till.actor, first.id);
  assert.deepEqual(second.pricing?.totals, first.pricing?.totals);
  assert.deepEqual(second.pricing?.lines, first.pricing?.lines);
});

test('numbering is unique and gapless under fifty concurrent finalisations', async () => {
  const till = await makeTill();
  const count = 50;
  const drafts = await Promise.all(
    Array.from({ length: count }, (_unused, i) =>
      till.service.createDraft(till.actor, { idempotencyKey: `k-conc-${i}`, input: crateBill() }),
    ),
  );
  const results = await Promise.all(
    drafts.map((d, i) => till.service.finalise(till.actor, { idempotencyKey: `f-conc-${i}`, invoiceId: d.id })),
  );

  const numbers = results.map((r) => r.invoice.number as string);
  assert.equal(new Set(numbers).size, count, 'two bills must never share a number');
  const sequence = numbers.map((n) => parseNumber(n)?.sequence as number).sort((a, b) => a - b);
  assert.deepEqual(sequence, Array.from({ length: count }, (_unused, i) => i + 1), 'the series has no gaps');
  for (const n of numbers) assert.match(n, /^INV\/KB\/2026-27\/\d{5}$/);

  assert.ok((await trialBalance(till.store.read(), till.actor.companyId)).balanced);
  const owed = await partyBalance(till.store.read(), till.actor.companyId, ABC);
  assert.equal(toDecimalString(owed.balance), `${count * 1180}.00`);
});

test('finalising twice issues one bill, one number and one entry', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k6', input: crateBill() });
  const first = await till.service.finalise(till.actor, { idempotencyKey: 'f6', invoiceId: draft.id });
  const second = await till.service.finalise(till.actor, { idempotencyKey: 'f6', invoiceId: draft.id });

  assert.equal(second.deduplicated, true);
  assert.equal(second.invoice.number, first.invoice.number);
  const vouchers = await till.store.read().vouchers.list(till.actor.companyId, {});
  assert.equal(vouchers.length, 1, 'a retry must not post a second entry');
});

test('starting the same bill twice returns the bill that was already started', async () => {
  const till = await makeTill();
  const first = await till.service.createDraft(till.actor, { idempotencyKey: 'k7', input: crateBill() });
  const second = await till.service.createDraft(till.actor, { idempotencyKey: 'k7', input: crateBill() });
  assert.equal(second.id, first.id);
  assert.equal((await till.repository.list(till.actor.companyId)).length, 1);
});

test('a bill whose tax cannot be worked out waits, and recovers when the fact arrives', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k8',
    input: crateBill({ partyId: WALK_IN }),
  });
  assert.equal(draft.state, 'NEEDS_INFO');
  assert.equal(draft.pricing, null);
  assert.deepEqual(draft.problems.map((p) => p.code), ['PLACE_OF_SUPPLY_UNKNOWN']);
  assert.equal(draft.problems[0]?.messageId, 'tax.place_of_supply_missing');

  await assert.rejects(
    () => till.service.finalise(till.actor, { idempotencyKey: 'f8', invoiceId: draft.id }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_NEEDS_INFO',
  );

  const fixed = await till.service.updateDraft(till.actor, draft.id, { placeOfSupplyStateCode: '06' }, draft.version);
  assert.equal(fixed.state, 'DRAFT');
  assert.equal(fixed.pricing?.split, 'IGST');

  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f8b', invoiceId: draft.id });
  assert.equal(result.invoice.state, 'FINAL');
});

test('an unclassified item stops the bill instead of guessing a rate', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k9',
    input: crateBill({
      lines: [{ lineId: 'l1', itemId: 'MYSTERY', quantity: qty('1', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }],
    }),
  });
  assert.equal(draft.state, 'NEEDS_INFO');
  assert.deepEqual(draft.problems.map((p) => p.code), ['ITEM_NOT_CLASSIFIED']);
});

test('not enough stock stops the bill, in the words a shopkeeper reads', async () => {
  const till = await makeTill({
    inventory: {
      async reserve() {
        return {
          ok: false,
          shortfalls: [
            {
              lineId: 'l1',
              itemId: 'CRATE-P',
              itemName: 'Plastic crate',
              warehouseName: 'Narela godown',
              available: '30',
              required: '70',
              shortfall: '40',
              unit: 'boxes',
            },
          ],
        };
      },
      async release() {},
      async issue() {},
      async returnToStock() {},
    },
  });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k10', input: crateBill() });
  const submitted = await till.service.submitForApproval(till.actor, draft.id);
  assert.equal(submitted.state, 'NEEDS_INFO');
  assert.equal(submitted.problems[0]?.messageId, 'stock.not_enough');
  assert.match(submitted.problems[0]?.message['en-IN'] ?? '', /40 boxes are missing/);
});

test('a bill above the business’s limit needs approval, and its maker cannot approve it', async () => {
  const till = await makeTill({ policy: { approvalRequiredAtOrAbove: inr(1000) } });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k11', input: crateBill() });

  await assert.rejects(
    () => till.service.finalise(till.actor, { idempotencyKey: 'f11', invoiceId: draft.id }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_APPROVAL_REQUIRED' && e.messageId === 'approval.needed',
  );

  const submitted = await till.service.submitForApproval(till.actor, draft.id);
  assert.equal(submitted.state, 'PENDING_APPROVAL');

  await assert.rejects(
    () => till.service.finalise(till.actor, { idempotencyKey: 'f11b', invoiceId: draft.id }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_SELF_APPROVAL',
  );

  const manager = actorWith(ALL_PERMISSIONS, { userId: RAJESH });
  const result = await till.service.finalise(manager, { idempotencyKey: 'f11c', invoiceId: draft.id });
  assert.equal(result.invoice.state, 'FINAL');
  assert.equal(result.invoice.approvedBy, RAJESH);
  assert.equal(result.invoice.finalisedBy, RAJESH);
});

test('a bill below the limit is issued without any approval step', async () => {
  const till = await makeTill({ policy: { approvalRequiredAtOrAbove: inr(5000) } });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k12', input: crateBill() });
  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f12', invoiceId: draft.id });
  assert.equal(result.invoice.state, 'FINAL');
  assert.equal(result.invoice.approvedBy, null);
});

test('cancelling inside the window posts a reversal and returns the goods', async () => {
  let returned = 0;
  const till = await makeTill({
    policy: { cancellationWindowDays: 7 },
    inventory: {
      async reserve() {
        return { ok: true, reservationId: 'r' };
      },
      async release() {},
      async issue() {},
      async returnToStock() {
        returned += 1;
      },
    },
  });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k13', input: crateBill() });
  const issued = await till.service.finalise(till.actor, { idempotencyKey: 'f13', invoiceId: draft.id });

  const cancelled = await till.service.cancel(till.actor, {
    idempotencyKey: 'c13',
    invoiceId: draft.id,
    reason: 'Customer changed the order before dispatch',
    today: on('2026-04-14'),
  });

  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.cancelReason, 'Customer changed the order before dispatch');
  assert.equal(returned, 1, 'the goods go back');

  const original = await till.ledger.getVoucher(till.actor, issued.voucherId);
  assert.equal(original?.state, 'REVERSED', 'the entry is undone, not deleted');

  const owed = await partyBalance(till.store.read(), till.actor.companyId, ABC);
  assert.equal(toDecimalString(owed.balance), '0.00');
  assert.ok((await trialBalance(till.store.read(), till.actor.companyId)).balanced);
  assert.equal(cancelled.number, issued.invoice.number, 'the number is kept, so the gap is explainable');
});

test('cancelling after the window is refused, and points at a return note instead', async () => {
  const till = await makeTill({ policy: { cancellationWindowDays: 7 } });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k14', input: crateBill() });
  await till.service.finalise(till.actor, { idempotencyKey: 'f14', invoiceId: draft.id });

  await assert.rejects(
    () =>
      till.service.cancel(till.actor, {
        idempotencyKey: 'c14',
        invoiceId: draft.id,
        reason: 'too late',
        today: on('2026-04-30'),
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_CANCEL_WINDOW_CLOSED',
  );
});

test('cancelling needs a written reason, and cancelling twice changes nothing', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k15', input: crateBill() });
  await till.service.finalise(till.actor, { idempotencyKey: 'f15', invoiceId: draft.id });

  await assert.rejects(
    () => till.service.cancel(till.actor, { idempotencyKey: 'c15', invoiceId: draft.id, reason: '   ', today: on('2026-04-11') }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_REASON_REQUIRED',
  );

  const once = await till.service.cancel(till.actor, {
    idempotencyKey: 'c15b',
    invoiceId: draft.id,
    reason: 'wrong customer',
    today: on('2026-04-11'),
  });
  const twice = await till.service.cancel(till.actor, {
    idempotencyKey: 'c15c',
    invoiceId: draft.id,
    reason: 'wrong customer',
    today: on('2026-04-11'),
  });
  assert.equal(twice.version, once.version, 'cancelling an already cancelled bill does nothing');
  const vouchers = await till.store.read().vouchers.list(till.actor.companyId, { types: ['REVERSAL'] });
  assert.equal(vouchers.length, 1);
});

test('an issued bill can never be edited', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k16', input: crateBill() });
  const issued = await till.service.finalise(till.actor, { idempotencyKey: 'f16', invoiceId: draft.id });
  await assert.rejects(
    () => till.service.updateDraft(till.actor, draft.id, { freight: inr(100) }, issued.invoice.version),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_NOT_EDITABLE' && e.messageId === 'final.cannot_edit',
  );
});

test('two people editing one draft do not overwrite each other', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k17', input: crateBill() });
  await till.service.updateDraft(till.actor, draft.id, { freight: inr(50) }, draft.version);
  await assert.rejects(
    () => till.service.updateDraft(till.actor, draft.id, { freight: inr(90) }, draft.version),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_CONCURRENT_EDIT',
  );
});

test('a failed finalisation writes nothing, and burns no number', async () => {
  const till = await makeTill({ seedAccounts: false });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k18', input: crateBill() });

  await assert.rejects(
    () => till.service.finalise(till.actor, { idempotencyKey: 'f18', invoiceId: draft.id }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_ACCOUNT_MISSING',
  );

  const after = await till.service.get(till.actor, draft.id);
  assert.equal(after?.state, 'DRAFT', 'the bill is untouched');
  assert.equal(after?.number, null);
  assert.equal((await till.store.read().vouchers.list(till.actor.companyId, {})).length, 0, 'nothing was posted');

  // The sequence was rolled back with everything else, so the next good bill is number one.
  const healthy = await makeTill();
  const good = await healthy.service.createDraft(healthy.actor, { idempotencyKey: 'k18b', input: crateBill() });
  const result = await healthy.service.finalise(healthy.actor, { idempotencyKey: 'f18b', invoiceId: good.id });
  assert.equal(result.invoice.number, 'INV/KB/2026-27/00001');
});

test('permission is checked for each step separately', async () => {
  const till = await makeTill();
  const clerk = actorWith(['sales.draft.write']);
  const draft = await till.service.createDraft(clerk, { idempotencyKey: 'k19', input: crateBill() });
  await assert.rejects(
    () => till.service.finalise(clerk, { idempotencyKey: 'f19', invoiceId: draft.id }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN' && e.messageId === 'permission.not_allowed',
  );
  const noDraft = actorWith(['sales.finalise']);
  await assert.rejects(
    () => till.service.createDraft(noDraft, { idempotencyKey: 'k19b', input: crateBill() }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});

test('one business cannot see or issue another business’s bills', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k20', input: crateBill() });
  const outsider = actorWith(ALL_PERMISSIONS, { companyId: OTHER });
  assert.equal(await till.service.get(outsider, draft.id), null);
  await assert.rejects(
    () => till.service.finalise(outsider, { idempotencyKey: 'f20', invoiceId: draft.id }),
    (e: unknown) => e instanceof DomainError && e.code === 'SALES_INVOICE_NOT_FOUND',
  );
});

test('a services bill takes its place of supply from the customer, under the approved rule', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k21a',
    input: crateBill({
      supplyKind: 'SERVICES',
      lines: [{ lineId: 'l1', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
    }),
  });
  // IGST Act section 12(2), approved against the register in #54: a service to a registered
  // customer counts where that customer is. ABC Traders is in Delhi, and so is the seller.
  assert.equal(draft.state, 'DRAFT');
  assert.equal(draft.pricing?.placeOfSupplyStateCode, '07');
  assert.equal(draft.pricing?.split, 'CGST_SGST');
});

test('a services bill to a customer with no recorded state is still refused', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k21c',
    input: crateBill({
      partyId: WALK_IN,
      supplyKind: 'SERVICES',
      lines: [{ lineId: 'l1', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
    }),
  });
  assert.equal(draft.state, 'NEEDS_INFO');
  assert.deepEqual(draft.problems.map((p) => p.code), ['PLACE_OF_SUPPLY_UNKNOWN']);
});

test('a services bill posts to the services income account and reserves no stock', async () => {
  let reserved = 0;
  const till = await makeTill({
    inventory: {
      async reserve() {
        reserved += 1;
        return { ok: true, reservationId: 'r' };
      },
      async release() {},
      async issue() {},
      async returnToStock() {},
    },
  });
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: 'k21',
    input: crateBill({
      supplyKind: 'SERVICES',
      placeOfSupplyStateCode: '07',
      lines: [{ lineId: 'l1', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
    }),
  });
  await till.service.submitForApproval(till.actor, draft.id);
  assert.equal(reserved, 0, 'services hold no stock');

  // Whoever sends a bill for approval cannot be the one who approves it, so a second person does.
  const manager = actorWith(ALL_PERMISSIONS, { userId: RAJESH });
  const result = await till.service.finalise(manager, { idempotencyKey: 'f21', invoiceId: draft.id });
  const voucher = await till.ledger.getVoucher(till.actor, result.voucherId);
  assert.ok(voucher?.lines.some((l) => l.accountId === till.account('SALES_SERVICES')));
  assert.equal(voucher?.lines.some((l) => l.accountId === till.account('SALES_GOODS')), false);
});

test('the government step runs after the books are already safe, and a failure does not unmake the bill', async () => {
  const till = await makeTill({
    compliance: {
      async onInvoiceFinalised() {
        return [{ kind: 'E_INVOICE' as const, status: 'FAILED' as const, reference: null, message: 'The portal did not answer.' }];
      },
      async onInvoiceCancelled() {},
    },
  });
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k22', input: crateBill() });
  const result = await till.service.finalise(till.actor, { idempotencyKey: 'f22', invoiceId: draft.id });

  assert.equal(result.invoice.state, 'FINAL', 'the bill is issued whatever the portal did');
  assert.deepEqual(result.registrations, [{ kind: 'E_INVOICE', status: 'FAILED', reference: null }]);
  assert.ok((await trialBalance(till.store.read(), till.actor.companyId)).balanced);
});

test('every material step is recorded, with the actor and the amount', async () => {
  const till = await makeTill();
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: 'k23', input: crateBill() });
  const issued = await till.service.finalise(till.actor, { idempotencyKey: 'f23', invoiceId: draft.id });
  await till.service.cancel(till.actor, {
    idempotencyKey: 'c23',
    invoiceId: draft.id,
    reason: 'duplicate bill',
    today: on('2026-04-11'),
  });

  const actions = till.audit.forSubject(draft.id).map((e) => e.action);
  assert.deepEqual(actions, ['sales.draft_created', 'sales.invoice_finalised', 'sales.invoice_cancelled']);
  const finalised = till.audit.forSubject(draft.id)[1];
  assert.equal(finalised?.actorId, PRIYA);
  assert.equal(finalised?.details.value, '1180.00');
  assert.equal(finalised?.details.number, issued.invoice.number);
  const cancelled = till.audit.forSubject(draft.id)[2];
  assert.equal(cancelled?.overrideReason, 'duplicate bill');
});
