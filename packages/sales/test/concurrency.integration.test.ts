/**
 * Issue #367 — the books stay right under pressure, on PostgreSQL, with real parallel connections.
 *
 * "Two servers" are two connection pools, or two operating-system processes, against one database.
 * The per-company lock of #363 serialises one company's writes. Beneath it, each guarantee also has
 * its own: stock on hand and the money have database rules (sales-schema-v1), bill numbers come
 * from one locked counter row, a hold locks the balance rows it reads, and a repeated request racing
 * its twin is answered with the saved bill. These tests show the whole system holding, through the
 * real services.
 *
 * The fourth "Done when" of #367 — two parallel allocations of one payment never exceed it — is
 * proven by `packages/receivables/test/receivables-contract.*` (the same payment twice, and two
 * payments for one bill), on these same tables.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { PilotIds } from './record-sale-pilot.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the concurrency database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let serverA: TransactionalExecutor;
let serverB: TransactionalExecutor;
let pilot: typeof import('./record-sale-pilot.ts');
let appUrl: string;
const login = `invoice_app_conc_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  pilot = await import('./record-sale-pilot.ts');
  owner = createDatabase(url);
  await migrate(owner);
  await owner.query(pilot.PILOT_TABLES);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const app = new URL(url);
  app.username = login;
  app.password = password;
  appUrl = app.toString();
  // Two servers, each with its own pool, both as the application's own role.
  serverA = createDatabase(appUrl);
  serverB = createDatabase(appUrl);
});
after(async () => {
  await serverA?.close();
  await serverB?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const newShop = async (crates: string) => {
  const ids: PilotIds = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
  const a = pilot.makePilot(serverA, ids);
  await a.setUp(crates);
  return { ids, a, b: pilot.makePilot(serverB, ids) };
};
const scalar = async (companyId: string, text: string) =>
  (await owner.tenantTransaction(companyId, (sql) => sql.query(text, [companyId]))).rows[0] as Record<string, unknown>;
const onHand = async (companyId: string) => Number((await scalar(companyId, 'SELECT COALESCE(sum(on_hand_micro), 0)::bigint AS n FROM stock_balances WHERE company_id = $1')).n);
const codeOf = (outcome: PromiseSettledResult<unknown>): string => ((outcome as PromiseRejectedResult).reason as { code?: string }).code ?? String((outcome as PromiseRejectedResult).reason);

test('50 sales of the last 5 crates at once, on two servers: exactly 5 are issued, stock ends at 0, the rest are told why', { skip }, async () => {
  const shop = await newShop('5');
  const outcomes = await Promise.allSettled(Array.from({ length: 50 }, (_x, i) => pilot.likeATill(() => (i % 2 === 0 ? shop.a : shop.b).recordSale(`last-${i}`, '1'))));
  const issued = outcomes.filter((o) => o.status === 'fulfilled');
  assert.equal(issued.length, 5, `issued ${issued.length}; refusals: ${[...new Set(outcomes.filter((o) => o.status === 'rejected').map(codeOf))].join(', ')}`);
  assert.equal(await onHand(shop.ids.companyId), 0);
  // The rest are refused as a shortage the shopkeeper can act on, not as a database error.
  const refusals = new Set(outcomes.filter((o) => o.status === 'rejected').map(codeOf));
  assert.ok([...refusals].every((code) => ['SALES_NEEDS_INFO', 'STOCK_WOULD_GO_NEGATIVE', 'STOCK_INSUFFICIENT'].includes(code)), [...refusals].join(', '));
  const counts = await scalar(shop.ids.companyId, `SELECT
      (SELECT count(*)::int FROM sales_invoices WHERE company_id = $1 AND state = 'FINAL') AS bills,
      (SELECT count(*)::int FROM stock_movements WHERE company_id = $1 AND kind = 'SALE_OUT') AS movements,
      (SELECT count(*)::int FROM voucher WHERE company_id = $1 AND type = 'SALE') AS vouchers`);
  assert.deepEqual(counts, { bills: 5, movements: 5, vouchers: 5 }, 'a refused sale leaves no bill, no movement and no entry behind');
});

/** Records `count` one-crate sales from a separate server process. */
const secondServer = (ids: PilotIds, prefix: string, count: number) =>
  new Promise<{ issued: number; failed: string[] }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./concurrency-child.ts', import.meta.url)), ids.companyId, ids.userId, ids.partyId, prefix, String(count)], {
      env: { ...process.env, DATABASE_URL: appUrl },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1) as string)) : reject(new Error(`server process exited ${code}: ${err}`))));
  });

test('200 bills at once from two server processes: 200 numbers, every one used once, none skipped', { skip }, async () => {
  const shop = await newShop('500');
  const [first, second] = await Promise.all([secondServer(shop.ids, 'p1', 100), secondServer(shop.ids, 'p2', 100)]);
  assert.deepEqual([first.issued, second.issued], [100, 100], JSON.stringify([first.failed, second.failed]));
  const { rows } = await owner.tenantTransaction(shop.ids.companyId, (sql) => sql.query(
    "SELECT number FROM sales_invoices WHERE company_id = $1 AND state = 'FINAL' ORDER BY number", [shop.ids.companyId]));
  const numbers = rows.map((r) => String(r.number));
  assert.equal(numbers.length, 200);
  assert.equal(new Set(numbers).size, 200, 'no number twice');
  assert.deepEqual(numbers, Array.from({ length: 200 }, (_x, i) => `INV/26-27/${String(i + 1).padStart(6, '0')}`), 'INV/26-27/000001 to 000200, no gap');
  assert.equal(await onHand(shop.ids.companyId), 300_000_000);
});

test('the same request sent 20 times at once, to two servers: one bill, one entry, one stock movement', { skip }, async () => {
  const shop = await newShop('100');
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_x, i) => pilot.likeATill(() => (i % 2 === 0 ? shop.a : shop.b).recordSale('double-click'))));
  const answers = outcomes.filter((o) => o.status === 'fulfilled').map((o) => (o as PromiseFulfilledResult<{ invoice: { id: string; number: string | null } }>).value.invoice);
  assert.equal(answers.length, 20, `refused: ${outcomes.filter((o) => o.status === 'rejected').map(codeOf).join(', ')}`);
  assert.equal(new Set(answers.map((bill) => bill.id)).size, 1, 'every retry is answered with the same bill');
  assert.equal(new Set(answers.map((bill) => bill.number)).size, 1);
  const counts = await scalar(shop.ids.companyId, `SELECT
      (SELECT count(*)::int FROM sales_invoices WHERE company_id = $1) AS bills,
      (SELECT count(*)::int FROM voucher WHERE company_id = $1 AND type = 'SALE') AS vouchers,
      (SELECT count(*)::int FROM stock_movements WHERE company_id = $1 AND kind = 'SALE_OUT') AS movements,
      (SELECT count(*)::int FROM outbox_messages WHERE company_id = $1) AS irn_requests`);
  assert.deepEqual(counts, { bills: 1, vouchers: 1, movements: 1, irn_requests: 1 });
  assert.equal(await onHand(shop.ids.companyId), 97_000_000);
});

test('a lock that is not free in time is a plain "please try again", and nothing is saved', { skip }, async () => {
  const shop = await newShop('10');
  // Someone holds the counter that numbers the shop's bills, and does not let go.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => { locked = resolve; });
  const holder = owner.tenantTransaction(shop.ids.companyId, async (sql) => {
    await sql.query("INSERT INTO ledger_sequence (company_id, scope, value) VALUES ($1, 'sales:INV::2026-27', 0) ON CONFLICT DO NOTHING", [shop.ids.companyId]);
    await sql.query("SELECT value FROM ledger_sequence WHERE company_id = $1 AND scope = 'sales:INV::2026-27' FOR UPDATE", [shop.ids.companyId]);
    locked();
    await held;
  });
  await isLocked;
  const sale = serverA.unitOfWork(shop.ids.companyId, async (uow) => {
    await uow.sql.query("SET LOCAL lock_timeout = '200ms'");
    return shop.a.recordSale('waits-too-long', '1');
  });
  await assert.rejects(sale, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'TRY_AGAIN');
    assert.match((error as Error).message, /did not go through.*Please try again/);
    return true;
  });
  release();
  await holder;
  assert.equal(Number((await scalar(shop.ids.companyId, 'SELECT count(*)::int AS n FROM sales_invoices WHERE company_id = $1')).n), 0, 'nothing was saved');
  // The retry, once the counter is free, goes through as the first bill.
  const retried = await shop.a.recordSale('waits-too-long', '1');
  assert.equal(retried.invoice.number, 'INV/26-27/000001');
});

test('"Issue" pressed twice on one bill, landing on two servers: both are answered with the issued bill, and no stock stays held', { skip }, async () => {
  const shop = await newShop('10');
  for (let round = 0; round < 5; round += 1) {
    const draft = await serverA.unitOfWork(shop.ids.companyId, () => shop.a.sales.createDraft(shop.a.actor, {
      idempotencyKey: `twice-${round}`,
      input: {
        partyId: shop.a.customerId as never, customerType: 'B2B', supplyKind: 'GOODS', documentDate: '2026-04-10' as never,
        lines: [{ lineId: 'l1', itemId: shop.a.itemId, quantity: { scaled: 1_000_000n, unit: 'PCS' }, unitPrice: { minor: 33_333n, currency: 'INR' } as never, priceBasis: 'EXCLUSIVE' }],
      },
    }));
    // Called as the API calls it: finalise opens its own units of work (the hold, then the bill), so
    // the two presses really do interleave between them.
    const presses = await Promise.allSettled([shop.a, shop.b].map((server) =>
      server.sales.finalise(server.actor, { idempotencyKey: `twice-${round}-final`, invoiceId: draft.id })));
    assert.deepEqual(presses.map((p) => p.status), ['fulfilled', 'fulfilled'], presses.map((p) => (p.status === 'rejected' ? codeOf(p) : 'ok')).join(', '));
    const numbers = presses.map((p) => (p as PromiseFulfilledResult<{ invoice: { number: string | null } }>).value.invoice.number);
    assert.equal(numbers[0], numbers[1], 'both presses name the same bill');
  }
  const counts = await scalar(shop.ids.companyId, `SELECT
      (SELECT count(*)::int FROM sales_invoices WHERE company_id = $1 AND state = 'FINAL') AS bills,
      (SELECT count(*)::int FROM stock_movements WHERE company_id = $1 AND kind = 'SALE_OUT') AS movements,
      (SELECT count(*)::int FROM stock_reservations WHERE company_id = $1 AND state = 'HELD') AS still_held`);
  assert.deepEqual(counts, { bills: 5, movements: 5, still_held: 0 });
  assert.equal(await onHand(shop.ids.companyId), 5_000_000);
});
