/**
 * Issue #363 "Done when", on a real PostgreSQL:
 *
 *  1. The server process is killed after the ledger write and before the stock write: nothing is
 *     persisted — no bill, no voucher, no movement, no idempotency key, no audit row, no outbox row.
 *  2. An IRN request is only sent after the sale has committed.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { OutboxMessage } from '../../platform/src/outbox.ts';
import type { PilotHooks, PilotIds } from './record-sale-pilot.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the record-a-sale database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let db: TransactionalExecutor;
let pilot: typeof import('./record-sale-pilot.ts');
let OutboxRelay: typeof import('../../platform/src/outbox.ts').OutboxRelay;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  ({ OutboxRelay } = await import('../../platform/src/outbox.ts'));
  pilot = await import('./record-sale-pilot.ts');
  db = createDatabase(url);
  await migrate(db);
  await db.query(pilot.PILOT_TABLES);
});
after(async () => { await db?.close(); });

type Counts = Awaited<ReturnType<typeof import('./record-sale-pilot.ts').persisted>>;
const NOTHING = { bills: 0, vouchers: 0, journalLines: 0, stockMovements: 0, idempotencyKeys: 0, auditRows: 0, outboxRows: 0 };

/** A fresh synthetic company with books, and what its setup alone left in the database. */
const newShop = async (hooks: PilotHooks = {}) => {
  const ids: PilotIds = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
  const shop = pilot.makePilot(db, ids, hooks);
  await shop.setUp();
  const baseline = await pilot.persisted(db, ids.companyId);
  const sinceSetup = async () => {
    const now = await pilot.persisted(db, ids.companyId);
    return Object.fromEntries(Object.keys(NOTHING).map((key) => [key, now[key as keyof typeof now] - baseline[key as keyof typeof baseline]]));
  };
  return { ids, shop, sinceSetup };
};

/** Records a sale in a separate server process and kills it at `crashAt`. Returns what its transaction had written. */
const crash = (ids: PilotIds, crashAt: 'before-stock' | 'before-commit', requestId: string) =>
  new Promise<{ signal: NodeJS.Signals | null; written: Counts; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./record-sale-pilot.ts', import.meta.url)), ids.companyId, ids.userId, ids.partyId, crashAt, requestId], {
      env: { ...process.env, DATABASE_URL: url },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (_code, signal) => {
      try { resolve({ signal, written: JSON.parse(stdout) as Counts, stderr }); } catch { reject(new Error(`the child did not reach its crash point: ${stderr || stdout}`)); }
    });
  });

test('a sale that goes through saves all of it together: bill, entry, stock, idempotency key, audit and the e-invoice request', { skip }, async () => {
  const { shop, sinceSetup } = await newShop();
  const result = await shop.recordSale('r1');
  assert.equal(result.invoice.state, 'FINAL');
  assert.equal(result.invoice.number, 'INV/26-27/000001');
  assert.deepEqual(result.registrations, [{ kind: 'E_INVOICE', status: 'PENDING', reference: null }]);
  // Five lines: customer, sales, CGST, SGST and round-off. Audit: the draft, the ledger posting and the bill. So the crash tests below prove something for every kind of row.
  assert.deepEqual(await sinceSetup(), { bills: 1, vouchers: 1, journalLines: 5, stockMovements: 1, idempotencyKeys: 1, auditRows: 3, outboxRows: 1 });
});

test('killed after the ledger write and before the stock write: nothing is persisted', { skip }, async () => {
  const { ids, shop, sinceSetup } = await newShop();
  const baseline = await pilot.persisted(db, ids.companyId);

  const dead = await crash(ids, 'before-stock', 'r1');
  assert.equal(dead.signal, 'SIGKILL', dead.stderr);
  // Inside its transaction the child had written the bill, the entry, its idempotency key and audit rows…
  assert.equal(dead.written.bills, 1);
  assert.equal(dead.written.vouchers - baseline.vouchers, 1);
  assert.equal(dead.written.journalLines - baseline.journalLines, 5);
  assert.equal(dead.written.idempotencyKeys - baseline.idempotencyKeys, 1);
  assert.ok(dead.written.auditRows - baseline.auditRows >= 1);
  assert.equal(dead.written.stockMovements, 0, 'the stock write had not happened yet');
  // …and none of it exists.
  assert.deepEqual(await sinceSetup(), NOTHING);

  // The retry is a clean first attempt: the same bill number, so the series has no gap.
  const retried = await shop.recordSale('r1');
  assert.equal(retried.invoice.number, 'INV/26-27/000001');
  assert.deepEqual(await sinceSetup(), { bills: 1, vouchers: 1, journalLines: 5, stockMovements: 1, idempotencyKeys: 1, auditRows: 3, outboxRows: 1 });
});

test('killed after every write and just before the commit: still nothing is persisted', { skip }, async () => {
  const { ids, sinceSetup } = await newShop();
  const baseline = await pilot.persisted(db, ids.companyId);
  const dead = await crash(ids, 'before-commit', 'r1');
  assert.equal(dead.signal, 'SIGKILL', dead.stderr);
  // Every kind of row was written inside the transaction, including the stock movement and the e-invoice request.
  assert.deepEqual(
    Object.fromEntries(Object.keys(NOTHING).map((key) => [key, dead.written[key as keyof Counts] - baseline[key as keyof typeof baseline]])),
    { bills: 1, vouchers: 1, journalLines: 5, stockMovements: 1, idempotencyKeys: 1, auditRows: 3, outboxRows: 1 },
  );
  assert.deepEqual(await sinceSetup(), NOTHING);
});

test('a sale refused part-way (the goods were gone) leaves nothing, and the server carries on', { skip }, async () => {
  const { shop, sinceSetup } = await newShop({ beforeStockWrite: async () => { throw new Error('someone else took the last crate'); } });
  await assert.rejects(shop.recordSale('r1'), /someone else took the last crate/);
  assert.deepEqual(await sinceSetup(), NOTHING);
});

test('the IRN request is sent only after the sale has committed, and never for a sale that did not', { skip }, async () => {
  const requests: { number: unknown; billWasCommitted: boolean }[] = [];
  let ids: PilotIds;
  // The mock IRP: at the moment it is called, it looks for the bill on a connection of its own.
  const handlers = {
    'einvoice.generate': async (message: OutboxMessage) => {
      const { rows } = await db.tenantTransaction(ids.companyId, (sql) => sql.query("SELECT 1 FROM uow_pilot_sales_invoices WHERE id = $1 AND state = 'FINAL'", [message.payload.invoiceId]));
      requests.push({ number: message.payload.number, billWasCommitted: rows.length === 1 });
    },
  };
  const relay = new OutboxRelay(db);

  // While the sale's transaction is still open, a relay finds nothing to send.
  let sentBeforeCommit: unknown;
  const open = await newShop({ beforeCommit: async () => { sentBeforeCommit = await relay.drain(ids.companyId, handlers); } });
  ids = open.ids;
  const sale = await open.shop.recordSale('r1');
  assert.deepEqual(sentBeforeCommit, { sent: 0, failed: 0 });
  assert.deepEqual(requests, [], 'nothing reached the IRP before the commit');

  // After the commit it is sent once, and only once.
  assert.deepEqual(await relay.drain(ids.companyId, handlers), { sent: 1, failed: 0 });
  assert.deepEqual(await relay.drain(ids.companyId, handlers), { sent: 0, failed: 0 });
  assert.deepEqual(requests, [{ number: sale.invoice.number, billWasCommitted: true }]);

  // A sale that fails after queuing its request, and one whose server is killed, send nothing.
  const failed = await newShop({ beforeCommit: async () => { throw new Error('the receipt was refused'); } });
  ids = failed.ids;
  await assert.rejects(failed.shop.recordSale('r2'), /the receipt was refused/);
  assert.deepEqual(await relay.drain(ids.companyId, handlers), { sent: 0, failed: 0 });
  const killed = await newShop();
  ids = killed.ids;
  assert.equal((await crash(ids, 'before-commit', 'r3')).written.outboxRows, 1, 'the request had been queued inside the transaction');
  assert.deepEqual(await relay.drain(ids.companyId, handlers), { sent: 0, failed: 0 });
  assert.equal(requests.length, 1);
});
