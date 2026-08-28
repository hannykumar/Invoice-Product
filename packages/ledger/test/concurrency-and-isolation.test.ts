/**
 * Issue #4 [E04] — concurrent posting, duplicate posting, permissions and tenant isolation.
 *
 * These are the tests that decide whether the ledger is safe under a bad network and many hands,
 * which is the condition it will actually run in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate, rupees, toDecimalString, zero } from '@invoice/kernel';
import { partyBalance, trialBalance } from '../src/balances.ts';
import {
  ABC_TRADERS,
  ALL_PERMISSIONS,
  OTHER_COMPANY,
  actorWith,
  makeLedger,
  key,
} from './fixtures.ts';

const nil = zero();

const saleCommand = (l: Awaited<ReturnType<typeof makeLedger>>, k: string, amount = rupees(1000)) => ({
  idempotencyKey: k,
  type: 'SALE' as const,
  date: isoDate('2026-04-10'),
  lines: [
    { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: amount, credit: nil },
    { accountId: l.account('SALES_GOODS'), debit: nil, credit: amount },
  ],
});

test('the same idempotency key sent twice produces one entry, and the second call says so', async () => {
  const l = await makeLedger();
  const first = await l.service.postVoucher(l.actor, saleCommand(l, key('retry')));
  const second = await l.service.postVoucher(l.actor, saleCommand(l, key('retry')));

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.voucher.id, first.voucher.id);

  const all = await l.store.read().vouchers.list(l.actor.companyId, {});
  assert.equal(all.length, 1, 'a retry must never create a second entry');

  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '1000.00', 'the balance must not double');

  const audited = l.audit.events.filter((e) => e.action === 'ledger.voucher_posted');
  assert.equal(audited.length, 1, 'a deduplicated call is not audited as a new posting');
});

test('twenty simultaneous retries of one key still produce exactly one entry', async () => {
  const l = await makeLedger();
  const attempts = Array.from({ length: 20 }, () => l.service.postVoucher(l.actor, saleCommand(l, key('storm'))));
  const results = await Promise.all(attempts);

  const created = results.filter((r) => !r.deduplicated);
  assert.equal(created.length, 1, 'exactly one call may create the entry');
  const ids = new Set(results.map((r) => r.voucher.id));
  assert.equal(ids.size, 1, 'every caller must be handed the same entry');

  const all = await l.store.read().vouchers.list(l.actor.companyId, {});
  assert.equal(all.length, 1);
});

test('fifty concurrent postings get fifty different numbers, with no gaps and no repeats', async () => {
  const l = await makeLedger();
  const count = 50;
  const results = await Promise.all(
    Array.from({ length: count }, (_unused, i) => l.service.postVoucher(l.actor, saleCommand(l, key(`c-${i}`)))),
  );

  const numbers = results.map((r) => r.voucher.number);
  assert.equal(new Set(numbers).size, count, 'two entries must never share a number');

  const sequence = numbers.map((n) => Number(n.split('/')[2])).sort((a, b) => a - b);
  assert.deepEqual(sequence, Array.from({ length: count }, (_unused, i) => i + 1), 'the sequence has no gaps');

  const tb = await trialBalance(l.store.read(), l.actor.companyId);
  assert.ok(tb.balanced, 'the books balance after fifty concurrent postings');
  assert.equal(toDecimalString(tb.totalDebit), `${count * 1000}.00`);
});

test('a failed posting leaves nothing behind, including its sequence number', async () => {
  const l = await makeLedger();
  await assert.rejects(() =>
    l.service.postVoucher(l.actor, {
      idempotencyKey: key('doomed'),
      type: 'SALE',
      date: isoDate('2026-04-10'),
      lines: [
        { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(100), credit: nil },
        { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(90) },
      ],
    }),
  );

  const good = await l.service.postVoucher(l.actor, saleCommand(l, key('after-failure')));
  assert.equal(good.voucher.number, 'SALE/2026-27/000001', 'a rolled-back attempt must not burn a number');

  const reused = await l.service.postVoucher(l.actor, {
    ...saleCommand(l, key('doomed')),
  });
  assert.equal(reused.deduplicated, false, 'a key from a failed attempt is free to use again');
});

test('a user without the right permission cannot post that kind of entry', async () => {
  const l = await makeLedger();
  const receiptsOnly = actorWith(['ledger.post.receipt']);
  await assert.rejects(
    () => l.service.postVoucher(receiptsOnly, saleCommand(l, key('no-permission'))),
    (e: unknown) =>
      e instanceof DomainError && e.kind === 'FORBIDDEN' && e.messageId === 'permission.not_allowed',
  );
  const all = await l.store.read().vouchers.list(l.actor.companyId, {});
  assert.equal(all.length, 0);
});

test('permission is checked for each voucher type separately', async () => {
  const l = await makeLedger();
  const salesClerk = actorWith(['ledger.post.sale']);
  await l.service.postVoucher(salesClerk, saleCommand(l, key('sale-ok')));
  await assert.rejects(
    () =>
      l.service.postVoucher(salesClerk, {
        idempotencyKey: key('journal-no'),
        type: 'JOURNAL',
        date: isoDate('2026-04-10'),
        lines: [
          { accountId: l.account('CASH_IN_HAND'), debit: rupees(100), credit: nil },
          { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
        ],
      }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});

test("one business's entries are invisible and unreachable from another", async () => {
  const a = await makeLedger();
  const b = await makeLedger({ companyId: OTHER_COMPANY });

  const posted = await a.service.postVoucher(a.actor, saleCommand(a, key('isolation')));

  // The same service, asked as the other company, must not find it.
  const asOther = actorWith(ALL_PERMISSIONS, OTHER_COMPANY);
  assert.equal(await a.service.getVoucher(asOther, posted.voucher.id), null);

  const otherVouchers = await b.store.read().vouchers.list(OTHER_COMPANY, {});
  assert.equal(otherVouchers.length, 0);

  const otherTrial = await trialBalance(b.store.read(), OTHER_COMPANY);
  assert.equal(otherTrial.rows.length, 0);
});

test('an account belonging to another business cannot be posted to', async () => {
  const a = await makeLedger();
  const b = await makeLedger({ companyId: OTHER_COMPANY });
  await assert.rejects(
    () =>
      a.service.postVoucher(a.actor, {
        idempotencyKey: key('cross-company'),
        type: 'JOURNAL',
        date: isoDate('2026-04-10'),
        lines: [
          { accountId: b.account('CASH_IN_HAND'), debit: rupees(100), credit: nil },
          { accountId: a.account('SALES_GOODS'), debit: nil, credit: rupees(100) },
        ],
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_UNKNOWN_ACCOUNT',
  );
});

test('undoing an entry cannot be triggered from another business', async () => {
  const a = await makeLedger();
  const posted = await a.service.postVoucher(a.actor, saleCommand(a, key('cross-reverse')));
  const asOther = actorWith(ALL_PERMISSIONS, OTHER_COMPANY);
  await assert.rejects(
    () =>
      a.service.reverseVoucher(asOther, {
        idempotencyKey: key('cross-reverse-undo'),
        voucherId: posted.voucher.id,
        date: isoDate('2026-05-12'),
        reason: 'not mine',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'LEDGER_VOUCHER_NOT_FOUND',
  );
});

test('every posting is written to the audit trail with actor, time and source, and no secrets', async () => {
  const l = await makeLedger();
  const posted = await l.service.postVoucher(l.actor, {
    ...saleCommand(l, key('audited')),
    source: { kind: 'sales_invoice', id: 'si-9', number: 'INV/KB/2026-27/00009' },
  });
  const event = l.audit.forSubject(posted.voucher.id)[0];
  assert.ok(event !== undefined);
  assert.equal(event.action, 'ledger.voucher_posted');
  assert.equal(event.actorId, l.actor.userId);
  assert.equal(event.companyId, l.actor.companyId);
  assert.equal(event.details.sourceNumber, 'INV/KB/2026-27/00009');
  assert.ok(event.at.endsWith('Z'), 'audit timestamps are instants in UTC');
  const serialised = JSON.stringify(l.audit.events);
  for (const forbiddenWord of ['password', 'token', 'secret', 'apiKey']) {
    assert.ok(!serialised.includes(forbiddenWord), `the audit trail must not carry ${forbiddenWord}`);
  }
});
