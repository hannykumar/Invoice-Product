/**
 * Issue #20 [E20] acceptance criteria, enforced automatically.
 *
 *  - "Outstanding balances equal invoice less accepted allocations"
 *  - "Cheque status changes do not lose history"
 *  - "One payment can be allocated across invoices with audit trail"
 *
 * plus the required partial, advance, overpayment, bounced-cheque, rounding and reversal tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, fromDecimalString, toDecimalString } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';
import { ageingOf, overdueSummaries } from '../src/ageing.ts';
import { suggestAllocation } from '../src/allocation.ts';
import { buildStatement } from '../src/statement.ts';
import { currentChequeState } from '../src/model.ts';
import { unallocated } from '../src/service.ts';
import { ABC, ALL_PERMISSIONS, COMPANY, NASHIK, OTHER, actorWith, bill, inr, makeDesk, on } from './fixtures.ts';

const threeBills = () => [
  bill('INV/41', inr(30000), '2026-04-10', '2026-05-10'),
  bill('INV/42', inr(20000), '2026-04-15', '2026-05-15'),
  bill('INV/44', inr(100000), '2026-04-20', '2026-05-20'),
];

test('outstanding is the bill less what has been applied, worked out every time', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/44', inr(100000), '2026-04-20', '2026-05-20')]);

  const before = await desk.service.position(desk.actor, ABC, on('2026-05-01'));
  assert.equal(toDecimalString(before.totalOutstanding), '100000.00');
  assert.equal(before.documents[0]?.status, 'OPEN');

  await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'BANK_TRANSFER',
    amount: inr(30000), date: on('2026-04-28'), bankAccountCode: '1121', reference: 'UTR-1',
    allocations: [{ documentId: 'INV/44', documentNumber: 'INV/44', amount: inr(30000) }],
  });

  const after = await desk.service.position(desk.actor, ABC, on('2026-05-01'));
  assert.equal(toDecimalString(after.totalOutstanding), '70000.00');
  assert.equal(after.documents[0]?.status, 'PARTLY_PAID', 'a part payment never marks a bill paid');
  assert.equal(toDecimalString(after.documents[0]?.allocated ?? inr(0)), '30000.00');

  const owed = await partyBalance(desk.store.read(), COMPANY, ABC);
  assert.equal(toDecimalString(owed.balance), '-30000.00', 'the ledger shows only what was received');
  assert.ok((await trialBalance(desk.store.read(), COMPANY)).balanced);
});

test('one payment settles several bills, and every version is on the record', async () => {
  const desk = await makeDesk();
  desk.documents.set(threeBills());

  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'BANK_TRANSFER',
    amount: inr(50000), date: on('2026-05-12'), bankAccountCode: '1121',
    allocations: [
      { documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(30000) },
      { documentId: 'INV/42', documentNumber: 'INV/42', amount: inr(20000) },
    ],
  });

  const position = await desk.service.position(desk.actor, ABC, on('2026-05-12'));
  const byNumber = new Map(position.documents.map((d) => [d.document.number, d]));
  assert.equal(byNumber.get('INV/41')?.status, 'SETTLED');
  assert.equal(byNumber.get('INV/42')?.status, 'SETTLED');
  assert.equal(byNumber.get('INV/44')?.status, 'OPEN');
  assert.equal(toDecimalString(position.totalOutstanding), '100000.00');

  // Re-deciding which bills it settles does not move money again.
  const reallocated = await desk.service.allocate(desk.actor, payment.id, [
    { documentId: 'INV/44', documentNumber: 'INV/44', amount: inr(50000) },
  ], payment.version);
  const after = await desk.service.position(desk.actor, ABC, on('2026-05-12'));
  assert.equal(toDecimalString(after.totalOutstanding), '100000.00', 'the total owed is unchanged');
  assert.equal(after.documents.find((d) => d.document.number === 'INV/44')?.status, 'PARTLY_PAID');
  assert.equal(reallocated.version, payment.version + 1);

  const audited = desk.audit.forSubject(payment.id).map((e) => e.action);
  assert.deepEqual(audited, ['payments.received', 'payments.allocated']);
  const allocationEvent = desk.audit.forSubject(payment.id)[1];
  assert.equal(allocationEvent?.details['INV/44'], '50000.00', 'the audit says which bill got what');
});

test('money cannot be applied to a bill twice over, or beyond what was received', async () => {
  const desk = await makeDesk();
  desk.documents.set(threeBills());

  await assert.rejects(
    () => desk.service.recordPayment(desk.actor, {
      idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(30000), date: on('2026-05-12'),
      allocations: [{ documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(40000) }],
    }),
    (e: unknown) => e instanceof DomainError && e.code === 'ALLOCATION_EXCEEDS_OUTSTANDING',
  );

  await assert.rejects(
    () => desk.service.recordPayment(desk.actor, {
      idempotencyKey: 'r2', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(30000), date: on('2026-05-12'),
      allocations: [
        { documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(30000) },
        { documentId: 'INV/42', documentNumber: 'INV/42', amount: inr(10000) },
      ],
    }),
    (e: unknown) => e instanceof DomainError && e.code === 'ALLOCATION_EXCEEDS_PAYMENT',
  );

  await assert.rejects(
    () => desk.service.recordPayment(desk.actor, {
      idempotencyKey: 'r3', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(30000), date: on('2026-05-12'),
      allocations: [
        { documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(15000) },
        { documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(15000) },
      ],
    }),
    (e: unknown) => e instanceof DomainError && e.code === 'ALLOCATION_DUPLICATE_DOCUMENT',
  );
});

test('money that arrives before any bill sits visibly on account', async () => {
  const desk = await makeDesk();
  desk.documents.set([]);

  const advance = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'adv', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(10000), date: on('2026-04-01'),
  });
  assert.deepEqual(advance.allocations, [], 'nothing is guessed at');
  assert.equal(toDecimalString(unallocated(advance)), '10000.00');

  const position = await desk.service.position(desk.actor, ABC, on('2026-04-02'));
  assert.equal(toDecimalString(position.onAccount), '10000.00');
  assert.equal(toDecimalString(position.totalOutstanding), '0.00');

  // The customer's balance already moved, even though no bill has claimed it.
  const owed = await partyBalance(desk.store.read(), COMPANY, ABC);
  assert.equal(toDecimalString(owed.balance), '-10000.00');
});

test('an overpayment leaves the extra on account rather than being forced onto a bill', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(30000), '2026-04-10', '2026-05-10')]);

  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'over', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(50000), date: on('2026-05-12'),
    allocations: [{ documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(30000) }],
  });
  assert.equal(toDecimalString(unallocated(payment)), '20000.00');

  const position = await desk.service.position(desk.actor, ABC, on('2026-05-12'));
  assert.equal(toDecimalString(position.totalOutstanding), '0.00');
  assert.equal(toDecimalString(position.onAccount), '20000.00');
});

test('the suggested split takes the oldest bill first, and stops rather than overreaching', async () => {
  const desk = await makeDesk();
  desk.documents.set(threeBills());
  const suggestion = await desk.service.suggest(desk.actor, ABC, inr(45000), on('2026-05-12'));

  assert.deepEqual(suggestion.allocations.map((a) => a.documentNumber), ['INV/41', 'INV/42']);
  assert.equal(toDecimalString(suggestion.allocations[0]?.amount ?? inr(0)), '30000.00');
  assert.equal(toDecimalString(suggestion.allocations[1]?.amount ?? inr(0)), '15000.00');
  assert.equal(toDecimalString(suggestion.leftOver), '0.00');

  const big = suggestAllocation(inr(200000), (await desk.service.position(desk.actor, ABC, on('2026-05-12'))).documents);
  assert.equal(toDecimalString(big.leftOver), '50000.00', 'what no bill can absorb is left over, not forced');
});

test('a cheque is not bank balance until it clears', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/44', inr(100000), '2026-04-20', '2026-05-20')]);

  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'chq', direction: 'RECEIPT', partyId: ABC, mode: 'CHEQUE',
    amount: inr(30000), date: on('2026-04-20'),
    cheque: { number: '112233', chequeDate: on('2026-04-20'), bankName: 'SBI' },
    allocations: [{ documentId: 'INV/44', documentNumber: 'INV/44', amount: inr(30000) }],
  });

  const chequesInHand = desk.store.read();
  const held = await desk.service.position(desk.actor, ABC, on('2026-04-21'));
  assert.equal(toDecimalString(held.chequesNotCleared), '30000.00');
  assert.equal(toDecimalString(held.totalOutstanding), '70000.00', 'their dues fall the moment the cheque is taken');

  const voucher = await desk.ledger.getVoucher(desk.actor, payment.voucherId ?? ('' as never));
  const chequeAccount = voucher?.lines.find((l) => l.debit.minor > 0n);
  assert.ok(chequeAccount !== undefined);
  void chequesInHand;

  const deposited = await desk.service.recordChequeEvent(desk.actor, payment.id, 'DEPOSITED', { on: on('2026-04-22') }, payment.version);
  const cleared = await desk.service.recordChequeEvent(
    desk.actor, payment.id, 'CLEARED', { on: on('2026-04-24'), bankAccountCode: '1121' }, deposited.version,
  );

  assert.equal(currentChequeState(cleared.cheque as NonNullable<typeof cleared.cheque>), 'CLEARED');
  const afterClearing = await desk.service.position(desk.actor, ABC, on('2026-04-25'));
  assert.equal(toDecimalString(afterClearing.chequesNotCleared), '0.00');
  assert.ok((await trialBalance(desk.store.read(), COMPANY)).balanced);
});

test('a bounced cheque restores the dues and keeps the whole history', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/44', inr(100000), '2026-04-20', '2026-05-20')]);

  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'chq', direction: 'RECEIPT', partyId: ABC, mode: 'CHEQUE',
    amount: inr(30000), date: on('2026-04-20'),
    cheque: { number: '112233', chequeDate: on('2026-04-20') },
    allocations: [{ documentId: 'INV/44', documentNumber: 'INV/44', amount: inr(30000) }],
  });
  const deposited = await desk.service.recordChequeEvent(desk.actor, payment.id, 'DEPOSITED', { on: on('2026-04-22') }, payment.version);
  const bounced = await desk.service.recordChequeEvent(
    desk.actor, payment.id, 'BOUNCED', { on: on('2026-04-24'), note: 'Funds insufficient' }, deposited.version,
  );

  assert.equal(bounced.state, 'REVERSED');
  assert.deepEqual(bounced.allocations, [], 'a cheque that did not clear settles nothing');
  assert.equal(currentChequeState(bounced.cheque as NonNullable<typeof bounced.cheque>), 'BOUNCED');

  // Nothing was overwritten.
  const history = (bounced.cheque as NonNullable<typeof bounced.cheque>).history.map((h) => h.state);
  assert.deepEqual(history, ['PENDING', 'DEPOSITED', 'BOUNCED']);
  assert.equal((bounced.cheque as NonNullable<typeof bounced.cheque>).history[2]?.note, 'Funds insufficient');

  const position = await desk.service.position(desk.actor, ABC, on('2026-04-25'));
  assert.equal(toDecimalString(position.totalOutstanding), '100000.00', 'the dues are back');

  const original = await desk.ledger.getVoucher(desk.actor, payment.voucherId ?? ('' as never));
  assert.equal(original?.state, 'REVERSED', 'the receipt is undone, not deleted');
  assert.ok((await trialBalance(desk.store.read(), COMPANY)).balanced);
});

test('a cheque cannot skip or repeat a step, and a bounce always says what the bank said', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/44', inr(100000), '2026-04-20', '2026-05-20')]);
  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'chq', direction: 'RECEIPT', partyId: ABC, mode: 'CHEQUE',
    amount: inr(30000), date: on('2026-04-20'), cheque: { number: '1', chequeDate: on('2026-04-20') },
  });

  await assert.rejects(
    () => desk.service.recordChequeEvent(desk.actor, payment.id, 'CLEARED', { on: on('2026-04-22'), bankAccountCode: '1121' }, payment.version),
    (e: unknown) => e instanceof DomainError && e.code === 'CHEQUE_INVALID_STEP',
  );
  await assert.rejects(
    () => desk.service.recordChequeEvent(desk.actor, payment.id, 'BOUNCED', { on: on('2026-04-22'), note: '  ' }, payment.version),
    (e: unknown) => e instanceof DomainError && e.code === 'CHEQUE_REASON_REQUIRED',
  );

  const cancelled = await desk.service.recordChequeEvent(
    desk.actor, payment.id, 'CANCELLED', { on: on('2026-04-22'), note: 'Customer asked to tear it up' }, payment.version,
  );
  await assert.rejects(
    () => desk.service.recordChequeEvent(desk.actor, payment.id, 'DEPOSITED', { on: on('2026-04-23') }, cancelled.version),
    (e: unknown) => e instanceof DomainError && e.code === 'CHEQUE_INVALID_STEP',
  );
});

test('a payment recorded twice moves money once', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(30000), '2026-04-10', '2026-05-10')]);
  const first = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'retry', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(10000), date: on('2026-05-01'),
  });
  const second = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'retry', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(10000), date: on('2026-05-01'),
  });
  assert.equal(second.id, first.id);
  const owed = await partyBalance(desk.store.read(), COMPANY, ABC);
  assert.equal(toDecimalString(owed.balance), '-10000.00');
});

test('an undone payment restores the dues and keeps both entries', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(30000), '2026-04-10', '2026-05-10')]);
  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(30000), date: on('2026-05-01'),
    allocations: [{ documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(30000) }],
  });

  await assert.rejects(
    () => desk.service.reversePayment(desk.actor, payment.id, { on: on('2026-05-02'), reason: '   ' }),
    (e: unknown) => e instanceof DomainError && e.code === 'PAYMENT_REASON_REQUIRED',
  );

  const reversed = await desk.service.reversePayment(desk.actor, payment.id, {
    on: on('2026-05-02'), reason: 'Recorded against the wrong customer',
  });
  assert.equal(reversed.state, 'REVERSED');
  assert.deepEqual(reversed.allocations, []);
  const position = await desk.service.position(desk.actor, ABC, on('2026-05-03'));
  assert.equal(toDecimalString(position.totalOutstanding), '30000.00');
  assert.ok((await trialBalance(desk.store.read(), COMPANY)).balanced);

  // Undoing it twice changes nothing.
  const again = await desk.service.reversePayment(desk.actor, payment.id, { on: on('2026-05-02'), reason: 'again' });
  assert.equal(again.version, reversed.version);
});

test('money paid to a supplier reduces what we owe', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('NF/1187', inr(50000), '2026-04-04', '2026-05-04', NASHIK)]);
  await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'p1', direction: 'PAYMENT', partyId: NASHIK, mode: 'BANK_TRANSFER',
    amount: inr(20000), date: on('2026-04-25'), bankAccountCode: '1121',
    allocations: [{ documentId: 'NF/1187', documentNumber: 'NF/1187', amount: inr(20000) }],
  });
  const position = await desk.service.position(desk.actor, NASHIK, on('2026-04-26'));
  assert.equal(toDecimalString(position.totalOutstanding), '30000.00');
  const owed = await partyBalance(desk.store.read(), COMPANY, NASHIK);
  assert.equal(toDecimalString(owed.balance), '20000.00');
  assert.ok((await trialBalance(desk.store.read(), COMPANY)).balanced);
});

test('a bank transfer must say which account, and a heading is refused', async () => {
  const desk = await makeDesk();
  desk.documents.set([]);
  await assert.rejects(
    () => desk.service.recordPayment(desk.actor, {
      idempotencyKey: 'b1', direction: 'RECEIPT', partyId: ABC, mode: 'BANK_TRANSFER', amount: inr(100), date: on('2026-05-01'),
    }),
    (e: unknown) => e instanceof DomainError && e.code === 'PAYMENT_BANK_ACCOUNT_REQUIRED',
  );
  await assert.rejects(
    () => desk.service.recordPayment(desk.actor, {
      idempotencyKey: 'b2', direction: 'RECEIPT', partyId: ABC, mode: 'BANK_TRANSFER', amount: inr(100), date: on('2026-05-01'),
      bankAccountCode: '1120',
    }),
    (e: unknown) => e instanceof DomainError && e.code === 'PAYMENT_BANK_ACCOUNT_IS_HEADING',
  );
});

test('writing off money is an expense with a name on it, never a disappearance', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(30000), '2026-04-10', '2026-05-10')]);

  await assert.rejects(
    () => desk.service.writeOff(desk.actor, { idempotencyKey: 'w1', partyId: ABC, amount: inr(5000), on: on('2026-08-01'), reason: '' }),
    (e: unknown) => e instanceof DomainError && e.code === 'WRITE_OFF_REASON_REQUIRED',
  );
  await assert.rejects(
    () => desk.service.writeOff(desk.actor, { idempotencyKey: 'w2', partyId: ABC, amount: inr(50000), on: on('2026-08-01'), reason: 'gone' }),
    (e: unknown) => e instanceof DomainError && e.code === 'WRITE_OFF_EXCEEDS_OUTSTANDING',
  );
  const clerk = actorWith(ALL_PERMISSIONS.filter((p) => p !== 'payments.write_off'));
  await assert.rejects(
    () => desk.service.writeOff(clerk, { idempotencyKey: 'w3', partyId: ABC, amount: inr(5000), on: on('2026-08-01'), reason: 'shop closed' }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );

  const voucherId = await desk.service.writeOff(desk.actor, {
    idempotencyKey: 'w4', partyId: ABC, amount: inr(5000), on: on('2026-08-01'), reason: 'Shop closed down, owner not traceable',
  });
  const voucher = await desk.ledger.getVoucher(desk.actor, voucherId);
  assert.ok(voucher?.lines.some((l) => l.narration?.includes('Shop closed down')));
  const owed = await partyBalance(desk.store.read(), COMPANY, ABC);
  assert.equal(toDecimalString(owed.balance), '-5000.00');
  const audited = desk.audit.events.find((e) => e.action === 'payments.written_off');
  assert.match(audited?.overrideReason ?? '', /not traceable/);
  assert.ok((await trialBalance(desk.store.read(), COMPANY)).balanced);
});

test('rounding: a payment split three ways adds back to exactly what was received', async () => {
  const desk = await makeDesk();
  desk.documents.set([
    bill('A', fromDecimalString('333.34'), '2026-04-01', '2026-05-01'),
    bill('B', fromDecimalString('333.33'), '2026-04-02', '2026-05-02'),
    bill('C', fromDecimalString('333.33'), '2026-04-03', '2026-05-03'),
  ]);
  const suggestion = await desk.service.suggest(desk.actor, ABC, fromDecimalString('1000.00'), on('2026-05-12'));
  const total = suggestion.allocations.reduce((a, x) => a + x.amount.minor, 0n);
  assert.equal(total, 100000n, 'the parts add back to exactly the amount received');
  assert.equal(toDecimalString(suggestion.leftOver), '0.00');

  await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'CASH',
    amount: fromDecimalString('1000.00'), date: on('2026-05-12'), allocations: suggestion.allocations,
  });
  const position = await desk.service.position(desk.actor, ABC, on('2026-05-12'));
  assert.equal(toDecimalString(position.totalOutstanding), '0.00');
});

test('ageing counts from the due date, not the bill date', async () => {
  const desk = await makeDesk();
  desk.documents.set([
    bill('INV/41', inr(10000), '2026-01-01', '2026-02-01'),
    bill('INV/42', inr(20000), '2026-04-01', '2026-05-01'),
    bill('INV/43', inr(30000), '2026-05-01', '2026-07-01'),
  ]);
  const position = await desk.service.position(desk.actor, ABC, on('2026-05-20'));
  const buckets = ageingOf(position.documents, on('2026-05-20'));
  const byLabel = new Map(buckets.map((b) => [b.label['en-IN'], toDecimalString(b.amount)]));
  assert.equal(byLabel.get('Not due yet'), '30000.00', 'a bill due in July is not late in May');
  assert.equal(byLabel.get('Up to 30 days late'), '20000.00');
  assert.equal(byLabel.get('More than 90 days late'), '10000.00');
});

test('the home screen answers "who owes me money", worst first', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(10000), '2026-01-01', '2026-02-01')]);
  const abc = await desk.service.position(desk.actor, ABC, on('2026-05-20'));
  const summaries = overdueSummaries([abc], () => 'ABC Traders', (m) => `₹${toDecimalString(m)}`);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]?.sentence['en-IN'] ?? '', /ABC Traders still owes you ₹10000\.00, and the oldest bill is 108 days late\./);
  assert.deepEqual(lintUserFacingText(summaries[0]?.sentence['en-IN'] ?? '', { locale: 'en-IN' }), []);
});

test('a statement reads like a statement, and says what is still due in one sentence', async () => {
  const desk = await makeDesk();
  const documents = [bill('INV/41', inr(30000), '2026-04-10', '2026-05-10'), bill('INV/42', inr(20000), '2026-04-15', '2026-05-15')];
  desk.documents.set(documents);
  await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'CHEQUE', amount: inr(30000), date: on('2026-04-20'),
    cheque: { number: '112233', chequeDate: on('2026-04-20') },
    allocations: [{ documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(30000) }],
  });

  const statement = buildStatement(
    ABC, 'ABC Traders', documents, await desk.service.paymentsFor(desk.actor, ABC),
    { from: on('2026-04-01'), to: on('2026-04-30') },
  );
  assert.equal(toDecimalString(statement.openingBalance), '0.00');
  assert.deepEqual(statement.lines.map((l) => l.kind), ['BILL', 'BILL', 'PAYMENT']);
  assert.equal(toDecimalString(statement.closingBalance), '20000.00');
  assert.match(statement.summary['en-IN'], /ABC Traders still owes you ₹20,000\.00 as on 30 April 2026\./);
  assert.equal(statement.lines[2]?.note?.['en-IN'], 'Cheque not cleared yet', 'an uncleared cheque says so on the statement');
  assert.deepEqual(lintUserFacingText(statement.summary['en-IN'], { locale: 'en-IN' }), []);
});

test('one business cannot see or touch another’s payments', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(30000), '2026-04-10', '2026-05-10')]);
  const payment = await desk.service.recordPayment(desk.actor, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(10000), date: on('2026-05-01'),
  });
  const outsider = actorWith(ALL_PERMISSIONS, OTHER);
  assert.equal(await desk.service.payment(outsider, payment.id), null);
  await assert.rejects(
    () => desk.service.reversePayment(outsider, payment.id, { on: on('2026-05-02'), reason: 'not mine' }),
    (e: unknown) => e instanceof DomainError && e.code === 'PAYMENT_NOT_FOUND',
  );
});

test('recording and allocating are separate permissions', async () => {
  const desk = await makeDesk();
  desk.documents.set([bill('INV/41', inr(30000), '2026-04-10', '2026-05-10')]);
  const recorder = actorWith(['ledger.post.receipt', 'payments.record']);
  const payment = await desk.service.recordPayment(recorder, {
    idempotencyKey: 'r1', direction: 'RECEIPT', partyId: ABC, mode: 'CASH', amount: inr(10000), date: on('2026-05-01'),
  });
  await assert.rejects(
    () => desk.service.allocate(recorder, payment.id, [{ documentId: 'INV/41', documentNumber: 'INV/41', amount: inr(10000) }], payment.version),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});
