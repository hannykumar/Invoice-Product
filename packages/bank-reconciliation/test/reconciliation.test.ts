import assert from 'node:assert/strict';
import test from 'node:test';
import { BankReconciliationService, type BankLine, type BookPayment } from '../src/index.ts';

const context = (companyId = 'co') => ({ companyId, actorId: 'owner', permissions: new Set(['bank.reconcile', 'bank.reconcile.confirm']) });
const bank = (id: string, amountPaise: bigint, overrides: Partial<BankLine> = {}): BankLine => ({ id, companyId: 'co', bookedOn: '2026-08-20', direction: 'RECEIPT', amountPaise, description: 'NEFT ABC', reference: `REF-${id}`, fingerprint: `fp-${id}`, ...overrides });
const payment = (id: string, amountPaise: bigint, overrides: Partial<BookPayment> = {}): BookPayment => ({ id, companyId: 'co', direction: 'RECEIPT', amountPaise, date: '2026-08-20', reference: `REF-${id}`, ...overrides });

test('an exact unique match is automatic and shows no remaining difference', () => {
  const service = new BankReconciliationService();
  const result = service.reconcile(context(), [bank('one', 30_000_00n)], [payment('one', 30_000_00n)]);
  assert.equal(result.matches[0]?.status, 'AUTO_MATCHED');
  assert.equal(result.matches[0]?.remainingBankPaise, 0n);
  assert.deepEqual(service.auditFor(context(), result.matches[0]!.id).map((event) => event.action), ['reconciliation.auto_matched']);
});

test('one bank transfer can match several part-payments and several bank lines can match one payment', () => {
  const oneToMany = new BankReconciliationService().reconcile(context(), [bank('combined', 30_000_00n, { reference: null })], [payment('a', 10_000_00n, { reference: null }), payment('b', 20_000_00n, { reference: null })]);
  assert.equal(oneToMany.matches[0]?.paymentIds.length, 2);
  const manyToOne = new BankReconciliationService().reconcile(context(), [bank('a', 12_000_00n, { reference: null }), bank('b', 18_000_00n, { reference: null })], [payment('combined', 30_000_00n, { reference: null })]);
  assert.equal(manyToOne.matches[0]?.bankTransactionIds.length, 2);
});

test('equally plausible matches remain ambiguous until a person confirms one', () => {
  const service = new BankReconciliationService();
  const result = service.reconcile(context(), [bank('bank', 30_000_00n, { reference: null })], [payment('a', 30_000_00n, { reference: null }), payment('b', 30_000_00n, { reference: null })]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.exceptions[0]?.kind, 'AMBIGUOUS');
  const chosen = service.confirm(context(), result.candidates[0]!.id);
  assert.equal(chosen.status, 'CONFIRMED');
  assert.equal(service.unmatch(context(), chosen.id, 'Customer confirmed the other transfer.').status, 'UNMATCHED');
  assert.deepEqual(service.auditFor(context(), chosen.id).map((event) => event.action), ['reconciliation.confirmed', 'reconciliation.unmatched']);
});

test('missing sides, wrong dates, reversals and duplicate statement lines become visible exceptions', () => {
  const service = new BankReconciliationService();
  const lines = [
    bank('missing-book', 5_000_00n),
    bank('wrong-date', 7_000_00n, { bookedOn: '2026-08-29', reference: 'UTR-7' }),
    bank('reversal', 2_000_00n, { description: 'UPI payment reversed' }),
    bank('duplicate', 1_000_00n, { fingerprint: 'same' }),
    bank('duplicate-copy', 1_000_00n, { fingerprint: 'same' }),
  ];
  const payments = [payment('missing-bank', 9_000_00n), payment('wrong-date-payment', 7_000_00n, { date: '2026-08-10', reference: 'UTR-7' })];
  const result = service.reconcile(context(), lines, payments);
  const kinds = new Set(result.exceptions.map((item) => item.kind));
  assert.deepEqual(kinds, new Set(['MISSING_BOOK', 'MISSING_BANK', 'WRONG_DATE', 'POSSIBLE_REVERSAL', 'DUPLICATE_BANK_TRANSACTION']));
  assert.ok(result.suggestedPayments.some((suggestion) => suggestion.bankTransactionId === 'missing-book'));
});

test('reconciliation is tenant isolated and confirmation needs its own permission', () => {
  const service = new BankReconciliationService();
  assert.throws(() => service.reconcile(context('other'), [bank('one', 1n)], []), /another company/);
  const result = service.reconcile(context(), [bank('one', 100n, { reference: null })], [payment('one', 100n, { reference: null }), payment('two', 100n, { reference: null })]);
  assert.throws(() => service.confirm({ ...context(), permissions: new Set(['bank.reconcile']) }, result.candidates[0]!.id), /permission/);
});
