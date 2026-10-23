/**
 * Issue #294 — rent, wages and other costs, journal and contra entries, and the owner's own money,
 * through the real API. Before this there was no way to record any of them, so rent paid from the
 * drawer showed as profit and the cash book never matched the drawer.
 *
 * Every name and number here is synthetic: people from `packages/platform/src/seed.ts`, GST
 * numbers from `syntheticGstin()`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { KONKAN_OWNER, SAMPOORNA_OWNER, SAMPOORNA_VIEWER, signIn } from './sign-in-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const DATE = '2026-09-27';
// Sampoorna is registered in Karnataka (29).
const IN_STATE = syntheticGstin('29', 'AQWPR4521K');
const OTHER_STATE = syntheticGstin('27', 'AQWPR4521K');

type Reply = { status: number; body: Record<string, any> };
const request = async (method: string, path: string, body: Record<string, unknown>, token: string): Promise<Reply> => {
  const response = await handleApi(method, path, body, `Bearer ${token}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};
const codeOf = (reply: Reply): string => String(reply.body.code ?? reply.body.error?.code ?? '');

let counter = 0;
const nextRequest = (): string => `test-294-${++counter}`;

/** Checks an entry, then saves exactly what was checked. */
const save = async (kind: string, body: Record<string, unknown>, token: string, requestId = nextRequest()): Promise<Reply> => {
  const checked = await request('POST', `/api/books/${kind}/preview`, body, token);
  if (checked.status !== 200) return checked;
  return request('POST', `/api/books/${kind}/record`, { ...body, check: checked.body.check, requestId }, token);
};

const sessions = (() => {
  let done: Promise<{ owner: string; accountant: string; counter: string; viewer: string; konkan: string }> | null = null;
  return () => done ??= (async () => {
    const owner = await signIn(SAMPOORNA_OWNER, SAMPOORNA);
    // The owner puts ₹1,00,000 into the drawer first, so cash can go out of it.
    const capital = await save('owner', { direction: 'capital', paidFrom: 'cash', amount: '100000', date: '2026-09-01' }, owner);
    assert.equal(capital.status, 200, JSON.stringify(capital.body));
    return {
      owner,
      accountant: await signIn('accounts@sampoorna.example.invalid', SAMPOORNA),
      counter: await signIn('counter@sampoorna.example.invalid', SAMPOORNA),
      viewer: await signIn(SAMPOORNA_VIEWER, SAMPOORNA),
      konkan: await signIn(KONKAN_OWNER),
    };
  })();
})();

const lines = (reply: Reply) => (reply.body.lines as { account: string; debit: number; credit: number }[]).map((l) => [l.account, l.debit, l.credit]);
const book = async (which: string, token: string) => (await request('GET', `/api/books/book?book=${which}`, {}, token)).body;
const expenseRow = async (name: string, token: string): Promise<number> =>
  ((await request('GET', '/api/reports', {}, token)).body.profitAndLoss.expenses.rows as { name: string; amount: number }[])
    .find((row) => row.name === name)?.amount ?? 0;

test('#294: rent paid in cash with a GST bill from this state is a cost under Rent, credit in CGST and SGST, and leaves the cash book', async () => {
  const { owner } = await sessions();
  const rentBefore = await expenseRow('Rent', owner);
  const cashBefore = (await book('cash', owner)).closing as number;
  const body = { head: 'rent', date: DATE, paidFrom: 'cash', amount: '10000', gst: '1800', gstin: IN_STATE, billNumber: 'R-09', credit: 'claim', narration: 'September shop rent' };
  const checked = await request('POST', '/api/books/expense/preview', body, owner);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(lines(checked), [['5610', 10000, 0], ['1410', 900, 0], ['1420', 900, 0], ['1110', 0, 11800]]);
  assert.equal((await expenseRow('Rent', owner)), rentBefore, 'checking an entry saves nothing');

  const saved = await request('POST', '/api/books/expense/record', { ...body, check: checked.body.check, requestId: nextRequest() }, owner);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.entry.kind, 'expense');
  assert.equal(saved.body.entry.total, 11800);
  assert.equal(await expenseRow('Rent', owner), rentBefore + 10000, 'Rent is its own line in what you spent');

  const cash = await book('cash', owner);
  assert.equal(cash.closing, cashBefore - 11800);
  const row = (cash.rows as { number: string; moneyOut: number; against: string }[]).find((r) => r.number === saved.body.entry.number);
  assert.ok(row, 'the payment is in the cash book');
  assert.equal(row.moneyOut, 11800);
  assert.match(row.against, /Rent/);
});

test('#294: a bill from another state is IGST credit; blocked credit under s.17(5) is part of the cost', async () => {
  const { owner } = await sessions();
  const igst = await request('POST', '/api/books/expense/preview', { head: 'transport', date: DATE, paidFrom: 'upi', amount: '1000', gst: '50', gstin: OTHER_STATE, credit: 'claim' }, owner);
  assert.equal(igst.status, 200, JSON.stringify(igst.body));
  assert.deepEqual(lines(igst), [['5640', 1000, 0], ['1430', 50, 0], ['1121', 0, 1050]]);

  const blocked = await save('expense', { head: 'repairs', date: DATE, paidFrom: 'bank', amount: '4000', gst: '720', gstin: IN_STATE, credit: 'blocked', blockedReason: 'vehicle_insurance_repair' }, owner);
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.deepEqual(lines(blocked), [['5650', 4720, 0], ['1121', 0, 4720]]);
  assert.ok((blocked.body.effects as string[]).some((effect) => effect.includes('17(5)(ab)')));
});

test('#294: GST the law does not allow, or a bill that cannot carry it, is refused with the reason', async () => {
  const { owner } = await sessions();
  const refused = async (body: Record<string, unknown>, code: string) => {
    const reply = await request('POST', '/api/books/expense/preview', { date: DATE, paidFrom: 'cash', amount: '500', ...body }, owner);
    assert.equal(reply.status, 422, JSON.stringify(reply.body));
    assert.equal(codeOf(reply), code, JSON.stringify(reply.body));
  };
  await refused({ head: 'wages', gst: '90', gstin: IN_STATE, credit: 'claim' }, 'BOOKS_EXPENSE_NO_GST');
  await refused({ head: 'electricity', gst: '90', gstin: IN_STATE, credit: 'claim' }, 'BOOKS_EXPENSE_NO_GST');
  await refused({ head: 'rent', gst: '90', credit: 'claim' }, 'BOOKS_EXPENSE_GSTIN_NEEDED');
  await refused({ head: 'rent', gst: '90', gstin: `${IN_STATE.slice(0, 14)}0` === IN_STATE ? `${IN_STATE.slice(0, 14)}1` : `${IN_STATE.slice(0, 14)}0`, credit: 'claim' }, 'BOOKS_EXPENSE_GSTIN');
  await refused({ head: 'rent', gst: '90', gstin: '29AAAAA0000A1ZY', credit: 'claim' }, 'BOOKS_EXPENSE_OWN_GSTIN');
  await refused({ head: 'rent', gst: '90', gstin: IN_STATE }, 'BOOKS_EXPENSE_CREDIT_CHOICE');
  await refused({ head: 'rent', gst: '90', gstin: IN_STATE, credit: 'blocked' }, 'BOOKS_EXPENSE_BLOCKED_REASON');
  await refused({ head: 'rent', gst: '90.01', gstin: IN_STATE, credit: 'claim' }, 'BOOKS_EXPENSE_GST_HALVES');
  await refused({ head: 'pizza' }, 'BOOKS_EXPENSE_HEAD');
  await refused({ head: 'rent', amount: '-5' }, 'BOOKS_AMOUNT');
  await refused({ head: 'rent', amount: '12.345' }, 'BOOKS_AMOUNT');
  await refused({ head: 'rent', amount: '0' }, 'BOOKS_AMOUNT');
  await refused({ head: 'rent', date: '2026-10-05' }, 'BOOKS_DATE_AHEAD');
  await refused({ head: 'rent', date: '2026-02-30' }, 'BOOKS_DATE');
  // Owed to a supplier is followed bill by bill, so it goes in as the supplier's bill.
  await refused({ head: 'repairs', paidFrom: 'supplier' }, 'BOOKS_EXPENSE_OWED');
  // Wages without GST are fine.
  const wages = await save('expense', { head: 'wages', date: DATE, paidFrom: 'cash', amount: '8000' }, owner);
  assert.equal(wages.status, 200, JSON.stringify(wages.body));
});

test('#294: only what was checked is saved; a changed entry or a missing check is refused', async () => {
  const { owner } = await sessions();
  const body = { head: 'bank_charges', date: DATE, paidFrom: 'bank', amount: '59' };
  const checked = await request('POST', '/api/books/expense/preview', body, owner);
  const changed = await request('POST', '/api/books/expense/record', { ...body, amount: '590', check: checked.body.check, requestId: nextRequest() }, owner);
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(codeOf(changed), 'BOOKS_CHANGED_SINCE_CHECK');
  const unchecked = await request('POST', '/api/books/expense/record', { ...body, requestId: nextRequest() }, owner);
  assert.equal(codeOf(unchecked), 'BOOKS_NOT_CHECKED');
  const noKey = await request('POST', '/api/books/expense/record', { ...body, check: checked.body.check }, owner);
  assert.equal(codeOf(noKey), 'BOOKS_REQUEST_ID');
});

test('#294: Save pressed twice, or five times at once, records one entry; a key reused for another entry is refused', async () => {
  const { owner } = await sessions();
  const before = (await request('GET', '/api/books/entries', {}, owner)).body.entries.length as number;
  const body = { head: 'other', date: DATE, paidFrom: 'cash', amount: '300', narration: 'Tea for the godown' };
  const checked = await request('POST', '/api/books/expense/preview', body, owner);
  const requestId = nextRequest();
  const replies = await Promise.all(Array.from({ length: 5 }, () =>
    request('POST', '/api/books/expense/record', { ...body, check: checked.body.check, requestId }, owner)));
  for (const reply of replies) assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(new Set(replies.map((reply) => reply.body.entry.id)).size, 1);
  assert.equal(replies.filter((reply) => reply.body.duplicate === false).length, 1);
  const again = await request('POST', '/api/books/expense/record', { ...body, check: checked.body.check, requestId }, owner);
  assert.equal(again.body.duplicate, true);
  assert.equal((await request('GET', '/api/books/entries', {}, owner)).body.entries.length, before + 1);

  const reused = await save('expense', { ...body, amount: '301' }, owner, requestId);
  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  assert.equal(codeOf(reused), 'BOOKS_REQUEST_REUSED');
});

test('#294: the drawer cannot pay out more cash than the books say is in it', async () => {
  const { owner } = await sessions();
  const reply = await request('POST', '/api/books/owner/preview', { direction: 'drawings', paidFrom: 'cash', amount: '99999999', date: DATE }, owner);
  assert.equal(reply.status, 422, JSON.stringify(reply.body));
  assert.equal(codeOf(reply), 'BOOKS_CASH_SHORT');
});

test('#294: drawings lower the owner\'s money, not the profit; capital in is not income', async () => {
  const { owner } = await sessions();
  const drawings = await save('owner', { direction: 'drawings', paidFrom: 'cash', amount: '2500', date: DATE }, owner);
  assert.equal(drawings.status, 200, JSON.stringify(drawings.body));
  assert.deepEqual(lines(drawings), [['3150', 2500, 0], ['1110', 0, 2500]]);
  const report = (await request('GET', '/api/reports', {}, owner)).body.profitAndLoss;
  assert.ok(!(report.expenses.rows as { name: string }[]).some((row) => /drawings/i.test(row.name)));
  assert.ok(!(report.income.rows as { name: string }[]).some((row) => /capital/i.test(row.name)));
});

test('#294: a contra moves cash into the bank and back; both books show it, profit does not', async () => {
  const { owner, accountant } = await sessions();
  const bankBefore = (await book('bank', owner)).closing as number;
  const cashBefore = (await book('cash', owner)).closing as number;
  const deposit = await save('contra', { direction: 'deposit', amount: '20000', date: DATE }, accountant);
  assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
  assert.deepEqual(lines(deposit), [['1121', 20000, 0], ['1110', 0, 20000]]);
  const withdraw = await save('contra', { direction: 'withdraw', amount: '5000', date: DATE }, accountant);
  assert.equal(withdraw.status, 200, JSON.stringify(withdraw.body));
  assert.equal((await book('bank', owner)).closing, bankBefore + 15000);
  assert.equal((await book('cash', owner)).closing, cashBefore - 15000);
  const bankRows = (await book('bank', owner)).rows as { number: string; moneyIn: number }[];
  assert.equal(bankRows.find((row) => row.number === deposit.body.entry.number)?.moneyIn, 20000);
});

test('#294: a journal must balance and must say why; cash, bank, stock and party accounts are refused', async () => {
  const { accountant } = await sessions();
  const journal = (lines: unknown[], narration = 'Repairs booked under other costs by mistake in September') =>
    request('POST', '/api/books/journal/preview', { date: DATE, narration, lines }, accountant);
  const unbalanced = await journal([{ account: '5650', debit: '100' }, { account: '5900', credit: '90' }]);
  assert.equal(codeOf(unbalanced), 'BOOKS_JOURNAL_UNBALANCED');
  assert.equal(codeOf(await journal([{ account: '5650', debit: '100' }, { account: '5900', credit: '100' }], '')), 'BOOKS_JOURNAL_NARRATION');
  assert.equal(codeOf(await journal([{ account: '5650', debit: '100' }])), 'BOOKS_JOURNAL_LINES');
  assert.equal(codeOf(await journal([{ account: '5650', debit: '100', credit: '100' }, { account: '5900', credit: '100' }])), 'BOOKS_JOURNAL_LINE_SIDE');
  assert.equal(codeOf(await journal([{ account: '9999', debit: '100' }, { account: '5900', credit: '100' }])), 'BOOKS_JOURNAL_ACCOUNT');
  for (const code of ['1110', '1121', '1300', '5000']) {
    assert.equal(codeOf(await journal([{ account: code, debit: '100' }, { account: '5900', credit: '100' }])), 'BOOKS_JOURNAL_ACCOUNT_NOT_ALLOWED', code);
  }
  const allowed = (await request('GET', '/api/books/journal/accounts', {}, accountant)).body.accounts as { code: string }[];
  assert.ok(allowed.some((a) => a.code === '5650') && !allowed.some((a) => a.code === '1110'));

  const saved = await save('journal', { date: DATE, narration: 'Repairs booked under other costs by mistake in September', lines: [{ account: '5650', debit: '100' }, { account: '5900', credit: '100' }] }, accountant);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(lines(saved), [['5650', 100, 0], ['5900', 0, 100]]);
});

test('#294: journal and contra entries are the accountant\'s and owner\'s; the counter and the viewer cannot make them', async () => {
  const { counter, viewer } = await sessions();
  for (const token of [counter, viewer]) {
    for (const path of ['/api/books/journal/preview', '/api/books/journal/record', '/api/books/contra/preview', '/api/books/contra/record', '/api/books/expense/record', '/api/books/owner/record', '/api/books/undo']) {
      const reply = await request('POST', path, { direction: 'deposit', amount: '10', date: DATE }, token);
      assert.equal(reply.status, 403, `${path}: ${JSON.stringify(reply.body)}`);
    }
  }
  assert.equal((await request('GET', '/api/books/book?book=cash', {}, viewer)).status, 403);
});

test('#294: a saved entry is never edited; it is undone in full with a reason, once, and only inside its own business', async () => {
  const { owner, konkan } = await sessions();
  const rentBefore = await expenseRow('Rent', owner);
  const saved = await save('expense', { head: 'rent', date: DATE, paidFrom: 'cash', amount: '700' }, owner);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(await expenseRow('Rent', owner), rentBefore + 700);

  const elsewhere = await request('POST', '/api/books/undo', { entryId: saved.body.entry.id, reason: 'Not ours', requestId: nextRequest() }, konkan);
  assert.equal(elsewhere.status, 404, JSON.stringify(elsewhere.body));
  assert.ok(!((await request('GET', '/api/books/entries', {}, konkan)).body.entries as { id: string }[]).some((e) => e.id === saved.body.entry.id));

  const noReason = await request('POST', '/api/books/undo', { entryId: saved.body.entry.id, requestId: nextRequest() }, owner);
  assert.equal(codeOf(noReason), 'BOOKS_UNDO_REASON');
  const requestId = nextRequest();
  const undone = await request('POST', '/api/books/undo', { entryId: saved.body.entry.id, reason: 'Typed the wrong month', requestId }, owner);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const twice = await request('POST', '/api/books/undo', { entryId: saved.body.entry.id, reason: 'Typed the wrong month', requestId }, owner);
  assert.equal(twice.body.duplicate, true);
  assert.equal(twice.body.reversal.id, undone.body.reversal.id);
  assert.equal(await expenseRow('Rent', owner), rentBefore);
  const entry = ((await request('GET', '/api/books/entries', {}, owner)).body.entries as { id: string; state: string }[]).find((e) => e.id === saved.body.entry.id);
  assert.equal(entry?.state, 'REVERSED');
  const again = await request('POST', '/api/books/undo', { entryId: saved.body.entry.id, reason: 'Again', requestId: nextRequest() }, owner);
  assert.notEqual(again.status, 200, 'an entry already undone cannot be undone again');

  const sale = await request('POST', '/api/books/undo', { entryId: 'not-a-books-entry', reason: 'x', requestId: nextRequest() }, owner);
  assert.equal(sale.status, 404);
});

test('#294: the heads list says which heads cannot carry GST, and the s.17(5) cases', async () => {
  const { owner } = await sessions();
  const reply = await request('GET', '/api/books/heads', {}, owner);
  assert.equal(reply.status, 200);
  const heads = reply.body.heads as { id: string; gstAllowed: boolean }[];
  assert.deepEqual(heads.map((h) => h.id), ['rent', 'wages', 'electricity', 'transport', 'repairs', 'bank_charges', 'telephone', 'other']);
  assert.deepEqual(heads.filter((h) => !h.gstAllowed).map((h) => h.id), ['wages', 'electricity']);
  assert.ok((reply.body.blockedReasons as { clause: string }[]).some((r) => r.clause === '17(5)(b)'));
});

test('#294: a phone bill paid by UPI is its own line in what you spent and leaves the bank book', async () => {
  const { owner } = await sessions();
  const before = await expenseRow('Telephone and internet', owner);
  const bankBefore = (await book('bank', owner)).closing as number;
  const saved = await save('expense', { head: 'telephone', date: DATE, paidFrom: 'upi', amount: '499', narration: 'Shop mobile recharge' }, owner);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(await expenseRow('Telephone and internet', owner), before + 499);
  assert.equal((await book('bank', owner)).closing, bankBefore - 499);
});
