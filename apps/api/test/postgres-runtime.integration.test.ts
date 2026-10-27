/**
 * Issue #340 — restarting the API keeps the books.
 *
 * The real server process is started on PostgreSQL as a login that is only a member of
 * `invoice_app`, a bill is made through the HTTP API, the process is stopped and started again, and
 * the same bill, its print copy, its customer and item, the business details and the next bill
 * number are all still there. The rows are then read straight from the database.
 *
 * Needs DATABASE_URL (the owner, for migrations). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { signInOverHttp } from './sign-in-helper.ts';
import { appDatabase, callApi, freePort, killProcess, startApi } from './processes.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the restart test runs.');
const skip = url === undefined && 'DATABASE_URL is not set';

const COMPANY = '00000000-0000-4000-8000-000000000001';
let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
let owner: TransactionalExecutor;
let port: number;
let server: ChildProcess | undefined;
let call: ReturnType<typeof callApi>;
/** A bill of company A, for company B to try to open. */
let sampoornaBill: string | undefined;

const start = async (): Promise<void> => { server = await startApi(database!.appUrl, port); };
const stop = async (): Promise<void> => { await killProcess(server); server = undefined; };

/** Signs in by code (#342) against the running server; the session token from its cookie. */
const signInHere = async (address: string, companyId: string): Promise<string> =>
  (await signInOverHttp(`http://127.0.0.1:${port}`, address, companyId)).split('=')[1]!;

before(async () => {
  if (url === undefined) return;
  database = await appDatabase(url);
  owner = database.owner;
  port = await freePort();
  call = callApi(port);
});

after(async () => {
  await stop();
  await database?.close();
});

test('a bill made before a restart is still there after it, with its copy, its customer and the next number', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  await start();
  const token = await signInHere('owner@sampoorna.example.invalid', COMPANY);
  const details = await call('POST', '/api/business-details', { legalName: 'Sampoorna Traders', address1: 'Plot 14, 2nd Phase, Peenya Industrial Area', city: 'Bengaluru', pincode: '560058', stateCode: '29' }, token);
  assert.equal(details.status, 200);
  const customer = await call('POST', '/api/customers', { name: `Lakshmi Stores ${run}`, registration: 'unregistered', stateCode: '29', pincode: '560058', city: 'Bengaluru', address1: '12 MG Road', acknowledgeSimilar: true }, token);
  assert.equal(customer.status, 200, JSON.stringify(customer));
  const item = await call('POST', '/api/items', { name: `Shop repair visit ${run}`, hsn: '998729', unit: 'NOS', price: '500', kind: 'service', ratePercent: '18', basis: 'Rate this business charges', effectiveFrom: '2026-04-01', acknowledgeSimilar: true }, token);
  assert.equal(item.status, 200, JSON.stringify(item));
  const sale = { customerId: customer.customer.id, itemId: item.item.id, rate: '500', date: '2026-10-16', terms: '0' };
  const first = await call('POST', '/api/sales/record', { ...sale, quantity: '2', reference: `restart-${run}-1`, requestId: `restart-${run}-1` }, token);
  assert.equal(first.status, 200, JSON.stringify(first));
  const number = String(first.invoice.number);
  sampoornaBill = String(first.invoice.id);

  await stop();
  await start();

  // The session was kept, so the person is still signed in.
  const dashboard = await call('GET', '/api/dashboard', undefined, token);
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.activity.some((row: { title: string }) => row.title === `${number} · Lakshmi Stores ${run}`), 'the bill and its customer are listed');
  const reprint = await call('GET', `/api/sales/${first.invoice.id}/preview`, undefined, token);
  assert.equal(reprint.status, 200, 'the frozen print copy came back');
  const second = await call('POST', '/api/sales/record', { ...sale, quantity: '1', reference: `restart-${run}-2`, requestId: `restart-${run}-2` }, token);
  assert.equal(second.status, 200, 'business details and the item rate came back');
  // Later than the first, never the same: another test file may bill this company at the same time.
  assert.ok(Number(String(second.invoice.number).slice(-6)) > Number(number.slice(-6)), 'numbering continues; no number is used again');
  // Issue #366 — the ledger's tables have row-level security; the reports still read this company's books.
  const reports = await call('GET', '/api/reports', undefined, token);
  assert.equal(reports.status, 200, JSON.stringify(reports));
  assert.equal(reports.trialBalance.balanced, true);
  assert.ok(reports.profitAndLoss.income.total >= 1500, `both bills are in the books: ${reports.profitAndLoss.income.total}`);

  // And straight from the database: the bill, its balanced entry in the books, and its audit record.
  const rows = (await owner.query(
    `SELECT i.state, i.invoice_value_paise,
            (SELECT sum(debit_minor) - sum(credit_minor) FROM journal_line j WHERE j.voucher_id = i.voucher_id) AS imbalance,
            (SELECT count(*) FROM audit_events a WHERE a.company_id = i.company_id AND a.action = 'sales.invoice_finalised' AND a.correlation_id = i.id::text) AS audits
       FROM sales_invoices i WHERE i.company_id = $1 AND i.number = $2`, [COMPANY, number])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'FINAL');
  assert.equal(String(rows[0]!.invoice_value_paise), '118000');
  assert.equal(String(rows[0]!.imbalance), '0');
  assert.equal(String(rows[0]!.audits), '1');
});

test('a company on PostgreSQL is never given demo data, and cannot open another company\'s bill', { skip }, async () => {
  await stop();
  await start();
  const session = await signInHere('owner@konkan.example.invalid', '00000000-0000-4000-8000-000000000011');
  assert.equal((await call('GET', '/api/dashboard', undefined, session)).status, 200);
  if (sampoornaBill !== undefined) {
    // Row-level security answers for another company's id exactly as for an id that does not exist.
    assert.equal((await call('GET', `/api/sales/${sampoornaBill}/preview`, undefined, session)).status, 404);
  }
  const konkan = '00000000-0000-4000-8000-000000000011';
  const counts = (await owner.query(
    `SELECT (SELECT count(*) FROM sales_invoices WHERE company_id = $1) AS bills,
            (SELECT count(*) FROM stock_movements WHERE company_id = $1) AS movements,
            (SELECT count(*) FROM master_records WHERE company_id = $1 AND kind <> 'warehouse') AS records,
            (SELECT count(*) FROM app_records WHERE company_id = $1) AS app_records`, [konkan])).rows[0]!;
  assert.deepEqual({ ...counts }, { bills: '0', movements: '0', records: '0', app_records: '0' });
});

test('#342: on PostgreSQL a CA switches business without signing in again; the old session ends', { skip }, async () => {
  if (server === undefined) await start();
  const inSampoorna = await signInHere('ca@example.invalid', COMPANY);
  const switched = await fetch(`http://127.0.0.1:${port}/api/session/company`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, cookie: `__Host-karobar_session=${inSampoorna}` },
    body: JSON.stringify({ companyId: '00000000-0000-4000-8000-000000000011' }),
  });
  assert.equal(switched.status, 200, await switched.clone().text());
  const inKonkan = /__Host-karobar_session=([^;]+)/.exec(switched.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(inKonkan);
  assert.equal((await call('GET', '/api/session', undefined, inKonkan)).company.id, '00000000-0000-4000-8000-000000000011');
  assert.equal((await call('GET', '/api/session', undefined, inSampoorna)).status, 401);
  assert.equal((await call('POST', '/api/auth/sign-out', {}, inKonkan)).status, 200);
  assert.equal((await call('GET', '/api/session', undefined, inKonkan)).status, 401);
});

test('#294: on PostgreSQL an expense and the owner\'s money are in the books after a restart, balanced, under their own heads', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  await stop();
  await start();
  const token = await signInHere('owner@sampoorna.example.invalid', COMPANY);
  const save = async (kind: string, body: Record<string, unknown>) => {
    const checked = await call('POST', `/api/books/${kind}/preview`, body, token);
    assert.equal(checked.status, 200, JSON.stringify(checked));
    const saved = await call('POST', `/api/books/${kind}/record`, { ...body, check: checked.check, requestId: `pg-${run}-${kind}` }, token);
    assert.equal(saved.status, 200, JSON.stringify(saved));
    return saved;
  };
  await save('owner', { direction: 'capital', paidFrom: 'cash', amount: '5000', date: '2026-10-16', narration: `Owner's money ${run}` });
  const rent = await save('expense', { head: 'repairs', paidFrom: 'cash', amount: '1200', date: '2026-10-16', narration: `Rent ${run}` });

  await stop();
  await start();

  const entries = await call('GET', '/api/books/entries?limit=500', undefined, token);
  assert.equal(entries.status, 200, JSON.stringify(entries));
  assert.ok(entries.entries.some((entry: { id: string }) => entry.id === rent.entry.id), 'the rent entry came back');
  const cash = await call('GET', '/api/books/book?book=cash', undefined, token);
  assert.ok(cash.rows.some((row: { narration: string; moneyOut: number }) => row.narration.endsWith(`Rent ${run}`) && row.moneyOut === 1200), `it is in the cash book: ${JSON.stringify(cash.rows.slice(-3))}`);
  const reports = await call('GET', '/api/reports', undefined, token);
  assert.equal(reports.trialBalance.balanced, true);
  assert.ok(reports.profitAndLoss.expenses.rows.some((row: { name: string; amount: number }) => row.name === 'Repairs and upkeep' && row.amount >= 1200), 'Repairs is its own line');
  const imbalance = (await owner.query(
    'SELECT sum(debit_minor) - sum(credit_minor) AS imbalance FROM journal_line WHERE voucher_id = $1', [rent.entry.id])).rows[0]!;
  assert.equal(String(imbalance.imbalance), '0');
});

test('#366: on PostgreSQL a finished business setup is kept in its own company, and a setup with a mistake saves nothing', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  if (server === undefined) await start();
  const token = await signInHere('owner@sampoorna.example.invalid', COMPANY);
  const good = {
    legalName: `Meera Bakers ${run}`, businessType: 'BAKERY', stateCode: '08',
    registration: 'REGULAR', gstin: '08AAAAA0000A1Z2', filingFrequency: 'QUARTERLY',
    booksStartDate: '2026-04-01', itemName: 'Chocolate cake 500g', itemKind: 'GOODS', itemUnit: 'PCS', itemHsn: '1905',
    openingCash: '8000',
  };
  const mistyped = await call('POST', '/api/onboarding/finish', { ...good, legalName: `Mistyped Bakers ${run}`, gstin: '08AAAAA0000A1Z9' }, token);
  assert.equal(mistyped.ok, false, JSON.stringify(mistyped));
  const finished = await call('POST', '/api/onboarding/finish', good, token);
  assert.equal(finished.status, 200, JSON.stringify(finished));
  assert.equal(finished.result.trialBalance.balanced, true);
  assert.equal(finished.result.trialBalance.totalDebits, 8000);

  await stop();
  await start();

  // Straight from the database: the new company, its finished setup, its opening entry and its trail.
  const made = (await owner.query(
    `SELECT c.id, (SELECT state FROM onboarding_sessions s WHERE s.company_id = c.id) AS setup,
            (SELECT count(*) FROM voucher v WHERE v.company_id = c.id AND v.id::text = $2) AS opening,
            (SELECT count(*) FROM audit_events a WHERE a.company_id = c.id AND a.action LIKE 'onboarding.%') AS audits
       FROM companies c WHERE c.legal_name = $1`, [good.legalName, finished.result.openingVoucherId])).rows;
  assert.equal(made.length, 1);
  assert.deepEqual({ setup: made[0]!.setup, opening: String(made[0]!.opening), audits: String(made[0]!.audits) }, { setup: 'COMPLETED', opening: '1', audits: '2' });
  assert.notEqual(made[0]!.id, COMPANY, 'the setup is not written into the session\'s own company');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM companies WHERE legal_name = $1', [`Mistyped Bakers ${run}`])).rows[0]!.n, 0);
});

test('#366: on PostgreSQL an order and a delivery use the business\'s own supplier and item, and stock survives a restart', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  // A registration no earlier run used: five letters from the run, four digits, a letter.
  const pan = `${[...randomBytes(5)].map((byte) => String.fromCharCode(65 + (byte % 26))).join('')}${String(randomBytes(2).readUInt16BE() % 10000).padStart(4, '0')}P`;
  await stop();
  await start();
  const token = await signInHere('owner@sampoorna.example.invalid', COMPANY);
  const supplier = await call('POST', '/api/suppliers', { legalName: `Peenya Steel ${run}`, acknowledgeSimilar: true, registration: 'regular', gstin: syntheticGstin('29', pan), line1: '4 Peenya Road', city: 'Bengaluru', pincode: '560058' }, token);
  assert.equal(supplier.status, 200, JSON.stringify(supplier));
  const item = await call('POST', '/api/items', { name: `TMT bar 12mm ${run}`, hsn: '72142090', unit: 'KGS', price: '60', kind: 'goods', ratePercent: '18', basis: 'Rate this business pays', effectiveFrom: '2026-04-01', acknowledgeSimilar: true }, token);
  assert.equal(item.status, 200, JSON.stringify(item));
  const itemId = String(item.item.id);
  const supplierId = String(supplier.supplier.id);

  // The built-in short ids are not records on PostgreSQL: they are refused in the shopkeeper's words.
  const builtIn = await call('POST', '/api/purchase-orders', { orderNumber: `PO-${run}-0`, date: '2026-10-16', item: 'TMT12', supplierId, quantity: '10', rate: '60', gst: '1800' }, token);
  assert.equal(builtIn.status, 422);
  assert.equal(builtIn.code, 'ITEM_NOT_FOUND');
  // A delivery is from a supplier on the list, never from the demo supplier.
  const nobody = await call('POST', '/api/purchase-orders', { orderNumber: `PO-${run}-0`, date: '2026-10-16', item: itemId, quantity: '10', rate: '60', gst: '1800' }, token);
  assert.equal(nobody.status, 422);
  assert.equal(nobody.code, 'SUPPLIER_REQUIRED');

  const order = await call('POST', '/api/purchase-orders', { orderNumber: `PO-${run}`, date: '2026-10-16', item: itemId, supplierId, quantity: '100', rate: '60', gst: '1800' }, token);
  assert.equal(order.status, 200, JSON.stringify(order));
  const before = Number(String(order.stock.onShelf).replace(/[^0-9.]/g, ''));
  const receipt = await call('POST', '/api/goods-receipts', { receiptNumber: `GRN-${run}`, orderNumber: `PO-${run}`, date: '2026-10-17', item: itemId, received: '100', accepted: '90', rejectionNote: 'Ten bars bent' }, token);
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  assert.equal(Number(String(receipt.stock.onShelf).replace(/[^0-9.]/g, '')), before + 90, 'only what was kept goes on the shelf');

  await stop();
  await start();
  const again = await call('POST', '/api/purchases/match', { reference: `SB-${run}`, orderNumber: `PO-${run}`, date: '2026-10-18', item: itemId, quantity: '100', rate: '60', gst: '1800' }, token);
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal(Number(String(again.stock.onShelf).replace(/[^0-9.]/g, '')), before + 90, 'the delivery is still on the shelf after the restart');
  assert.equal(again.outcome, 'HOLD_FOR_APPROVAL', 'billed 100 against 90 kept is held, not passed');

  const rows = (await owner.query(
    `SELECT (SELECT count(*) FROM purchase_orders WHERE company_id = $1 AND order_number = $2) AS orders,
            (SELECT count(*) FROM goods_receipts WHERE company_id = $1 AND receipt_number = $3 AND supplier_party_id = $4) AS receipts,
            (SELECT count(*) FROM stock_movements WHERE company_id = $1 AND item_id = $5) AS movements`,
    [COMPANY, `PO-${run}`, `GRN-${run}`, supplierId, itemId])).rows[0]!;
  assert.deepEqual({ ...rows }, { orders: '1', receipts: '1', movements: '1' });
});
