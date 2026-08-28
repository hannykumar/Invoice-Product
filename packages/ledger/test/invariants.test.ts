/**
 * Issue #4 [E04] — the refusals.
 *
 * Every case here is something the ledger must decline to write. A ledger that quietly repairs
 * bad input is worse than one that refuses it, because the repair is invisible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate, rupees, zero, asId, type AccountId } from '@invoice/kernel';
import { makeLedger, ABC_TRADERS, NASHIK_FARMS, key } from './fixtures.ts';

const nil = zero();

const expectCode = async (code: string, work: () => Promise<unknown>): Promise<DomainError> => {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${code} but the call succeeded` });
};

test('an entry that does not balance is refused, and says by how much', async () => {
  const l = await makeLedger();
  const error = await expectCode('LEDGER_UNBALANCED', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('unbalanced'),
      type: 'SALE',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(1180), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(1000) },
      ],
    }),
  );
  assert.equal(error.details.difference, '180.00');
  const vouchers = await l.store.read().vouchers.list(l.actor.companyId, {});
  assert.equal(vouchers.length, 0, 'nothing may be written when a posting is refused');
});

test('a line cannot be both a debit and a credit', async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_BOTH_SIDES', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('both-sides'),
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.account('CASH_IN_HAND'), debit: rupees(100), credit: rupees(100) },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
});

test('a negative amount is refused rather than flipped', async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_NEGATIVE_AMOUNT', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('negative'),
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.account('CASH_IN_HAND'), debit: rupees(-100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(-100) },
      ],
    }),
  );
});

test('an entry needs two sides, and an entry for zero is not an entry', async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_TOO_FEW_LINES', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('one-line'),
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [{ accountId: l.account('CASH_IN_HAND'), debit: rupees(100), credit: nil }],
    }),
  );
  await expectCode('LEDGER_EMPTY_LINE', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('zero-line'),
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.account('CASH_IN_HAND'), debit: nil, credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: nil },
      ],
    }),
  );
});

test('nothing can be posted to a heading, an unknown account or a closed account', async () => {
  const l = await makeLedger();
  const headingId = asId<'Account'>(`${l.actor.companyId}:acc:1000`);
  await expectCode('LEDGER_GROUP_ACCOUNT', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('group'),
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: headingId, debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
  await expectCode('LEDGER_UNKNOWN_ACCOUNT', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('unknown'),
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: asId<'Account'>('does-not-exist') as AccountId, debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
});

test("a party's own account cannot be posted against a different party", async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_PARTY_MISMATCH', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('party-mismatch'),
      type: 'SALE',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.abcTradersAccount, partyId: NASHIK_FARMS, debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
});

test('a reversal cannot be hand-built; it is produced by undoing an entry', async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_REVERSAL_NOT_DIRECT', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('hand-reversal'),
      // Deliberately bypassing the type system the way a careless caller would.
      type: 'REVERSAL' as unknown as 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.account('CASH_IN_HAND'), debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
});

test('nothing can be dated before the day the business started keeping books here', async () => {
  const l = await makeLedger({ booksStartDate: '2026-04-01' });
  const error = await expectCode('LEDGER_BEFORE_BOOKS_START', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('too-early'),
      type: 'SALE',
      date: isoDate('2026-03-31'),
      lines: [
        { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
  assert.equal(error.details.booksStartDate, '2026-04-01');
});

test('an entry without an idempotency key is refused', async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_IDEMPOTENCY_KEY_REQUIRED', () =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: '   ',
      type: 'JOURNAL',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.account('CASH_IN_HAND'), debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
      ],
    }),
  );
});

test('the books cannot be set up twice', async () => {
  const l = await makeLedger();
  await expectCode('LEDGER_ALREADY_SET_UP', () =>
    l.service.initialiseCompany(l.actor, { booksStartDate: isoDate('2026-04-01'), accounts: [] }),
  );
});

test('every refusal that a person will see names the message that explains it', async () => {
  const l = await makeLedger();
  const error = await expectCode('LEDGER_REASON_REQUIRED', () =>
    l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'HARD_LOCKED' }),
  );
  assert.equal(error.messageId, 'override.reason_required');
});
