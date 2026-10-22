/**
 * Issue #366 — what every ledger store must do, run on the in-memory store and on PostgreSQL as the
 * application role (`ledger-store-contract.test.ts`, `ledger-store-contract.integration.test.ts`).
 *
 * The ledger is the books (rule 1), so the suite checks the store through the real LedgerService:
 * an entry reads back exactly as it was posted, a retry never makes a second one, a failed action
 * leaves nothing behind, one company can neither read nor post into another's books, a person with
 * no branch (`'main'`) is "no branch" in the books on every store, and the optional keyset pages
 * return every row once, in order.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { asId, fixedClock, isoDate, rupees, zero, type AccountId, type CompanyId, type UserId } from '@invoice/kernel';
import { buildDefaultChart } from '../src/domain/chart-of-accounts.ts';
import { InMemoryAuditPort, permissionPortFromActor } from '../src/adapters/memory.ts';
import { LedgerService } from '../src/service.ts';
import type { ActorContext, LedgerStore } from '../src/ports.ts';
import type { Voucher } from '../src/domain/voucher.ts';
import { ALL_PERMISSIONS } from './fixtures.ts';

export interface LedgerHarness {
  readonly store: LedgerStore;
  /** A new company (and its user) the store may hold rows for. */
  company(): Promise<{ companyId: CompanyId; userId: UserId }>;
}

export interface Books {
  readonly service: LedgerService;
  readonly actor: ActorContext;
  readonly cash: AccountId;
  readonly sales: AccountId;
}

let keys = 0;
const key = (label: string): string => `${label}-${(keys += 1)}-${crypto.randomUUID()}`;
const nil = zero();

/** A company with the default chart, its books starting 1 April 2026. */
export const openBooks = async (h: LedgerHarness, branchId: string | null = null): Promise<Books> => {
  const { companyId, userId } = await h.company();
  const actor: ActorContext = { companyId, branchId: branchId as ActorContext['branchId'], userId, permissions: ALL_PERMISSIONS };
  const service = new LedgerService({
    store: h.store, permissions: permissionPortFromActor, audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-05-12T11:04:00.000Z'), idFactory: () => crypto.randomUUID(),
  });
  const ids = new Map<string, AccountId>();
  const chart = buildDefaultChart(companyId, (code) => {
    if (!ids.has(code)) ids.set(code, asId<'Account'>(crypto.randomUUID()));
    return ids.get(code) as AccountId;
  });
  await service.initialiseCompany(actor, { booksStartDate: isoDate('2026-04-01'), accounts: chart });
  const role = (name: string): AccountId => chart.find((a) => a.systemRole === name)?.id as AccountId;
  return { service, actor, cash: role('CASH_IN_HAND'), sales: role('SALES_GOODS') };
};

/** A cash sale of `amount` rupees on `date`. */
export const cashSale = (b: Books, date: string, amount: number, idempotencyKey = key('sale')) =>
  b.service.postVoucher(b.actor, {
    idempotencyKey, type: 'SALE', date: isoDate(date), narration: 'Counter sale',
    source: { kind: 'sales_invoice', id: crypto.randomUUID(), number: `INV/${amount}` },
    lines: [
      { accountId: b.cash, debit: rupees(amount), credit: nil },
      { accountId: b.sales, debit: nil, credit: rupees(amount), narration: 'Goods' },
    ],
  });

export const ledgerStoreContract = (name: string, harness: () => LedgerHarness, skip: string | false = false): void => {
  test(`${name}: a posted entry reads back exactly, by id and in the list, inside and outside a transaction`, { skip }, async () => {
    const h = harness();
    const b = await openBooks(h);
    const { voucher } = await cashSale(b, '2026-04-10', 1180);
    assert.deepEqual(await h.store.read().vouchers.findById(b.actor.companyId, voucher.id), voucher);
    assert.deepEqual(await h.store.transaction(b.actor.companyId, (uow) => uow.vouchers.findById(b.actor.companyId, voucher.id)), voucher);
    assert.deepEqual(await h.store.read().vouchers.list(b.actor.companyId, {}), [voucher]);
    assert.deepEqual(await h.store.read().vouchers.list(b.actor.companyId, { accountId: b.cash, types: ['SALE'], from: isoDate('2026-04-10'), to: isoDate('2026-04-10') }), [voucher]);
    assert.deepEqual(await h.store.read().vouchers.list(b.actor.companyId, { types: ['PURCHASE'] }), []);
    assert.equal((await h.store.read().settings.get(b.actor.companyId))?.booksStartDate, '2026-04-01');
    assert.equal((await h.store.read().periods.find(b.actor.companyId, '2026-04'))?.state, 'OPEN');
    assert.deepEqual((await h.store.read().periods.list(b.actor.companyId, '2026-27')).map((p) => p.monthKey), ['2026-04']);
    assert.equal(await h.store.read().idempotency.lookup(b.actor.companyId, 'never-used'), null);
    assert.equal((await h.store.read().accounts.findById(b.actor.companyId, b.cash))?.systemRole, 'CASH_IN_HAND');
  });

  test(`${name}: a retry returns the first entry, a reversal marks the original, and a failed action leaves nothing`, { skip }, async () => {
    const h = harness();
    const b = await openBooks(h);
    const sameKey = key('retry');
    const first = await cashSale(b, '2026-04-11', 500, sameKey);
    const again = await cashSale(b, '2026-04-11', 500, sameKey);
    assert.equal(again.deduplicated, true);
    assert.equal(again.voucher.id, first.voucher.id);
    const undo = await b.service.reverseVoucher(b.actor, { idempotencyKey: key('undo'), voucherId: first.voucher.id, date: isoDate('2026-04-12'), reason: 'Entered twice' });
    const original = await h.store.read().vouchers.findById(b.actor.companyId, first.voucher.id);
    assert.equal(original?.state, 'REVERSED');
    assert.equal(original?.reversedByVoucherId, undo.voucher.id);
    assert.equal((await h.store.read().vouchers.findById(b.actor.companyId, undo.voucher.id))?.reversesVoucherId, first.voucher.id);

    const before = await h.store.read().vouchers.list(b.actor.companyId, {});
    await assert.rejects(h.store.transaction(b.actor.companyId, async (uow) => {
      await b.service.postVoucherIn(uow, b.actor, {
        idempotencyKey: key('rolled-back'), type: 'SALE', date: isoDate('2026-04-13'),
        lines: [{ accountId: b.cash, debit: rupees(1), credit: nil }, { accountId: b.sales, debit: nil, credit: rupees(1) }],
      });
      throw new Error('the bill could not be saved');
    }), /could not be saved/);
    assert.deepEqual(await h.store.read().vouchers.list(b.actor.companyId, {}), before, 'the entry went with the failed action');
  });

  test(`${name}: another company can neither read nor post into these books`, { skip }, async () => {
    const h = harness();
    const mine = await openBooks(h);
    const theirs = await openBooks(h);
    const { voucher } = await cashSale(mine, '2026-04-10', 700);
    const other = theirs.actor.companyId;
    assert.equal(await h.store.read().vouchers.findById(other, voucher.id), null);
    assert.deepEqual(await h.store.read().vouchers.list(other, {}), []);
    assert.equal(await h.store.read().accounts.findById(other, mine.cash), null);
    assert.deepEqual(await h.store.read().accounts.findManyByIds(other, [mine.cash, mine.sales]), []);
    assert.equal(await h.store.read().idempotency.lookup(other, voucher.idempotencyKey), null);
    // Posting into this company's accounts from the other company finds no such account.
    await assert.rejects(
      theirs.service.postVoucher(theirs.actor, {
        idempotencyKey: key('stolen'), type: 'SALE', date: isoDate('2026-04-10'),
        lines: [{ accountId: mine.cash, debit: rupees(1), credit: nil }, { accountId: mine.sales, debit: nil, credit: rupees(1) }],
      }),
      (error: unknown) => (error as { code?: string }).code === 'LEDGER_UNKNOWN_ACCOUNT',
    );
    // Nor can it reverse this company's entry.
    await assert.rejects(theirs.service.reverseVoucher(theirs.actor, { idempotencyKey: key('undo'), voucherId: voucher.id, date: isoDate('2026-04-11'), reason: 'not mine' }),
      (error: unknown) => (error as { code?: string }).code === 'LEDGER_VOUCHER_NOT_FOUND');
    assert.equal((await h.store.read().vouchers.findById(mine.actor.companyId, voucher.id))?.state, 'FINAL');
  });

  test(`${name}: a person with no branch of their own ('main') posts entries that belong to no branch`, { skip }, async () => {
    const h = harness();
    const b = await openBooks(h, 'main');
    const { voucher } = await cashSale(b, '2026-04-10', 900);
    assert.equal(voucher.branchId, null);
    const read = await h.store.read().vouchers.findById(b.actor.companyId, voucher.id);
    assert.equal(read?.branchId, null);
    assert.deepEqual(read, voucher);
    const undo = await b.service.reverseVoucher(b.actor, { idempotencyKey: key('undo'), voucherId: voucher.id, date: isoDate('2026-04-11'), reason: 'Wrong amount' });
    assert.equal((await h.store.read().vouchers.findById(b.actor.companyId, undo.voucher.id))?.branchId, null);
  });

  test(`${name}: keyset pages return every entry and account once, in order, and the whole list is unchanged without one`, { skip }, async () => {
    const h = harness();
    const b = await openBooks(h);
    const posted: Voucher[] = [];
    for (const [date, amount] of [['2026-04-20', 1], ['2026-04-05', 2], ['2026-04-20', 3], ['2026-05-01', 4], ['2026-04-05', 5]] as const) {
      posted.push((await cashSale(b, date, amount)).voucher);
    }
    const ordered = [...posted].sort((x, y) => (`${x.date} ${x.number}` < `${y.date} ${y.number}` ? -1 : 1));
    const paged: Voucher[] = [];
    let after: { date: Voucher['date']; number: string } | undefined;
    for (;;) {
      const page = await h.store.read().vouchers.list(b.actor.companyId, { page: after === undefined ? { limit: 2 } : { limit: 2, after } });
      assert.ok(page.length <= 2);
      if (page.length === 0) break;
      paged.push(...page);
      const last = page[page.length - 1] as Voucher;
      after = { date: last.date, number: last.number };
    }
    assert.deepEqual(paged, ordered);
    const filtered = await h.store.read().vouchers.list(b.actor.companyId, { from: isoDate('2026-04-06'), page: { limit: 10, after: { date: isoDate('2026-04-20'), number: ordered[2]!.number } } });
    assert.deepEqual(filtered.map((v) => v.id), [ordered[3]!.id, ordered[4]!.id]);
    assert.deepEqual(new Set((await h.store.read().vouchers.list(b.actor.companyId, {})).map((v) => v.id)), new Set(posted.map((v) => v.id)));

    const all = await h.store.read().accounts.listAll(b.actor.companyId);
    const pages = [];
    let afterCode: string | undefined;
    for (;;) {
      const page = await h.store.read().accounts.listAll(b.actor.companyId, afterCode === undefined ? { limit: 7 } : { limit: 7, afterCode });
      if (page.length === 0) break;
      pages.push(...page);
      afterCode = page[page.length - 1]!.code;
    }
    assert.deepEqual(pages.map((a) => a.code), all.map((a) => a.code).sort((x, y) => (x < y ? -1 : 1)));
    assert.deepEqual(new Set(pages.map((a) => a.id)), new Set(all.map((a) => a.id)));
    for (const limit of [0, -1, 1.5, 1001]) {
      await assert.rejects(h.store.read().vouchers.list(b.actor.companyId, { page: { limit } }), (error: unknown) => (error as { code?: string }).code === 'LEDGER_PAGE_SIZE');
      await assert.rejects(h.store.read().accounts.listAll(b.actor.companyId, { limit }), (error: unknown) => (error as { code?: string }).code === 'LEDGER_PAGE_SIZE');
    }
  });
};
