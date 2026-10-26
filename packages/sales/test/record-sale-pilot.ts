/**
 * Issue #363 — "record a sale" on PostgreSQL, as one unit of work.
 *
 * The real SalesService, LedgerService, PostgresLedgerStore, PostgresAuditLog and outbox, and since
 * #366 the real bill and stock tables of #365: `PostgresSalesRepository`, and the real
 * InventoryService on `PostgresInventoryStore`. The shop's customer, item and godown are master
 * records, and the godown holds opening stock before the first sale.
 *
 * Tax master data (who is registered where) is still the in-memory fixture; it is read, never written.
 *
 * Run directly (`node record-sale-pilot.ts`), this file is the child process the crash test kills.
 */
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { fixedClock, isoDate, quantityFromString, rupees, zero as nil, type AccountId, type CompanyId, type PartyId, type UserId } from '@invoice/kernel';
import { buildDefaultChart, LedgerService, PostgresLedgerStore, permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { GstCalculator, FIXTURE_RATE_TABLE, InMemoryMasterData } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { createDefaultUnitRegistry } from '../../masters/src/units.ts';
import { turnoverAnsweredEveryYear } from '../../masters/src/fixtures.ts';
import { PostgresInventoryStore } from '../../inventory/src/postgres-store.ts';
import { salesInventoryAdapter } from '../../inventory/src/sales-adapter.ts';
import { InventoryService } from '../../inventory/src/service.ts';
import type { StockMasterData } from '../../inventory/src/ports.ts';
import { createDatabase, type TransactionalExecutor } from '../../platform/src/database.ts';
import { PostgresAuditLog } from '../../platform/src/postgres-audit.ts';
import { DEFAULT_SALES_POLICY } from '../src/policy.ts';
import type { ComplianceHookPort, InventoryPort } from '../src/ports.ts';
import { PostgresSalesRepository } from '../src/postgres-repository.ts';
import { SalesService } from '../src/service.ts';

/**
 * The stand-in tables #363 used before #365 existed. Nothing writes them any more; they are still
 * created because other test files run this, and `immutability.integration.test.ts` lists them.
 * One statement batch, so one transaction: the lock makes test files that start together take turns.
 */
export const PILOT_TABLES = `
  SELECT pg_advisory_xact_lock(363, 2);
  CREATE TABLE IF NOT EXISTS uow_pilot_sales_invoices (
    id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), idempotency_key text NOT NULL,
    number text, state text NOT NULL, version integer NOT NULL, body jsonb NOT NULL,
    UNIQUE (company_id, idempotency_key), UNIQUE (company_id, number));
  CREATE TABLE IF NOT EXISTS uow_pilot_stock_movements (
    id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), document_id uuid NOT NULL, number text,
    UNIQUE (company_id, document_id));
`;

/**
 * The same id every time for the same company, so the crash test's child process finds the shop its
 * parent set up. Not `ids.partyId`: the tests that borrow this pilot's ledger entries create a
 * master record of that id themselves.
 */
const derived = (companyId: string, what: string): string => {
  const hex = createHash('sha256').update(`pilot:${what}:${companyId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export interface PilotHooks {
  /** Runs after the ledger write, immediately before the stock write. */
  beforeStockWrite?: () => Promise<void>;
  /** Runs after everything is written, immediately before COMMIT. */
  beforeCommit?: () => Promise<void>;
}

/**
 * What a till does when the shop is too busy to save: the same request again, with the same key
 * (unit-of-work-v1, TRY_AGAIN). Anything else is the answer.
 */
export const likeATill = async <T>(send: () => Promise<T>, attempts = 5): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if ((error as { code?: string }).code !== 'TRY_AGAIN' || attempt >= attempts) throw error;
    }
  }
};

export interface PilotIds { companyId: string; userId: string; partyId: string }

export const makePilot = (db: TransactionalExecutor, ids: PilotIds, hooks: PilotHooks = {}) => {
  const companyId = ids.companyId as CompanyId;
  const actor: ActorContext = {
    companyId, branchId: null, userId: ids.userId as UserId,
    permissions: ['ledger.setup', 'ledger.post.sale', 'sales.draft.write', 'sales.finalise', 'inventory.move'],
  };
  const store = new PostgresLedgerStore(db);
  const audit = new PostgresAuditLog(db);
  const clock = fixedClock('2026-05-12T11:04:00.000Z');
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  const customerId = derived(ids.companyId, 'customer');
  const itemId = derived(ids.companyId, 'item');
  const godownId = derived(ids.companyId, 'godown');

  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR', turnoverAbove5Crore: turnoverAnsweredEveryYear('NO') });
  masterData.putParty(companyId, { partyId: customerId as PartyId, gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' });
  masterData.putItem(companyId, { itemId, name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });
  const calculator = new GstCalculator({
    masterData, rates: FIXTURE_RATE_TABLE, mode: 'development',
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
  });

  // The real stock: holds and movements in #365's tables, the balance kept by the database.
  const units = createDefaultUnitRegistry();
  const stockMasters: StockMasterData = {
    item: (_company, id) => (id === itemId ? { itemId, name: 'Plastic crate', baseUnit: 'PCS', tracksBatches: false, tracksSerials: false } : undefined),
    warehouse: (_company, id) => (id === godownId ? { warehouseId: godownId, name: 'Main godown' } : undefined),
    units: () => units,
  };
  const stock = new InventoryService({ store, inventory: new PostgresInventoryStore(db), masterData: stockMasters, permissions: permissionPortFromActor, audit, clock });
  const godown = salesInventoryAdapter(stock, { defaultWarehouseId: godownId });
  const inventory: InventoryPort = {
    ...godown,
    async issue(by, documentId, date, number) {
      await hooks.beforeStockWrite?.();
      await godown.issue(by, documentId, date, number);
    },
  };

  // The e-invoice request is queued with the bill; the relay sends it after the commit.
  const compliance: ComplianceHookPort = {
    async onInvoiceFinalised(invoice) {
      await db.requireUnitOfWork(invoice.companyId).enqueue({ topic: 'einvoice.generate', dedupeKey: invoice.id, payload: { invoiceId: invoice.id, number: invoice.number } });
      return [{ kind: 'E_INVOICE', status: 'PENDING', reference: null, message: null }];
    },
    async onInvoiceCancelled() {},
  };

  const sales = new SalesService({
    store, ledger, calculator, repository: new PostgresSalesRepository(db), inventory, compliance,
    permissions: permissionPortFromActor, audit, clock,
    policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: '' } },
  });

  const accounts = { customer: '', sales: '' };
  /** Books for a brand-new synthetic company: chart of accounts and the customer's account. Nothing else. */
  const setUpBooks = async (): Promise<void> => {
    await db.query('INSERT INTO companies (id, legal_name) VALUES ($1, $2)', [ids.companyId, 'Synthetic Pilot Traders']);
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [ids.userId, `pilot-${ids.userId}@example.invalid`, 'Synthetic clerk']);
    const accountIds = new Map<string, string>();
    const chart = buildDefaultChart(companyId, (code) => {
      if (!accountIds.has(code)) accountIds.set(code, crypto.randomUUID());
      return accountIds.get(code) as AccountId;
    });
    await ledger.initialiseCompany(actor, { booksStartDate: isoDate('2026-04-01'), accounts: chart });
    accounts.sales = chart.find((a) => a.systemRole === 'SALES_GOODS')?.id as string;
    accounts.customer = (await ledger.openPartyAccount(actor, { partyId: customerId as PartyId, name: 'Synthetic Customer', kind: 'CUSTOMER' })).id;
  };

  return {
    actor, ledger, sales, stock, customerId, itemId, godownId,
    setUpBooks,
    /** The books, the customer, the item and the godown as master records, and `crates` crates in the godown. */
    async setUp(crates = '100'): Promise<void> {
      await setUpBooks();
      await db.tenantTransaction(ids.companyId, (sql) => sql.query(
        "INSERT INTO master_records (id, company_id, kind) VALUES ($1, $4, 'party'), ($2, $4, 'item'), ($3, $4, 'warehouse')",
        [customerId, itemId, godownId, ids.companyId],
      ));
      await stock.recordMovement(actor, {
        idempotencyKey: 'pilot:opening', itemId, warehouseId: godownId, kind: 'OPENING', quantity: quantityFromString(crates, 'PCS'),
        unitCost: rupees(200), documentDate: isoDate('2026-04-01'), source: { kind: 'opening_stock', id: 'pilot', number: null },
      });
    },
    /** A posted entry in the books (₹354 sold to the customer), for tests that only need one to point at. */
    async postEntry(key: string): Promise<{ voucherId: string }> {
      const posted = await ledger.postVoucher(actor, {
        idempotencyKey: `pilot-entry:${key}`, type: 'SALE', date: isoDate('2026-04-10'),
        lines: [
          { accountId: accounts.customer as AccountId, partyId: customerId as PartyId, debit: rupees(354), credit: nil() },
          { accountId: accounts.sales as AccountId, debit: nil(), credit: rupees(354) },
        ],
      });
      return { voucherId: posted.voucher.id };
    },
    /** One business action: the bill is started and issued in a single unit of work. */
    recordSale(requestId: string, crates = '3') {
      return db.unitOfWork(companyId, async () => {
        const draft = await sales.createDraft(actor, {
          idempotencyKey: `sale:${requestId}`,
          input: {
            partyId: customerId as PartyId, customerType: 'B2B', supplyKind: 'GOODS', documentDate: isoDate('2026-04-10'),
            lines: [{ lineId: 'l1', itemId, quantity: quantityFromString(crates, 'PCS'), unitPrice: rupees(333, 33), priceBasis: 'EXCLUSIVE' }],
          },
        });
        const result = await sales.finalise(actor, { idempotencyKey: `sale-final:${requestId}`, invoiceId: draft.id });
        await hooks.beforeCommit?.();
        return result;
      });
    },
  };
};

/** What one company has in the database, counted by a fresh query on whatever connection `db` gives. */
export const persisted = async (db: TransactionalExecutor, companyId: string) => {
  const count = async (table: string, where = 'true'): Promise<number> =>
    Number((await db.tenantTransaction(companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1 AND ${where}`, [companyId]))).rows[0]?.n);
  return {
    bills: await count('sales_invoices'),
    vouchers: await count('voucher'),
    journalLines: await count('journal_line'),
    // What sales moved: the opening stock the shop was set up with is not a sale's.
    stockMovements: await count('stock_movements', "kind = 'SALE_OUT'"),
    idempotencyKeys: await count('idempotency_record'),
    auditRows: await count('audit_events'),
    outboxRows: await count('outbox_messages'),
    sequences: await count('ledger_sequence'),
  };
};

// The child process of the crash test: records one sale and is killed part-way through.
if (process.argv[1]?.endsWith('record-sale-pilot.ts')) {
  const [companyId, userId, partyId, crashAt, requestId] = process.argv.slice(2) as [string, string, string, string, string];
  const db = createDatabase(process.env.DATABASE_URL);
  const die = async (): Promise<void> => {
    // Say what this transaction has written so far, then die the way a server does when it is killed:
    // no rollback sent, no finally blocks, no clean shutdown.
    writeSync(1, `${JSON.stringify(await persisted(db, companyId))}\n`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  };
  await makePilot(db, { companyId, userId, partyId }, crashAt === 'before-stock' ? { beforeStockWrite: die } : { beforeCommit: die }).recordSale(requestId);
  throw new Error('the child was meant to be killed before it could finish');
}
