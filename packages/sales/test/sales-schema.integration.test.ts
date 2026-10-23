/**
 * Issue #365 — the tables for sales bills, stock, payments, advances, challans and quotations, on a
 * real PostgreSQL. Design: docs/contracts/sales-schema-v1.md.
 *
 * Everything here is done as the application's own role (a login that is only a member of
 * `invoice_app`), because that is what the server connects as: the rules must hold for it without
 * any help from our code. `owner` is what migrations run as, and only sets the scene.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the sales schema database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let pilot: typeof import('./record-sale-pilot.ts');
let createDatabase: typeof import('../../platform/src/database.ts').createDatabase;
const login = `invoice_app_schema_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  ({ createDatabase } = await import('../../platform/src/database.ts'));
  const { migrate } = await import('../../platform/src/migrations.ts');
  pilot = await import('./record-sale-pilot.ts');
  owner = createDatabase(url);
  await migrate(owner);
  await owner.query(pilot.PILOT_TABLES);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const refused = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string }).code ?? '');
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const FROZEN = '23001';
const NO_PRIVILEGE = '42501';

const insert = (sql: SqlExecutor, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return sql.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
};

/** A synthetic shop with books, two posted ledger entries to point at, and master records for a customer, an item and a godown. */
const newShop = async () => {
  const ids = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
  const shop = pilot.makePilot(app, ids);
  // Only the books and two posted entries: since #366 a recorded sale writes these very tables, which would fill the scene this test sets itself.
  await shop.setUpBooks();
  const [first, second] = [await shop.postEntry('v1'), await shop.postEntry('v2')];
  const [itemId, warehouseId] = [crypto.randomUUID(), crypto.randomUUID()];
  await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $4, 'party'), ($2, $4, 'item'), ($3, $4, 'warehouse')", [ids.partyId, itemId, warehouseId, ids.companyId]);
  /** One transaction as the application, for this company. Deferred checks run when it ends. */
  const run = <T>(work: (sql: SqlExecutor) => Promise<T>) => app.tenantTransaction(ids.companyId, work);
  /** The same as the owner of the tables: the rules bind whoever asks. */
  const asOwner = (text: string, values: unknown[] = []) => owner.tenantTransaction(ids.companyId, (sql) => sql.query(text, values));
  const one = async (text: string, values: unknown[] = []) => (await run((sql) => sql.query(text, values))).rows[0] as Record<string, unknown>;

  const billRow = (id: string, over: Record<string, unknown> = {}) => ({
    id, company_id: ids.companyId, state: 'DRAFT', document_date: '2026-04-10', party_id: ids.partyId, customer_type: 'B2B', supply_kind: 'GOODS',
    round_to_whole_rupee: true, created_by: ids.userId, idempotency_key: `bill:${id}`, version: 0, ...over,
  });
  const lineRow = (foreignKey: string, id: string, over: Record<string, unknown> = {}) => ({
    company_id: ids.companyId, [foreignKey]: id, line_id: 'l1', line_no: 1, item_id: itemId, warehouse_id: warehouseId,
    quantity_micro: 3_000_000, unit_code: 'PCS', unit_price_paise: 10_000, price_basis: 'EXCLUSIVE',
    item_name: 'Plastic crate', hsn_or_sac: '3923', rate_bp: 1800, taxable_value_paise: 30_000, cgst_paise: 2_700, sgst_paise: 2_700, ...over,
  });
  /** ₹300.00 of crates plus 18% GST: ₹354.00. */
  const PRICED = { pricing: '{}', line_count: 1, taxable_value_paise: 30_000, cgst_paise: 2_700, sgst_paise: 2_700, utgst_paise: 0, igst_paise: 0, cess_paise: 0, total_tax_paise: 5_400, reverse_charge_tax_paise: 0, round_off_paise: 0, invoice_value_paise: 35_400 };
  const issued = (number: string) => ({ ...PRICED, state: 'FINAL', number, financial_year: '2026-27', voucher_id: first.voucherId, finalised_by: ids.userId, finalised_at: '2026-04-10T11:04:00Z' });

  /** An issued bill of ₹354.00 with its line and its settlement row, as the sales repository will write them. */
  const issueBill = async (number: string) => {
    const id = crypto.randomUUID();
    await run(async (sql) => {
      await insert(sql, 'sales_invoices', billRow(id, issued(number)));
      await insert(sql, 'sales_invoice_lines', lineRow('invoice_id', id));
      await insert(sql, 'document_settlements', { id: crypto.randomUUID(), company_id: ids.companyId, document_kind: 'SALES_INVOICE', document_id: id, document_number: number, party_id: ids.partyId, side: 'RECEIVABLE', document_date: '2026-04-10', value_paise: 35_400 });
    });
    return id;
  };
  const movement = (kind: string, quantity: number, over: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    return {
      id, company_id: ids.companyId, item_id: itemId, warehouse_id: warehouseId, kind, direction: kind.endsWith('_OUT') ? 'OUT' : 'IN',
      quantity_micro: quantity, unit_code: 'PCS', entered_quantity_micro: quantity, entered_unit_code: 'PCS', document_date: '2026-04-10',
      source_kind: 'test', source_id: id, posted_by: ids.userId, posted_at: '2026-04-10T11:04:00Z', idempotency_key: `move:${id}`, ...over,
    };
  };
  const payment = (amount: number, over: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    return {
      id, company_id: ids.companyId, direction: 'RECEIPT', party_id: ids.partyId, mode: 'CASH', amount_paise: amount, payment_date: '2026-04-11',
      state: 'RECORDED', recorded_by: ids.userId, recorded_at: '2026-04-11T10:00:00Z', idempotency_key: `pay:${id}`, version: 0, ...over,
    };
  };
  const allocation = (paymentId: string, billId: string, amount: number) => ({ company_id: ids.companyId, payment_id: paymentId, document_kind: 'SALES_INVOICE', document_id: billId, document_number: 'INV', amount_paise: amount });
  const onHand = async () => Number((await one('SELECT COALESCE(sum(on_hand_micro), 0)::bigint AS n FROM stock_balances WHERE company_id = $1 AND item_id = $2', [ids.companyId, itemId])).n);
  return { ids, itemId, warehouseId, asOwner, vouchers: [first.voucherId, second.voucherId], run, one, billRow, lineRow, PRICED, issued, issueBill, movement, payment, allocation, onHand };
};

test('the migrations of #365 run up, down and up again on a database of their own', { skip }, async () => {
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { migrations } = await import('../../platform/src/migration-definitions.ts');
  const { withScratchDatabase } = await import('../../platform/test/scratch-database.ts');
  await withScratchDatabase(owner, url as string, 'schema_updown', async (scratch) => {
    const mine = migrations.filter((m) => /_(sales|inventory|receivables)_[0-9a-f]{12}_/.test(m.id));
    const tables = async () => (await scratch.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(sales_invoice|presale_document|delivery_challan|stock_|payment|cheque_events|document_settlements|advance_|refund_vouchers)' ORDER BY 1",
    )).rows.map((r) => String(r.tablename));
    assert.equal(mine.length, 4);
    await migrate(scratch);
    const created = await tables();
    assert.equal(created.length, 17, created.join(', '));
    // As a real rollback would: every migration newer than #365's first is undone, newest first, so
    // later modules' foreign keys onto these tables (and onto master_records) go before they do.
    const firstOfMine = migrations.indexOf(mine[0] as (typeof migrations)[number]);
    const fromMine = migrations.slice(firstOfMine);
    for (const migration of [...fromMine].reverse()) await scratch.query(migration.down);
    assert.deepEqual(await tables(), []);
    const left = (await scratch.query("SELECT proname FROM pg_proc WHERE proname IN ('document_lines_add_up','sales_return_within_original','sales_discard_draft','stock_movement_moves_balance','payment_allocation_moves_balances','payment_refund_moves_receipt','advance_not_overused')")).rows;
    assert.deepEqual(left, [], 'the down migrations leave no function behind');
    for (const migration of fromMine) await scratch.query(migration.up);
    assert.deepEqual(await tables(), created);
  });
});

test('a bill gets its number only when it is issued, and an issued bill is complete', { skip }, async () => {
  const shop = await newShop();
  const draft = crypto.randomUUID();
  await shop.run(async (sql) => {
    await insert(sql, 'sales_invoices', shop.billRow(draft));
    await insert(sql, 'sales_invoice_lines', shop.lineRow('invoice_id', draft, { taxable_value_paise: null, cgst_paise: 0, sgst_paise: 0 }));
  });
  // A draft is edited freely.
  await shop.run((sql) => sql.query('UPDATE sales_invoice_lines SET quantity_micro = 5000000 WHERE invoice_id = $1', [draft]));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE sales_invoices SET number = 'INV/26-27/000009', financial_year = '2026-27' WHERE id = $1", [draft])), refused(CHECK), 'a draft never holds a number');
  await assert.rejects(shop.run((sql) => sql.query("UPDATE sales_invoices SET state = 'FINAL' WHERE id = $1", [draft])), refused(CHECK), 'an issued bill needs its number');
  await assert.rejects(shop.run((sql) => insert(sql, 'sales_invoices', shop.billRow(crypto.randomUUID(), { ...shop.issued('INV/26-27/000001'), voucher_id: null }))), refused(CHECK), 'and its entry in the books');
  await assert.rejects(shop.run((sql) => insert(sql, 'sales_invoices', shop.billRow(crypto.randomUUID(), shop.issued('INV/26-27/0000001')))), refused(CHECK), 'a number is at most sixteen characters');
  await assert.rejects(shop.run((sql) => insert(sql, 'sales_invoices', shop.billRow(crypto.randomUUID(), { ...shop.issued('INV/26-27/000001'), invoice_value_paise: 35_401 }))), refused(CHECK), 'the value is taxable value plus tax plus rounding');

  // Issued, but the lines do not add up to the totals: refused when the transaction ends.
  await assert.rejects(shop.run((sql) => sql.query(
    `UPDATE sales_invoices SET state = 'FINAL', number = 'INV/26-27/000001', financial_year = '2026-27', voucher_id = $2, finalised_by = $3, finalised_at = now(),
       pricing = '{}', line_count = 1, taxable_value_paise = 30000, cgst_paise = 2700, sgst_paise = 2700, utgst_paise = 0, igst_paise = 0, cess_paise = 0,
       total_tax_paise = 5400, reverse_charge_tax_paise = 0, round_off_paise = 0, invoice_value_paise = 35400 WHERE id = $1`, [draft, shop.vouchers[0], shop.ids.userId])), refused(CHECK));
  assert.equal((await shop.one('SELECT state FROM sales_invoices WHERE id = $1', [draft])).state, 'DRAFT');

  const first = await shop.issueBill('INV/26-27/000001');
  await assert.rejects(shop.issueBill('INV/26-27/000001'), refused(UNIQUE), 'a number is used once');
  await assert.rejects(shop.run((sql) => insert(sql, 'sales_invoices', shop.billRow(crypto.randomUUID(), { idempotency_key: `bill:${first}` }))), refused(UNIQUE), 'a retry lands once');

  // An unissued bill may be discarded, and its lines replaced, but only through the one function
  // that checks it is unissued: the application has no right to delete from these tables at all.
  await assert.rejects(shop.run((sql) => sql.query('DELETE FROM sales_invoice_lines WHERE invoice_id = $1', [draft])), refused(NO_PRIVILEGE));
  await assert.rejects(shop.run((sql) => sql.query('DELETE FROM sales_invoices WHERE id = $1', [draft])), refused(NO_PRIVILEGE));
  const discard = async (from: typeof shop, id: string, linesOnly: boolean) => (await from.one('SELECT sales_discard_draft($1, $2) AS done', [id, linesOnly])).done;
  const other = await newShop();
  assert.equal(await discard(other, draft, false), false, "another company cannot discard this company's draft");
  assert.equal(await discard(shop, first, false), false, 'an issued bill is not discarded');
  assert.equal(await discard(shop, first, true), false, 'nor are its lines');
  assert.equal(await discard(shop, draft, true), true);
  assert.deepEqual(await shop.one('SELECT (SELECT count(*)::int FROM sales_invoice_lines WHERE invoice_id = $1) AS lines, (SELECT count(*)::int FROM sales_invoices WHERE id = $1) AS bills', [draft]), { lines: 0, bills: 1 });
  assert.equal(await discard(shop, draft, false), true);
  assert.deepEqual(await shop.one('SELECT (SELECT count(*)::int FROM sales_invoices WHERE id = $1) AS drafts, (SELECT count(*)::int FROM sales_invoice_lines WHERE invoice_id = $2) AS issued_lines', [draft, first]), { drafts: 0, issued_lines: 1 });
});

test('an issued bill cannot be changed, deleted, moved back to a draft or given another line; it can be cancelled', { skip }, async () => {
  const shop = await newShop();
  const bill = await shop.issueBill('INV/26-27/000001');
  const change = (text: string, values: unknown[] = [bill]) => shop.run((sql) => sql.query(text, values));
  await assert.rejects(change('UPDATE sales_invoices SET invoice_value_paise = 1, taxable_value_paise = 1, total_tax_paise = 0, cgst_paise = 0, sgst_paise = 0 WHERE id = $1'), refused(FROZEN));
  await assert.rejects(change("UPDATE sales_invoices SET document_date = '2026-04-11' WHERE id = $1"), refused(FROZEN));
  await assert.rejects(change("UPDATE sales_invoices SET state = 'DRAFT', number = NULL, financial_year = NULL WHERE id = $1"), refused(FROZEN));
  await assert.rejects(change('DELETE FROM sales_invoices WHERE id = $1'), refused(NO_PRIVILEGE));
  await assert.rejects(shop.asOwner('DELETE FROM sales_invoices WHERE id = $1', [bill]), refused(FROZEN, FOREIGN_KEY));
  await assert.rejects(shop.asOwner('DELETE FROM sales_invoice_lines WHERE invoice_id = $1', [bill]), refused(FROZEN));
  await assert.rejects(change('UPDATE sales_invoice_lines SET quantity_micro = 1 WHERE invoice_id = $1'), refused(FROZEN));
  await assert.rejects(owner.query('TRUNCATE sales_invoices CASCADE'), refused(FROZEN));
  // A line slipped in later, even one worth nothing, no longer adds up.
  await assert.rejects(shop.run((sql) => insert(sql, 'sales_invoice_lines', shop.lineRow('invoice_id', bill, { line_id: 'l2', line_no: 2, taxable_value_paise: 0, cgst_paise: 0, sgst_paise: 0 }))), refused(CHECK));

  await assert.rejects(change("UPDATE sales_invoices SET state = 'CANCELLED' WHERE id = $1"), refused(CHECK), 'a cancellation says who, when, why and names its reversal');
  await change("UPDATE sales_invoices SET state = 'CANCELLED', cancellation_voucher_id = $2, cancelled_by = $3, cancelled_at = now(), cancel_reason = 'Wrong customer.', version = version + 1, updated_at = now() WHERE id = $1", [bill, shop.vouchers[1], shop.ids.userId]);
  await assert.rejects(change("UPDATE sales_invoices SET state = 'FINAL', cancellation_voucher_id = NULL, cancelled_by = NULL, cancelled_at = NULL, cancel_reason = NULL WHERE id = $1"), refused(FROZEN), 'a cancelled bill stays cancelled');
});

test("one company's rows cannot point at, or be seen from, another company", { skip }, async () => {
  const [mine, theirs] = [await newShop(), await newShop()];
  const bill = await mine.issueBill('INV/26-27/000001');
  assert.equal((await theirs.run((sql) => sql.query('SELECT id FROM sales_invoices WHERE id = $1', [bill]))).rows.length, 0);
  assert.equal((await theirs.run((sql) => sql.query('SELECT id FROM sales_invoice_lines'))).rows.length, 0);
  await assert.rejects(mine.run((sql) => insert(sql, 'sales_invoices', mine.billRow(crypto.randomUUID(), { party_id: theirs.ids.partyId }))), refused(FOREIGN_KEY), "another company's customer");
  const draft = crypto.randomUUID();
  await mine.run((sql) => insert(sql, 'sales_invoices', mine.billRow(draft)));
  await assert.rejects(mine.run((sql) => insert(sql, 'sales_invoice_lines', mine.lineRow('invoice_id', draft, { item_id: theirs.itemId }))), refused(FOREIGN_KEY), "another company's item");
  await assert.rejects(mine.run((sql) => insert(sql, 'sales_invoices', mine.billRow(crypto.randomUUID(), { ...mine.issued('INV/26-27/000002'), voucher_id: theirs.vouchers[0] }))), refused(FOREIGN_KEY), "another company's ledger entry");
  await assert.rejects(mine.run((sql) => insert(sql, 'sales_invoices', { ...mine.billRow(crypto.randomUUID()), company_id: theirs.ids.companyId, party_id: theirs.ids.partyId, created_by: theirs.ids.userId })), refused(NO_PRIVILEGE), "a row for another company");
  await assert.rejects(mine.run((sql) => insert(sql, 'stock_movements', mine.movement('PURCHASE_IN', 1_000_000, { warehouse_id: theirs.warehouseId }))), refused(FOREIGN_KEY));
});

test('stock is the sum of its movements, kept by the database, and never goes below nothing', { skip }, async () => {
  const shop = await newShop();
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('PURCHASE_IN', 5_000_000, { unit_cost_paise: 8_000 })));
  assert.equal(await shop.onHand(), 5_000_000);

  // The application cannot write a balance, only read and lock it.
  await assert.rejects(shop.run((sql) => sql.query('UPDATE stock_balances SET on_hand_micro = 999000000 WHERE company_id = $1', [shop.ids.companyId])), refused(NO_PRIVILEGE));
  await assert.rejects(shop.run((sql) => sql.query('INSERT INTO stock_balances (company_id, item_id, warehouse_id, unit_code, on_hand_micro) VALUES ($1, $2, $3, $4, 1)', [shop.ids.companyId, shop.itemId, shop.warehouseId, 'PCS'])), refused(NO_PRIVILEGE));
  await assert.rejects(shop.run((sql) => sql.query('DELETE FROM stock_balances WHERE company_id = $1', [shop.ids.companyId])), refused(NO_PRIVILEGE));
  await shop.run((sql) => sql.query('SELECT on_hand_micro FROM stock_balances WHERE company_id = $1 ORDER BY item_id, warehouse_id, batch_id FOR UPDATE', [shop.ids.companyId]));

  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('SALE_OUT', 6_000_000))), refused(CHECK), 'six cannot leave when five are there');
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('SALE_OUT', 1_000_000, { direction: 'IN' }))), refused(CHECK), 'the direction belongs to the kind');
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('SALE_OUT', 1_000_000, { unit_code: 'KGS' }))), refused(CHECK), 'one unit for one stock');
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('SALE_OUT', 0))), refused(CHECK));
  assert.equal(await shop.onHand(), 5_000_000, 'a refused movement moved nothing');

  // 50 sales of one unit each, at once, on separate connections and with no lock of ours: exactly five succeed.
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => shop.run((sql) => insert(sql, 'stock_movements', shop.movement('SALE_OUT', 1_000_000)))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5, String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined)?.reason));
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => refused(CHECK)((r as PromiseRejectedResult).reason)));
  assert.equal(await shop.onHand(), 0);

  // A batch is its own stock, and stock in no batch is not stock in a batch.
  const batchId = crypto.randomUUID();
  await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, 'batch')", [batchId, shop.ids.companyId]);
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('PURCHASE_IN', 2_000_000, { batch_id: batchId })));
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('PURCHASE_IN', 1_000_000)));
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('SALE_OUT', 3_000_000, { batch_id: batchId }))), refused(CHECK));
  assert.equal((await shop.run((sql) => sql.query('SELECT 1 FROM stock_balances WHERE company_id = $1', [shop.ids.companyId]))).rows.length, 2);

  // The balance is exactly the fold of the movements.
  const drift = await shop.run((sql) => sql.query(
    `SELECT b.id FROM stock_balances b WHERE b.company_id = $1 AND b.on_hand_micro <> (
       SELECT COALESCE(sum(CASE m.direction WHEN 'IN' THEN m.quantity_micro ELSE -m.quantity_micro END), 0) FROM stock_movements m
        WHERE m.company_id = b.company_id AND m.item_id = b.item_id AND m.warehouse_id = b.warehouse_id AND m.batch_id IS NOT DISTINCT FROM b.batch_id)`, [shop.ids.companyId]));
  assert.equal(drift.rows.length, 0);

  // A movement is final. It is undone by another movement, once, with a reason.
  const sold = shop.movement('SALE_OUT', 1_000_000);
  await shop.run((sql) => insert(sql, 'stock_movements', sold));
  await assert.rejects(shop.run((sql) => sql.query('UPDATE stock_movements SET quantity_micro = 1 WHERE id = $1', [sold.id])), refused(FROZEN));
  await assert.rejects(shop.asOwner('DELETE FROM stock_movements WHERE id = $1', [sold.id]), refused(FROZEN));
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', sold)), refused(UNIQUE), 'a retry lands once');
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('ADJUSTMENT_IN', 1_000_000, { reverses_movement_id: sold.id, reason: 'No.' }))), refused(CHECK), 'only a reversal undoes a movement');
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('REVERSAL_IN', 1_000_000, { reverses_movement_id: sold.id }))), refused(CHECK), 'and says why');
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('REVERSAL_IN', 1_000_000, { reverses_movement_id: sold.id, reason: 'Bill cancelled.' })));
  await assert.rejects(shop.run((sql) => insert(sql, 'stock_movements', shop.movement('REVERSAL_IN', 1_000_000, { reverses_movement_id: sold.id, reason: 'Again.' }))), refused(UNIQUE));

  // A hold that is over stays over.
  const hold = crypto.randomUUID();
  await shop.run((sql) => insert(sql, 'stock_reservations', { id: hold, company_id: shop.ids.companyId, document_id: 'draft-1', line_id: 'l1', item_id: shop.itemId, warehouse_id: shop.warehouseId, quantity_micro: 1_000_000, unit_code: 'PCS', state: 'HELD', created_by: shop.ids.userId, created_at: '2026-04-10T10:00:00Z', expires_at: '2026-04-10T12:00:00Z' }));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE stock_reservations SET state = 'RELEASED' WHERE id = $1", [hold])), refused(CHECK));
  await shop.run((sql) => sql.query("UPDATE stock_reservations SET state = 'RELEASED', settled_at = now() WHERE id = $1", [hold]));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE stock_reservations SET state = 'HELD', settled_at = NULL WHERE id = $1", [hold])), refused(FROZEN));
});

test('a payment never settles more than itself or more than the bill, and a part payment never marks a bill paid', { skip }, async () => {
  const shop = await newShop();
  const bill = await shop.issueBill('INV/26-27/000001'); // ₹354.00
  const status = async () => (await shop.one("SELECT status, allocated_paise::int AS allocated FROM document_settlements WHERE document_id = $1", [bill]));
  const [small, large] = [shop.payment(10_000), shop.payment(100_000)];
  await shop.run(async (sql) => { await insert(sql, 'payments', small); await insert(sql, 'payments', large); });
  assert.deepEqual(await status(), { status: 'OPEN', allocated: 0 });

  await assert.rejects(shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(small.id, bill, 10_001))), refused(CHECK), 'more than the payment');
  await assert.rejects(shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(large.id, bill, 35_401))), refused(CHECK), 'more than the bill');
  await assert.rejects(shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(small.id, crypto.randomUUID(), 100))), refused(FOREIGN_KEY), 'a bill that was never issued');
  await shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(small.id, bill, 10_000)));
  assert.deepEqual(await status(), { status: 'PARTLY_PAID', allocated: 10_000 });

  // The running figures are the database's: the application cannot set them, on a new row or an old one.
  await assert.rejects(shop.run((sql) => sql.query('UPDATE document_settlements SET allocated_paise = value_paise WHERE document_id = $1', [bill])), refused(NO_PRIVILEGE));
  await assert.rejects(shop.run((sql) => sql.query('UPDATE payments SET allocated_paise = 0 WHERE id = $1', [small.id])), refused(NO_PRIVILEGE));
  await assert.rejects(shop.run((sql) => insert(sql, 'payments', { ...shop.payment(500), allocated_paise: 500 })), refused(NO_PRIVILEGE));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE document_settlements SET status = 'SETTLED' WHERE document_id = $1", [bill])), refused(NO_PRIVILEGE, '428C9'));

  // Two people apply the rest of the bill from the same payment at the same moment: one of them is refused.
  const rest = 25_400;
  const both = await Promise.allSettled([1, 2].map(() => shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(large.id, bill, rest)))));
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.deepEqual(await status(), { status: 'SETTLED', allocated: 35_400 });
  assert.equal(Number((await shop.one('SELECT allocated_paise FROM payments WHERE id = $1', [large.id])).allocated_paise), rest);

  // A payment's figures are fixed; it can be reversed with a reason, and its allocations released, not deleted.
  await assert.rejects(shop.asOwner('UPDATE payments SET amount_paise = 1 WHERE id = $1', [large.id]), refused(FROZEN, CHECK));
  await assert.rejects(shop.asOwner('DELETE FROM payment_allocations WHERE payment_id = $1', [large.id]), refused(FROZEN));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE payments SET state = 'REVERSED' WHERE id = $1", [large.id])), refused(CHECK));
  await shop.run(async (sql) => {
    await sql.query("UPDATE payments SET state = 'REVERSED', reversal_reason = 'Entered twice.', version = version + 1 WHERE id = $1", [large.id]);
    await sql.query('UPDATE payment_allocations SET released_at = now() WHERE payment_id = $1 AND released_at IS NULL', [large.id]);
  });
  assert.deepEqual(await status(), { status: 'PARTLY_PAID', allocated: 10_000 });
  await assert.rejects(shop.run((sql) => sql.query('UPDATE payment_allocations SET released_at = NULL WHERE payment_id = $1', [large.id])), refused(FROZEN));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE payments SET state = 'RECORDED' WHERE id = $1", [large.id])), refused(FROZEN));

  await assert.rejects(shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(large.id, bill, 100))), refused(CHECK), 'a payment that was undone settles nothing');

  // What is paid back out of a receipt counts against it too, and the application cannot set that figure (#367).
  const receipt = shop.payment(20_000);
  await shop.run((sql) => insert(sql, 'payments', receipt));
  await shop.run((sql) => insert(sql, 'payments', shop.payment(15_000, { direction: 'PAYMENT', refund_of: receipt.id })));
  await assert.rejects(shop.run((sql) => insert(sql, 'payments', shop.payment(5_001, { direction: 'PAYMENT', refund_of: receipt.id }))), refused(CHECK), 'more refunded than received');
  const otherBill = await shop.issueBill('INV/26-27/000002');
  await assert.rejects(shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(receipt.id, otherBill, 5_001))), refused(CHECK), 'refunded plus applied is more than received');
  await shop.run((sql) => insert(sql, 'payment_allocations', shop.allocation(receipt.id, otherBill, 5_000)));
  await assert.rejects(shop.run((sql) => sql.query('UPDATE payments SET refunded_paise = 0 WHERE id = $1', [receipt.id])), refused(NO_PRIVILEGE));
  const refund = (await shop.one('SELECT id FROM payments WHERE refund_of = $1', [receipt.id])).id;
  await shop.run((sql) => sql.query("UPDATE payments SET state = 'REVERSED', reversal_reason = 'Refund not paid.', version = version + 1 WHERE id = $1", [refund]));
  assert.equal(Number((await shop.one('SELECT refunded_paise FROM payments WHERE id = $1', [receipt.id])).refunded_paise), 0, 'an undone refund gives the money back to the receipt');

  // A cancelled bill is owed nothing; money already applied to it stays on its payment, as it does today.
  await shop.run((sql) => sql.query('UPDATE document_settlements SET cancelled = true WHERE document_id = $1', [bill]));
  assert.deepEqual(await status(), { status: 'CANCELLED', allocated: 10_000 });

  // A cheque is a cheque in full, and its history is only ever added to.
  await assert.rejects(shop.run((sql) => insert(sql, 'payments', shop.payment(5_000, { mode: 'CHEQUE' }))), refused(CHECK));
  const cheque = shop.payment(5_000, { mode: 'CHEQUE', cheque_number: '000123', cheque_date: '2026-04-11', cheque_state: 'PENDING' });
  const event = (seq: number, state: string) => ({ company_id: shop.ids.companyId, payment_id: cheque.id, seq, state, on_date: '2026-04-11', recorded_by: shop.ids.userId, recorded_at: '2026-04-11T10:00:00Z' });
  await shop.run(async (sql) => { await insert(sql, 'payments', cheque); await insert(sql, 'cheque_events', event(1, 'PENDING')); });
  await shop.run(async (sql) => { await sql.query("UPDATE payments SET cheque_state = 'DEPOSITED' WHERE id = $1", [cheque.id]); await insert(sql, 'cheque_events', event(2, 'DEPOSITED')); });
  await assert.rejects(shop.run((sql) => sql.query("UPDATE cheque_events SET state = 'CLEARED' WHERE payment_id = $1", [cheque.id])), refused(FROZEN));
  assert.equal((await shop.run((sql) => sql.query("SELECT id FROM payments WHERE company_id = $1 AND cheque_state IN ('PENDING','DEPOSITED')", [shop.ids.companyId]))).rows.length, 1, 'one cheque in hand');
});

test('quotations, proformas and challans are closed by the right thing and keep their figures; an advance is never used twice over', { skip }, async () => {
  const shop = await newShop();
  const bill = await shop.issueBill('INV/26-27/000001');
  const presale = (kind: string, number: string, over: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    return { ...shop.billRow(id, { ...shop.PRICED, state: 'ISSUED', kind, number, financial_year: '2026-27', idempotency_key: `presale:${id}`, ...(kind === 'PROFORMA' ? { purpose: 'Advance for crates' } : {}), ...over }) };
  };
  const issuePresale = async (row: Record<string, unknown>) => shop.run(async (sql) => { await insert(sql, 'presale_documents', row); await insert(sql, 'presale_document_lines', shop.lineRow('document_id', row.id as string)); });
  const [quotation, proforma] = [presale('QUOTATION', 'QTN/26-27/000001'), presale('PROFORMA', 'PI/26-27/0000001')];
  await issuePresale(quotation);
  await issuePresale(proforma);
  await assert.rejects(shop.run((sql) => insert(sql, 'presale_documents', presale('PROFORMA', 'PI/26-27/0000002', { purpose: ' ' }))), refused(CHECK), 'a proforma says what it is for');
  await assert.rejects(shop.run((sql) => insert(sql, 'presale_documents', presale('QUOTATION', 'QTN/26-27/000002'))), refused(CHECK), 'no lines, so nothing adds up');
  const link = "invoice_id = $2, invoice_number = 'INV/26-27/000001', invoice_date = '2026-04-10', linked_by = $3, linked_at = now(), link_differences = '[]'";
  await assert.rejects(shop.run((sql) => sql.query(`UPDATE presale_documents SET state = 'INVOICED', ${link} WHERE id = $1`, [quotation.id, bill, shop.ids.userId])), refused(CHECK), 'a quotation is closed by a sale, not a tax invoice');
  await assert.rejects(shop.run((sql) => sql.query("UPDATE presale_documents SET invoice_value_paise = 1, round_off_paise = -35399 WHERE id = $1", [proforma.id])), refused(FROZEN));
  await assert.rejects(shop.run((sql) => sql.query('UPDATE presale_document_lines SET quantity_micro = 1 WHERE document_id = $1', [proforma.id])), refused(FROZEN));
  await shop.run((sql) => sql.query("UPDATE presale_documents SET state = 'CONVERTED', converted_invoice_id = $2, converted_by = $3, converted_at = now(), version = version + 1 WHERE id = $1", [quotation.id, crypto.randomUUID(), shop.ids.userId]));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE presale_documents SET state = 'ISSUED', converted_invoice_id = NULL, converted_by = NULL, converted_at = NULL WHERE id = $1", [quotation.id])), refused(FROZEN));

  // An advance of ₹100.00 against the proforma (goods, so no GST on it): ₹60.00 set against the bill, and no more than ₹40.00 to refund.
  const [moneyIn, moneyOut] = [shop.payment(10_000), shop.payment(4_000, { direction: 'PAYMENT' })];
  const advance = crypto.randomUUID();
  const advanceRow = { id: advance, company_id: shop.ids.companyId, number: 'RV/26-27/00001', financial_year: '2026-27', receipt_date: '2026-04-11', proforma_id: proforma.id, proforma_number: 'PI/26-27/0000001', party_id: shop.ids.partyId, supply_kind: 'GOODS', place_of_supply_state_code: '07', description: 'Plastic crates', amount_paise: 10_000, payment_id: moneyIn.id, recorded_by: shop.ids.userId, recorded_at: '2026-04-11T10:00:00Z', idempotency_key: `advance:${advance}`, version: 0 };
  await assert.rejects(shop.run(async (sql) => { await insert(sql, 'payments', moneyIn); await insert(sql, 'advance_receipts', { ...advanceRow, taxable_value_paise: 8_475, cgst_paise: 762, sgst_paise: 763, utgst_paise: 0, igst_paise: 0, cess_paise: 0, total_tax_paise: 1_525 }); }), refused(CHECK), 'no GST on an advance for goods');
  await shop.run(async (sql) => { await insert(sql, 'payments', moneyIn); await insert(sql, 'payments', moneyOut); await insert(sql, 'advance_receipts', advanceRow); });
  const application = { company_id: shop.ids.companyId, advance_id: advance, invoice_id: bill, invoice_number: 'INV/26-27/000001', invoice_date: '2026-04-10', amount_paise: 6_000, applied_by: shop.ids.userId, applied_at: '2026-04-12T10:00:00Z' };
  const refund = (amount: number) => ({ company_id: shop.ids.companyId, advance_id: advance, number: 'RFV/26-27/00001', refund_date: '2026-04-13', amount_paise: amount, payment_id: moneyOut.id, reason: 'Order reduced.', refunded_by: shop.ids.userId, refunded_at: '2026-04-13T10:00:00Z' });
  await shop.run((sql) => insert(sql, 'advance_applications', application));
  await assert.rejects(shop.run((sql) => insert(sql, 'advance_applications', application)), refused(UNIQUE), 'an advance is set against one bill');
  await assert.rejects(shop.run((sql) => insert(sql, 'refund_vouchers', refund(4_001))), refused(CHECK), 'more than is left of the advance');
  await shop.run((sql) => insert(sql, 'refund_vouchers', refund(4_000)));
  await assert.rejects(shop.run((sql) => sql.query('UPDATE advance_receipts SET amount_paise = 1 WHERE id = $1', [advance])), refused(FROZEN));
  await assert.rejects(shop.run((sql) => sql.query('UPDATE refund_vouchers SET amount_paise = 1 WHERE advance_id = $1', [advance])), refused(FROZEN));

  // A challan: its figures are fixed, an e-way bill may be added, and the bill that follows closes it.
  const challan = crypto.randomUUID();
  const challanRow = { id: challan, company_id: shop.ids.companyId, state: 'ISSUED', number: 'DC/26-27/0000001', financial_year: '2026-27', document_date: '2026-04-09', party_id: shop.ids.partyId, reason: 'SUPPLY_INVOICE_TO_FOLLOW', from_state_code: '07', to_state_code: '07', inter_state: false, shows_tax: true, split: 'CGST_SGST', line_count: 1, taxable_value_paise: 30_000, cgst_paise: 2_700, sgst_paise: 2_700, total_tax_paise: 5_400, created_by: shop.ids.userId, idempotency_key: `challan:${challan}`, version: 0 };
  const challanLine = { company_id: shop.ids.companyId, challan_id: challan, line_id: 'l1', line_no: 1, item_id: shop.itemId, item_name: 'Plastic crate', hsn_or_sac: '3923', quantity_micro: 3_000_000, unit_code: 'PCS', unit_price_paise: 10_000, taxable_value_paise: 30_000, rate_bp: 1800, cgst_paise: 2_700, sgst_paise: 2_700, warehouse_id: shop.warehouseId };
  await assert.rejects(shop.run((sql) => insert(sql, 'delivery_challans', { ...challanRow, reason: 'OTHER_NOT_A_SUPPLY' })), refused(CHECK), '"other" says why');
  await shop.run(async (sql) => { await insert(sql, 'delivery_challans', challanRow); await insert(sql, 'delivery_challan_lines', challanLine); });
  await assert.rejects(shop.run((sql) => sql.query('UPDATE delivery_challan_lines SET quantity_micro = 1 WHERE challan_id = $1', [challan])), refused(FROZEN));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE delivery_challans SET eway_bill_number = '12345' WHERE id = $1", [challan])), refused(CHECK));
  await shop.run((sql) => sql.query("UPDATE delivery_challans SET eway_bill_number = '321001234567', eway_bill_source = 'TYPED', eway_bill_recorded_by = $2, eway_bill_recorded_at = now(), version = version + 1 WHERE id = $1", [challan, shop.ids.userId]));
  await shop.run((sql) => sql.query(`UPDATE delivery_challans SET state = 'INVOICED', ${link}, version = version + 1 WHERE id = $1`, [challan, bill, shop.ids.userId]));
  await assert.rejects(shop.run((sql) => sql.query("UPDATE delivery_challans SET state = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = 'No.' , invoice_id = NULL, invoice_number = NULL, invoice_date = NULL, linked_by = NULL, linked_at = NULL, link_differences = NULL WHERE id = $1", [challan, shop.ids.userId])), refused(FROZEN), 'a billed challan is not withdrawn');
});

test('a credit note cannot take back more than the bill sold on a line, less what earlier notes took back', { skip }, async () => {
  const shop = await newShop();
  const bill = await shop.issueBill('INV/26-27/000001'); // 3 crates on line l1
  const note = async (number: string, quantity: number) => {
    const id = crypto.randomUUID();
    await shop.run(async (sql) => {
      await insert(sql, 'return_notes', { id, company_id: shop.ids.companyId, kind: 'SALES_RETURN', number, document_date: '2026-04-12', original_document_id: bill, original_document_number: 'INV/26-27/000001', original_document_date: '2026-04-10', party_id: shop.ids.partyId, reason: 'Damaged.', taxable_value_paise: 10_000, total_paise: 11_800, voucher_id: shop.vouchers[1], compliance_status: 'NOT_APPLICABLE', created_by: shop.ids.userId, idempotency_key: `return:${id}`, summary: 'Credit note.' });
      await insert(sql, 'return_note_lines', { return_note_id: id, company_id: shop.ids.companyId, original_line_id: 'l1', item_id: shop.itemId, description: 'Plastic crate', supply_kind: 'GOODS', quantity_micro: quantity, quantity_unit: 'PCS', disposition: 'ACCEPTED', warehouse_id: shop.warehouseId, taxable_value_paise: 10_000, total_paise: 11_800 });
    });
  };
  await note('CN/26-27/000001', 2_000_000);
  await assert.rejects(note('CN/26-27/000002', 2_000_000), refused(CHECK), 'two were already taken back of three');
  // Two notes for the last crate at the same moment: one is refused.
  const both = await Promise.allSettled([note('CN/26-27/000003', 1_000_000), note('CN/26-27/000004', 1_000_000)]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(Number((await shop.one("SELECT sum(quantity_micro) AS n FROM return_note_lines WHERE company_id = $1 AND original_line_id = 'l1'", [shop.ids.companyId])).n), 3_000_000);
});

test('#293: a price credit note never uses up what can still come back on a line', { skip }, async () => {
  const shop = await newShop();
  const bill = await shop.issueBill('INV/26-27/000001'); // 3 crates on line l1
  const note = async (number: string, quantity: number, priceCorrection: boolean) => {
    const id = crypto.randomUUID();
    await shop.run(async (sql) => {
      await insert(sql, 'return_notes', { id, company_id: shop.ids.companyId, kind: 'SALES_RETURN', number, document_date: '2026-04-12', original_document_id: bill, original_document_number: 'INV/26-27/000001', original_document_date: '2026-04-10', party_id: shop.ids.partyId, reason: priceCorrection ? 'Wrong price.' : 'Damaged.', taxable_value_paise: 3_000, total_paise: 3_540, voucher_id: shop.vouchers[1], compliance_status: 'NOT_APPLICABLE', created_by: shop.ids.userId, idempotency_key: `return:${id}`, summary: 'Credit note.', price_correction: priceCorrection });
      await insert(sql, 'return_note_lines', { return_note_id: id, company_id: shop.ids.companyId, original_line_id: 'l1', item_id: shop.itemId, description: 'Plastic crate', supply_kind: 'GOODS', quantity_micro: quantity, quantity_unit: 'PCS', disposition: 'ACCEPTED', warehouse_id: priceCorrection ? null : shop.warehouseId, taxable_value_paise: 3_000, total_paise: 3_540 });
    });
  };
  await note('CN/26-27/000001', 3_000_000, true); // price cut on all three kept crates
  await note('CN/26-27/000002', 3_000_000, true); // a second price cut on the same line
  await note('CN/26-27/000003', 1_000_000, false); // then one crate comes back
  await note('CN/26-27/000004', 2_000_000, true); // a price cut on the two still kept
  await assert.rejects(note('CN/26-27/000005', 3_000_000, true), refused(CHECK), 'a price note cannot name more than is still kept');
  await note('CN/26-27/000006', 2_000_000, false); // the last two come back
  await assert.rejects(note('CN/26-27/000007', 1_000_000, false), refused(CHECK), 'all three came back');
});

test('#293: a sales debit note raises what the bill is owed, and a price credit note on the same bill nets off', { skip }, async () => {
  const shop = await newShop();
  const priceNote = async (bill: string, kind: 'SALES_RETURN' | 'SALES_DEBIT_NOTE', total: number) => {
    const id = crypto.randomUUID();
    await shop.run(async (sql) => {
      await insert(sql, 'return_notes', { id, company_id: shop.ids.companyId, kind, number: `${kind === 'SALES_RETURN' ? 'CN' : 'DN'}/${id.slice(0, 8)}`, document_date: '2026-04-12', original_document_id: bill, original_document_number: 'INV', original_document_date: '2026-04-10', party_id: shop.ids.partyId, reason: 'Wrong price on the bill.', taxable_value_paise: total * 100 / 118, total_paise: total, voucher_id: shop.vouchers[1], compliance_status: 'NOT_APPLICABLE', created_by: shop.ids.userId, idempotency_key: `return:${id}`, summary: 'Price note.', price_correction: true });
      await insert(sql, 'return_note_lines', { return_note_id: id, company_id: shop.ids.companyId, original_line_id: 'l1', item_id: shop.itemId, description: 'Plastic crate', supply_kind: 'GOODS', quantity_micro: 3_000_000, quantity_unit: 'PCS', disposition: 'ACCEPTED', warehouse_id: null, taxable_value_paise: total * 100 / 118, total_paise: total });
    });
  };
  const pay = async (bill: string, amount: number) => {
    const paid = shop.payment(amount);
    await shop.run(async (sql) => { await insert(sql, 'payments', paid); await insert(sql, 'payment_allocations', shop.allocation(paid.id, bill, amount)); });
  };
  const settlement = (bill: string) => shop.one('SELECT status, value_paise::int AS value, allocated_paise::int AS allocated FROM document_settlements WHERE document_id = $1', [bill]);
  const owed = (bill: string) => shop.one('SELECT (value_paise - credited_paise + debited_paise)::int AS owed FROM document_settlements WHERE document_id = $1', [bill]);

  // ₹354.00 bill, then a debit note of ₹11.80: ₹365.80 is owed.
  const bill = await shop.issueBill('INV/26-27/000001');
  await priceNote(bill, 'SALES_DEBIT_NOTE', 1_180);
  assert.deepEqual(await owed(bill), { owed: 36_580 });
  await pay(bill, 35_400);
  assert.deepEqual(await settlement(bill), { status: 'PARTLY_PAID', value: 35_400, allocated: 35_400 }, 'paying the bill alone leaves the debit owed');
  await pay(bill, 1_180);
  assert.equal((await settlement(bill)).status, 'SETTLED');
  await assert.rejects(pay(bill, 1), refused(CHECK), 'no more than the bill and its debit note');
  await assert.rejects(shop.run((sql) => sql.query('UPDATE document_settlements SET debited_paise = 0 WHERE document_id = $1', [bill])), refused(NO_PRIVILEGE));

  // ₹354.00 less a ₹35.40 price credit note, plus a ₹11.80 debit note: ₹330.40 is owed.
  const second = await shop.issueBill('INV/26-27/000002');
  await priceNote(second, 'SALES_RETURN', 3_540);
  await priceNote(second, 'SALES_DEBIT_NOTE', 1_180);
  assert.deepEqual(await owed(second), { owed: 33_040 });
  await pay(second, 33_039);
  assert.equal((await settlement(second)).status, 'PARTLY_PAID');
  await pay(second, 1);
  assert.equal((await settlement(second)).status, 'SETTLED');
});

test('findings of the independent review of #365, each as a test', { skip }, async () => {
  const shop = await newShop();

  // A draft is saved as it was typed, even when it is wrong; it cannot be issued like that.
  const draft = crypto.randomUUID();
  await shop.run(async (sql) => {
    await insert(sql, 'sales_invoices', shop.billRow(draft, { due_date: '2026-04-01' }));
    await insert(sql, 'sales_invoice_lines', shop.lineRow('invoice_id', draft, { quantity_micro: -5_000_000 }));
  });
  const issue = (id: string, number: string) => (sql: SqlExecutor) => sql.query(
    `UPDATE sales_invoices SET state = 'FINAL', number = $2, financial_year = '2026-27', voucher_id = $3, finalised_by = $4, finalised_at = now(),
       pricing = '{}', line_count = 1, taxable_value_paise = 30000, cgst_paise = 2700, sgst_paise = 2700, utgst_paise = 0, igst_paise = 0, cess_paise = 0,
       total_tax_paise = 5400, reverse_charge_tax_paise = 0, round_off_paise = 0, invoice_value_paise = 35400 WHERE id = $1`, [id, number, shop.vouchers[0], shop.ids.userId]);
  await assert.rejects(shop.run(issue(draft, 'INV/26-27/000001')), refused(CHECK), 'a line of minus five is never issued');

  // The race the review reproduced: a line is changed by one connection while another issues the bill.
  // Whichever order they land in, an issued bill whose lines do not add up never exists.
  for (let round = 0; round < 5; round += 1) {
    const id = crypto.randomUUID();
    await shop.run(async (sql) => { await insert(sql, 'sales_invoices', shop.billRow(id)); await insert(sql, 'sales_invoice_lines', shop.lineRow('invoice_id', id)); });
    await Promise.allSettled([
      shop.run(async (sql) => { await issue(id, `RACE/${round}`)(sql); await sql.query('SELECT pg_sleep(0.05)'); }),
      shop.run(async (sql) => { await sql.query('UPDATE sales_invoice_lines SET taxable_value_paise = 1 WHERE invoice_id = $1', [id]); await sql.query('SELECT pg_sleep(0.05)'); }),
    ]);
    const after = await shop.one('SELECT b.state, b.taxable_value_paise::int AS header, l.taxable_value_paise::int AS line FROM sales_invoices b JOIN sales_invoice_lines l ON l.invoice_id = b.id WHERE b.id = $1', [id]);
    assert.ok(after.state === 'DRAFT' || after.header === after.line, `round ${round}: ${JSON.stringify(after)}`);
  }

  // The tax on a reverse-charge line is not in the bill's total, and the check knows it.
  const reverse = crypto.randomUUID();
  const noTax = { cgst_paise: 0, sgst_paise: 0, total_tax_paise: 0, invoice_value_paise: 30_000, reverse_charge_tax_paise: 5_400 };
  await shop.run(async (sql) => {
    await insert(sql, 'sales_invoices', shop.billRow(reverse, { ...shop.issued('INV/26-27/000002'), ...noTax }));
    await insert(sql, 'sales_invoice_lines', shop.lineRow('invoice_id', reverse, { reverse_charge: true }));
  });
  await assert.rejects(shop.run(async (sql) => {
    const id = crypto.randomUUID();
    await insert(sql, 'sales_invoices', shop.billRow(id, { ...shop.issued('INV/26-27/000003'), ...noTax }));
    await insert(sql, 'sales_invoice_lines', shop.lineRow('invoice_id', id));
  }), refused(CHECK), 'the same line without reverse charge bills tax the header does not carry');

  // A settlement row is only written for an issued bill, for its own value and customer.
  const settlement = (documentId: string, value: number) => ({ id: crypto.randomUUID(), company_id: shop.ids.companyId, document_kind: 'SALES_INVOICE', document_id: documentId, document_number: 'X', party_id: shop.ids.partyId, side: 'RECEIVABLE', document_date: '2026-04-10', value_paise: value });
  await assert.rejects(shop.run((sql) => insert(sql, 'document_settlements', settlement(draft, 35_400))), refused(FOREIGN_KEY), 'not for a draft');
  await assert.rejects(shop.run((sql) => insert(sql, 'document_settlements', settlement(reverse, 1))), refused(FOREIGN_KEY), 'not for another value');

  // A credit note takes its value off what the bill is owed: ₹354.00 less ₹118.00 is settled by ₹236.00.
  const bill = await shop.issueBill('INV/26-27/000004');
  const creditNote = (original: string, lineId: string) => shop.run(async (sql) => {
    const id = crypto.randomUUID();
    await insert(sql, 'return_notes', { id, company_id: shop.ids.companyId, kind: 'SALES_RETURN', number: `CN/${id.slice(0, 8)}`, document_date: '2026-04-12', original_document_id: original, original_document_number: 'INV/26-27/000004', original_document_date: '2026-04-10', party_id: shop.ids.partyId, reason: 'Damaged.', taxable_value_paise: 10_000, total_paise: 11_800, voucher_id: shop.vouchers[1], compliance_status: 'NOT_APPLICABLE', created_by: shop.ids.userId, idempotency_key: `return:${id}`, summary: 'Credit note.' });
    await insert(sql, 'return_note_lines', { return_note_id: id, company_id: shop.ids.companyId, original_line_id: lineId, item_id: shop.itemId, description: 'Plastic crate', supply_kind: 'GOODS', quantity_micro: 1_000_000, quantity_unit: 'PCS', disposition: 'ACCEPTED', warehouse_id: shop.warehouseId, taxable_value_paise: 10_000, total_paise: 11_800 });
  });
  await creditNote(bill, 'l1');
  const paid = shop.payment(23_600);
  await shop.run(async (sql) => { await insert(sql, 'payments', paid); await insert(sql, 'payment_allocations', shop.allocation(paid.id, bill, 23_600)); });
  assert.deepEqual(await shop.one('SELECT status, credited_paise::int AS credited FROM document_settlements WHERE document_id = $1', [bill]), { status: 'SETTLED', credited: 11_800 });
  await assert.rejects(shop.run((sql) => sql.query('UPDATE document_settlements SET credited_paise = 0 WHERE document_id = $1', [bill])), refused(NO_PRIVILEGE));
  await assert.rejects(creditNote(bill, 'no-such-line'), refused(CHECK), 'a line that is not on the bill');
  // A bill that is not in sales_invoices (made before the app moved to PostgreSQL) is left to the returns service.
  await creditNote(crypto.randomUUID(), 'l1');
  await creditNote('legacy-bill-17', 'l1');

  // Undoing imported opening stock: a reversal that names no single movement (#37).
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('OPENING', 4_000_000)));
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('REVERSAL_OUT', 4_000_000, { reason: 'Import undone.' })));
  // An empty stock may be counted in a corrected unit.
  await shop.run((sql) => insert(sql, 'stock_movements', shop.movement('PURCHASE_IN', 2_000_000, { unit_code: 'BOX', entered_unit_code: 'BOX' })));
  assert.equal((await shop.one('SELECT unit_code FROM stock_balances WHERE company_id = $1', [shop.ids.companyId])).unit_code, 'BOX');

  // An advance on services carries its tax, one row for each rate, adding up to the voucher; and a
  // second advance on the same proforma may be applied for nothing when the first covered the bill.
  const proforma = crypto.randomUUID();
  await shop.run(async (sql) => {
    await insert(sql, 'presale_documents', shop.billRow(proforma, { ...shop.PRICED, state: 'ISSUED', kind: 'PROFORMA', number: 'PI/26-27/0000009', financial_year: '2026-27', supply_kind: 'SERVICES', purpose: 'Advance for a service', idempotency_key: `presale:${proforma}` }));
    await insert(sql, 'presale_document_lines', shop.lineRow('document_id', proforma));
  });
  const advance = async (number: string, taxLines: number) => {
    const [id, money] = [crypto.randomUUID(), shop.payment(11_800)];
    await shop.run(async (sql) => {
      await insert(sql, 'payments', money);
      await insert(sql, 'advance_receipts', { id, company_id: shop.ids.companyId, number, financial_year: '2026-27', receipt_date: '2026-04-11', proforma_id: proforma, proforma_number: 'PI/26-27/0000009', party_id: shop.ids.partyId, supply_kind: 'SERVICES', place_of_supply_state_code: '07', description: 'Design work', amount_paise: 11_800, line_count: 1, taxable_value_paise: 10_000, cgst_paise: 900, sgst_paise: 900, utgst_paise: 0, igst_paise: 0, cess_paise: 0, total_tax_paise: 1_800, payment_id: money.id, recorded_by: shop.ids.userId, recorded_at: '2026-04-11T10:00:00Z', idempotency_key: `advance:${id}`, version: 0 });
      for (let n = 1; n <= taxLines; n += 1) await insert(sql, 'advance_tax_lines', { company_id: shop.ids.companyId, advance_id: id, line_no: n, rate_bp: 1800, taxable_value_paise: 10_000, cgst_paise: 900, sgst_paise: 900 });
    });
    return id;
  };
  await assert.rejects(advance('RV/26-27/00007', 0), refused(CHECK), 'the tax rows are missing');
  await assert.rejects(advance('RV/26-27/00007', 2), refused(CHECK), 'the tax rows come to twice the voucher');
  const second = await advance('RV/26-27/00008', 1);
  await shop.run((sql) => insert(sql, 'advance_applications', { company_id: shop.ids.companyId, advance_id: second, invoice_id: bill, invoice_number: 'INV/26-27/000004', invoice_date: '2026-04-10', amount_paise: 0, applied_by: shop.ids.userId, applied_at: '2026-04-12T10:00:00Z' }));
});
