/**
 * Issue #366 — the sales repository contract on a real PostgreSQL, connected as the application's
 * own role (a login that is only a member of `invoice_app`), so row-level security and the
 * database's rules are really in force. The owner connection only sets the scene.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { CompanyId, PartyId, UserId, VoucherId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { draftBill, salesRepositoryContract, type SalesHarness, type SalesShop } from './sales-repository-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the sales repository database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: SalesHarness;
let pilot: typeof import('./record-sale-pilot.ts');
const login = `invoice_app_sales_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresChallanRepository, PostgresPreSaleRepository, PostgresSalesRepository } = await import('../src/postgres-repository.ts');
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
  harness = {
    sales: new PostgresSalesRepository(app),
    presale: new PostgresPreSaleRepository(app),
    challans: new PostgresChallanRepository(app),
    writesNeedUnitOfWork: true,
    unit: (companyId, work) => app.unitOfWork(companyId, () => work()),
    // Books with two posted entries (from the pilot), and master records for the customer, two items and a godown.
    shop: async (): Promise<SalesShop> => {
      const ids = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
      const shop = pilot.makePilot(app, ids);
      await shop.setUpBooks();
      const vouchers = [(await shop.postEntry('a')).voucherId, (await shop.postEntry('b')).voucherId] as [VoucherId, VoucherId];
      const itemIds: [string, string] = [crypto.randomUUID(), crypto.randomUUID()];
      const warehouseId = crypto.randomUUID();
      await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $5, 'party'), ($2, $5, 'item'), ($3, $5, 'item'), ($4, $5, 'warehouse')",
        [shop.customerId, ...itemIds, warehouseId, ids.companyId]);
      return { companyId: ids.companyId as CompanyId, userId: ids.userId as UserId, partyId: shop.customerId as PartyId, itemIds, warehouseId, vouchers };
    },
    settlement: async (companyId, invoiceId) => {
      const row = (await app.tenantTransaction(companyId, (sql) => sql.query(
        "SELECT value_paise, cancelled, party_id FROM document_settlements WHERE company_id = $1 AND document_kind = 'SALES_INVOICE' AND document_id = $2", [companyId, invoiceId],
      ))).rows[0];
      return row === undefined ? null : { value: BigInt(String(row.value_paise)), cancelled: Boolean(row.cancelled), party: String(row.party_id) };
    },
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

salesRepositoryContract('postgres', () => harness, skip);

test('postgres: a bill the real sales service issued reads back field for field', { skip }, async () => {
  const ids = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
  const shop = pilot.makePilot(app, ids);
  await shop.setUp();
  const sale = await shop.recordSale('r1');
  assert.equal(sale.invoice.state, 'FINAL');
  assert.deepEqual(await harness.sales.findById(ids.companyId as CompanyId, sale.invoice.id), sale.invoice);
  // Its own shop is stored as no branch at all, and the bill's lines and charges add up in the table.
  const row = (await owner.query('SELECT branch_id, line_count, invoice_value_paise::text AS value FROM sales_invoices WHERE id = $1', [sale.invoice.id])).rows[0];
  assert.deepEqual(row, { branch_id: null, line_count: sale.invoice.pricing?.lines.length, value: sale.invoice.pricing?.totals.invoiceValue.minor.toString() });
});

test('postgres: a bill of a real branch keeps its branch', { skip }, async () => {
  const shop = await harness.shop();
  const branchId = crypto.randomUUID();
  await owner.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Synthetic branch')", [branchId, shop.companyId]);
  const bill = draftBill(shop, { branchId: branchId as never });
  await harness.unit(shop.companyId, () => harness.sales.insert(bill));
  assert.deepEqual(await harness.sales.findById(shop.companyId, bill.id), bill);
});
