/**
 * Issue #4 [E04] — period locks, reversals and amendments.
 *
 * "Final records are corrected by reversal/amendment rather than destructive edits" is an
 * acceptance criterion. These tests prove there is no other path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate, rupees, toDecimalString, zero } from '@invoice/kernel';
import { partyBalance, trialBalance } from '../src/balances.ts';
import { ABC_TRADERS, ALL_PERMISSIONS, actorWith, makeLedger, key } from './fixtures.ts';

const nil = zero();

const sale = (l: Awaited<ReturnType<typeof makeLedger>>, k: string, date: string, amount = rupees(1180)) =>
  l.service.postVoucher(l.actor, {
    idempotencyKey: key(k),
    type: 'SALE',
    date: isoDate(date),
    source: { kind: 'sales_invoice', id: k, number: `INV/${k}` },
    lines: [
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: amount, credit: nil },
      { accountId: l.account('SALES_GOODS'), debit: nil, credit: amount },
    ],
  });

test('a soft-locked month refuses a posting, and accepts one with permission and a reason', async () => {
  const l = await makeLedger();
  await l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'SOFT_LOCKED', reason: 'April reviewed' });

  await assert.rejects(
    () => sale(l, 'soft-1', '2026-04-20'),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_PERIOD_SOFT_LOCKED' && e.messageId === 'period.closed',
  );

  const allowed = await l.service.postVoucher(l.actor, {
    idempotencyKey: key('soft-2'),
    type: 'SALE',
    date: isoDate('2026-04-20'),
    periodOverride: { reason: 'Owner approved on call, bill was raised by hand on 20 April' },
    lines: [
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(1180), credit: nil },
      { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(1180) },
    ],
  });
  assert.equal(allowed.voucher.state, 'FINAL');

  const audited = l.audit.forSubject(allowed.voucher.id);
  assert.equal(audited.length, 1);
  assert.match(audited[0]?.overrideReason ?? '', /Owner approved on call/);
});

test('a soft-locked month still refuses a user who does not hold the override permission', async () => {
  const l = await makeLedger();
  await l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'SOFT_LOCKED', reason: 'April reviewed' });
  const clerk = actorWith(ALL_PERMISSIONS.filter((p) => p !== 'ledger.post.locked_period'));
  await assert.rejects(
    () =>
      l.service.postVoucher(clerk, {
        idempotencyKey: key('soft-3'),
        type: 'SALE',
        date: isoDate('2026-04-20'),
        periodOverride: { reason: 'I really need to' },
        lines: [
          { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(100), credit: nil },
          { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
        ],
      }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});

test('a hard-locked month refuses everyone, override or not, and cannot be reopened', async () => {
  const l = await makeLedger();
  await l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'SOFT_LOCKED', reason: 'reviewed' });
  await l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'HARD_LOCKED', reason: 'GSTR-3B filed for April' });

  await assert.rejects(
    () =>
      l.service.postVoucher(l.actor, {
        idempotencyKey: key('hard-1'),
        type: 'SALE',
        date: isoDate('2026-04-20'),
        periodOverride: { reason: 'please' },
        lines: [
          { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(100), credit: nil },
          { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
        ],
      }),
    (e: unknown) =>
      e instanceof DomainError && e.code === 'LEDGER_PERIOD_HARD_LOCKED' && e.messageId === 'period.closed_permanently',
  );

  await assert.rejects(
    () => l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'OPEN', reason: 'changed my mind' }),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_PERIOD_HARD_LOCKED',
  );

  // A different month is unaffected.
  const may = await sale(l, 'hard-2', '2026-05-02');
  assert.equal(may.voucher.state, 'FINAL');
});

test('a reversal mirrors every line, keeps both entries visible and leaves the books balanced', async () => {
  const l = await makeLedger();
  const original = await sale(l, 'rev-1', '2026-04-10', rupees(5000));

  const reversal = await l.service.reverseVoucher(l.actor, {
    idempotencyKey: key('rev-1-undo'),
    voucherId: original.voucher.id,
    date: isoDate('2026-05-12'),
    reason: 'Wrong customer on the bill',
  });

  assert.equal(reversal.voucher.type, 'REVERSAL');
  assert.equal(reversal.voucher.reversesVoucherId, original.voucher.id);
  assert.equal(reversal.voucher.reason, 'Wrong customer on the bill');
  assert.equal(reversal.voucher.lines.length, original.voucher.lines.length);

  for (const line of original.voucher.lines) {
    const mirror = reversal.voucher.lines.find((m) => m.accountId === line.accountId);
    assert.ok(mirror !== undefined);
    assert.equal(toDecimalString(mirror.debit), toDecimalString(line.credit));
    assert.equal(toDecimalString(mirror.credit), toDecimalString(line.debit));
  }

  const stored = await l.service.getVoucher(l.actor, original.voucher.id);
  assert.equal(stored?.state, 'REVERSED', 'the original stays visible, marked as undone');
  assert.equal(stored?.reversedByVoucherId, reversal.voucher.id);

  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '0.00', 'the reversal cancels the original exactly');

  const tb = await trialBalance(l.store.read(), l.actor.companyId);
  assert.ok(tb.balanced);
});

test('an entry can only be undone once, and only when it is final', async () => {
  const l = await makeLedger();
  const original = await sale(l, 'rev-2', '2026-04-10');
  await l.service.reverseVoucher(l.actor, {
    idempotencyKey: key('rev-2-undo'),
    voucherId: original.voucher.id,
    date: isoDate('2026-05-12'),
    reason: 'duplicate bill',
  });
  await assert.rejects(
    () =>
      l.service.reverseVoucher(l.actor, {
        idempotencyKey: key('rev-2-undo-again'),
        voucherId: original.voucher.id,
        date: isoDate('2026-05-12'),
        reason: 'again',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_ALREADY_REVERSED',
  );
});

test('undoing an entry needs a written reason and the permission to do it', async () => {
  const l = await makeLedger();
  const original = await sale(l, 'rev-3', '2026-04-10');
  await assert.rejects(
    () =>
      l.service.reverseVoucher(l.actor, {
        idempotencyKey: key('rev-3-a'),
        voucherId: original.voucher.id,
        date: isoDate('2026-05-12'),
        reason: '  ',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_REASON_REQUIRED',
  );
  const clerk = actorWith(ALL_PERMISSIONS.filter((p) => p !== 'ledger.reverse'));
  await assert.rejects(
    () =>
      l.service.reverseVoucher(clerk, {
        idempotencyKey: key('rev-3-b'),
        voucherId: original.voucher.id,
        date: isoDate('2026-05-12'),
        reason: 'wrong amount',
      }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});

test('an amendment undoes the original and posts the corrected entry, linked to it', async () => {
  const l = await makeLedger();
  const original = await sale(l, 'amd-1', '2026-04-10', rupees(5000));

  const amended = await l.service.amendVoucher(l.actor, {
    idempotencyKey: key('amd-1-fix'),
    voucherId: original.voucher.id,
    reason: 'Rate was wrong on the bill',
    date: isoDate('2026-05-12'),
    replacement: {
      date: isoDate('2026-05-12'),
      lines: [
        { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(5500), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(5500) },
      ],
    },
  });

  assert.equal(amended.reversal.type, 'REVERSAL');
  assert.equal(amended.replacement.type, 'SALE');
  assert.match(amended.replacement.narration ?? '', /Corrects /);

  const stored = await l.service.getVoucher(l.actor, original.voucher.id);
  assert.equal(stored?.state, 'REVERSED');

  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '5500.00', 'only the corrected figure remains');
  assert.ok((await trialBalance(l.store.read(), l.actor.companyId)).balanced);
});

test('reversing into a closed month is refused like any other posting', async () => {
  const l = await makeLedger();
  const original = await sale(l, 'rev-4', '2026-04-10');
  await l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'SOFT_LOCKED', reason: 'reviewed' });
  await l.service.setPeriodState(l.actor, { monthKey: '2026-04', state: 'HARD_LOCKED', reason: 'filed' });
  await assert.rejects(
    () =>
      l.service.reverseVoucher(l.actor, {
        idempotencyKey: key('rev-4-undo'),
        voucherId: original.voucher.id,
        date: isoDate('2026-04-30'),
        reason: 'wrong',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_PERIOD_HARD_LOCKED',
  );
  // The correction is made in the open month instead, exactly as the message tells the user.
  const later = await l.service.reverseVoucher(l.actor, {
    idempotencyKey: key('rev-4-undo-may'),
    voucherId: original.voucher.id,
    date: isoDate('2026-05-12'),
    reason: 'wrong',
  });
  assert.equal(later.voucher.date, '2026-05-12');
});
