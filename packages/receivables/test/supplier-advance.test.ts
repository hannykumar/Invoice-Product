/**
 * Issue #261 — paying a supplier before their bill, as a clearly marked advance.
 *
 *  - No advance without the person's own choice: money paid to a supplier that no bill takes is refused.
 *  - The advance is something the business owns ("Advances paid to suppliers"), not a negative amount
 *    owed hidden in the supplier's account, and it carries no GST.
 *  - Set against their next bill, it moves across in the books: owed = bill − advance used.
 *  - Every step is in the audit trail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, DomainError, toDecimalString } from '@invoice/kernel';
import { accountBalance, trialBalance } from '@invoice/ledger';
import { ABC, COMPANY, NASHIK, bill, inr, makeDesk, on } from './fixtures.ts';

const ADVANCES = asId<'Account'>(`${COMPANY}:acc:1460`);
const INPUT_IGST = asId<'Account'>(`${COMPANY}:acc:1430`);

const pay = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: 'adv-1', direction: 'PAYMENT' as const, partyId: NASHIK, mode: 'BANK_TRANSFER' as const,
  amount: inr(10000), date: on('2026-09-20'), bankAccountCode: '1121',
  ...overrides,
});

test('#261: money paid to a supplier with no bill is refused unless it is chosen as an advance', async () => {
  const desk = await makeDesk();
  desk.documents.set([]);
  await assert.rejects(
    desk.service.recordPayment(desk.actor, pay()),
    (error: unknown) => error instanceof DomainError && error.code === 'PAYMENT_ADVANCE_NOT_CHOSEN',
  );
  assert.equal((await desk.service.paymentsFor(desk.actor, NASHIK)).length, 0, 'nothing was recorded');

  const paid = await desk.service.recordPayment(desk.actor, pay({ advanceToSupplier: true }));
  assert.equal(paid.advanceToSupplier, true);

  // Something the business owns, in its own account; the supplier's own account is untouched.
  const read = desk.store.read();
  assert.equal(toDecimalString((await accountBalance(read, COMPANY, ADVANCES)).balance), '10000.00');
  const supplierAccount = await read.accounts.findByPartyId(COMPANY, NASHIK);
  assert.equal(toDecimalString((await accountBalance(read, COMPANY, supplierAccount!.id)).balance), '0.00');
  // No GST of any kind.
  assert.equal(toDecimalString((await accountBalance(read, COMPANY, INPUT_IGST)).balance), '0.00');
  const voucher = await desk.ledger.getVoucher(desk.actor, paid.voucherId!);
  assert.deepEqual(voucher!.lines.map((line) => String(line.accountId)).sort(), [`${COMPANY}:acc:1121`, String(ADVANCES)].sort());
  assert.ok((await trialBalance(read, COMPANY)).balanced);

  const position = await desk.service.position(desk.actor, NASHIK, on('2026-09-20'));
  assert.equal(toDecimalString(position.totalOutstanding), '0.00', 'owed never goes below zero');
  assert.equal(toDecimalString(position.advancesPaid), '10000.00');
  assert.equal(toDecimalString(position.onAccount), '0.00', 'our money with them is not "money with you"');

  assert.deepEqual(desk.audit.forSubject(paid.id).map((e) => e.action), ['payments.advance_paid', 'payments.paid']);
});

test('#261: the advance comes off their next bill — ₹37,760 − ₹10,000 = ₹27,760 — once, however often it is asked', async () => {
  const desk = await makeDesk();
  desk.documents.set([]);
  const paid = await desk.service.recordPayment(desk.actor, pay({ advanceToSupplier: true }));
  desk.documents.set([bill('SRS-101', inr(37760), '2026-09-27', '2026-10-27', NASHIK)]);

  const command = { partyId: NASHIK, documentId: 'SRS-101', documentNumber: 'SRS-101', amount: inr(10000), date: on('2026-09-27'), idempotencyKey: 'bill-srs-101' };
  const used = await desk.service.useSupplierAdvance(desk.actor, command);
  assert.deepEqual(used.map((u) => [u.paymentId, toDecimalString(u.amount)]), [[paid.id, '10000.00']]);
  const again = await desk.service.useSupplierAdvance(desk.actor, command);
  assert.equal(again.length, 1);
  assert.equal(again[0]?.voucherId, null, 'a retry posts nothing new');

  const position = await desk.service.position(desk.actor, NASHIK, on('2026-09-27'));
  assert.equal(toDecimalString(position.totalOutstanding), '27760.00');
  assert.equal(toDecimalString(position.advancesPaid), '0.00');
  const read = desk.store.read();
  assert.equal(toDecimalString((await accountBalance(read, COMPANY, ADVANCES)).balance), '0.00');
  assert.ok((await trialBalance(read, COMPANY)).balanced);
  assert.deepEqual(desk.audit.forSubject(paid.id).map((e) => e.action), ['payments.advance_paid', 'payments.paid', 'payments.advance_used']);

  // Once used, the advance cannot be undone on its own, nor re-pointed at another bill without the books.
  const latest = (await desk.service.payment(desk.actor, paid.id))!;
  await assert.rejects(desk.service.reversePayment(desk.actor, paid.id, { on: on('2026-09-28'), reason: 'mistake' }),
    (error: unknown) => error instanceof DomainError && error.code === 'PAYMENT_ADVANCE_ALREADY_USED');
  await assert.rejects(desk.service.allocate(desk.actor, paid.id, [], latest.version),
    (error: unknown) => error instanceof DomainError && error.code === 'PAYMENT_IS_ADVANCE');
});

test('#261: a bill smaller than the advance uses part of it; the rest stays an advance', async () => {
  const desk = await makeDesk();
  desk.documents.set([]);
  await desk.service.recordPayment(desk.actor, pay({ advanceToSupplier: true }));
  desk.documents.set([bill('NF/5', inr(4000), '2026-09-27', '2026-10-27', NASHIK)]);
  await desk.service.useSupplierAdvance(desk.actor, { partyId: NASHIK, documentId: 'NF/5', documentNumber: 'NF/5', amount: inr(10000), date: on('2026-09-27'), idempotencyKey: 'nf5' });
  const position = await desk.service.position(desk.actor, NASHIK, on('2026-09-27'));
  assert.equal(toDecimalString(position.totalOutstanding), '0.00');
  assert.equal(toDecimalString(position.advancesPaid), '6000.00');
  assert.equal(toDecimalString((await accountBalance(desk.store.read(), COMPANY, ADVANCES)).balance), '6000.00');
});

test('#261: part against a bill, the rest as an advance, in one payment', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('NF/9', inr(5000), '2026-09-01', '2026-10-01', NASHIK)]);
  const paid = await desk.service.recordPayment(desk.actor, pay({
    advanceToSupplier: true, amount: inr(8000),
    allocations: [{ documentId: 'NF/9', documentNumber: 'NF/9', amount: inr(5000) }],
  }));
  const position = await desk.service.position(desk.actor, NASHIK, on('2026-09-20'));
  assert.equal(toDecimalString(position.totalOutstanding), '0.00');
  assert.equal(toDecimalString(position.advancesPaid), '3000.00');
  const voucher = await desk.ledger.getVoucher(desk.actor, paid.voucherId!);
  const debit = (id: string) => toDecimalString(voucher!.lines.find((line) => String(line.accountId) === id)!.debit);
  assert.equal(debit(String(ADVANCES)), '3000.00');
  assert.equal(debit(`${COMPANY}:acc:2101`), '5000.00');
});

test('#261: money from a customer is unchanged — on account, never an advance to a supplier', async () => {
  const desk = await makeDesk();
  desk.documents.set([]);
  await desk.service.recordPayment(desk.actor, { idempotencyKey: 'r-abc', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(500), date: on('2026-09-20') });
  const position = await desk.service.position(desk.actor, ABC, on('2026-09-20'));
  assert.equal(toDecimalString(position.onAccount), '500.00');
  assert.equal(toDecimalString(position.advancesPaid), '0.00');
});
