/**
 * Issue #363 — "record a sale" on PostgreSQL, as one unit of work.
 *
 * The real SalesService, LedgerService, PostgresLedgerStore, PostgresAuditLog and outbox. Two things
 * stand in for what does not exist yet:
 *
 *  - the bill and stock-movement tables belong to #365, so `uow_pilot_sales_invoices` and
 *    `uow_pilot_stock_movements` stand in for them behind the real `SalesRepository` and
 *    `InventoryPort`. #365 replaces these two classes; the assertions in the test must keep passing.
 *  - tax master data (who is registered where) is the in-memory fixture; it is read, never written.
 *
 * Run directly (`node record-sale-pilot.ts`), this file is the child process the crash test kills.
 */
import { writeSync } from 'node:fs';
import { conflict, fixedClock, isoDate, notFound, quantityFromString, rupees, type AccountId, type CompanyId, type PartyId, type UserId } from '@invoice/kernel';
import { buildDefaultChart, LedgerService, PostgresLedgerStore, permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { GstCalculator, FIXTURE_RATE_TABLE, InMemoryMasterData } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { turnoverAnsweredEveryYear } from '../../masters/src/fixtures.ts';
import { createDatabase, type TransactionalExecutor } from '../../platform/src/database.ts';
import { PostgresAuditLog } from '../../platform/src/postgres-audit.ts';
import type { SalesInvoice } from '../src/model.ts';
import { DEFAULT_SALES_POLICY } from '../src/policy.ts';
import type { ComplianceHookPort, InventoryPort, SalesRepository } from '../src/ports.ts';
import { SalesService } from '../src/service.ts';

/** One statement batch, so one transaction: the lock makes test files that start together take turns creating the tables. */
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

const encode = (invoice: SalesInvoice): string => JSON.stringify(invoice, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
const decode = (body: unknown): SalesInvoice =>
  JSON.parse(JSON.stringify(body), (_k, v: unknown) => (v !== null && typeof v === 'object' && '$bigint' in v ? BigInt((v as { $bigint: string }).$bigint) : v)) as SalesInvoice;

/** Stand-in for #365's sales repository: writes require the open unit of work, reads join it. */
class PilotSalesRepository implements SalesRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }
  async #one(companyId: CompanyId, where: string, value: string): Promise<SalesInvoice | null> {
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(`SELECT body FROM uow_pilot_sales_invoices WHERE company_id = $1 AND ${where} = $2`, [companyId, value]));
    return rows[0] === undefined ? null : decode(rows[0].body);
  }
  findById(companyId: CompanyId, id: string) { return this.#one(companyId, 'id', id); }
  findByNumber(companyId: CompanyId, number: string) { return this.#one(companyId, 'number', number); }
  findByIdempotencyKey(companyId: CompanyId, key: string) { return this.#one(companyId, 'idempotency_key', key); }
  async insert(invoice: SalesInvoice): Promise<void> {
    try {
      await this.#db.requireUnitOfWork(invoice.companyId).sql.query(
        'INSERT INTO uow_pilot_sales_invoices (id, company_id, idempotency_key, number, state, version, body) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [invoice.id, invoice.companyId, invoice.idempotencyKey, invoice.number, invoice.state, invoice.version, encode(invoice)],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('SALES_DUPLICATE_INVOICE', 'This bill was already started.');
      throw error;
    }
  }
  async update(invoice: SalesInvoice, expectedVersion: number): Promise<void> {
    const { rows } = await this.#db.requireUnitOfWork(invoice.companyId).sql.query(
      'UPDATE uow_pilot_sales_invoices SET number = $4, state = $5, version = $6, body = $7::jsonb WHERE company_id = $1 AND id = $2 AND version = $3 RETURNING id',
      [invoice.companyId, invoice.id, expectedVersion, invoice.number, invoice.state, invoice.version, encode(invoice)],
    );
    if (rows.length === 0) {
      if ((await this.findById(invoice.companyId, invoice.id)) === null) throw notFound('SALES_INVOICE_NOT_FOUND', 'That bill does not exist in this business.');
      throw conflict('SALES_CONCURRENT_EDIT', 'Someone else changed this bill while you were working on it. Open it again to see their changes.');
    }
  }
  async remove(companyId: CompanyId, id: string): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query("DELETE FROM uow_pilot_sales_invoices WHERE company_id = $1 AND id = $2 AND state = 'DRAFT'", [companyId, id]);
  }
  async list(companyId: CompanyId): Promise<SalesInvoice[]> {
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query('SELECT body FROM uow_pilot_sales_invoices WHERE company_id = $1', [companyId]));
    return rows.map((r) => decode(r.body));
  }
}

export interface PilotHooks {
  /** Runs after the ledger write, immediately before the stock write. */
  beforeStockWrite?: () => Promise<void>;
  /** Runs after everything is written, immediately before COMMIT. */
  beforeCommit?: () => Promise<void>;
}

export interface PilotIds { companyId: string; userId: string; partyId: string }

export const makePilot = (db: TransactionalExecutor, ids: PilotIds, hooks: PilotHooks = {}) => {
  const companyId = ids.companyId as CompanyId;
  const actor: ActorContext = {
    companyId, branchId: null, userId: ids.userId as UserId,
    permissions: ['ledger.setup', 'ledger.post.sale', 'sales.draft.write', 'sales.finalise'],
  };
  const store = new PostgresLedgerStore(db);
  const audit = new PostgresAuditLog(db);
  const clock = fixedClock('2026-05-12T11:04:00.000Z');
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });

  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR', turnoverAbove5Crore: turnoverAnsweredEveryYear('NO') });
  masterData.putParty(companyId, { partyId: ids.partyId as PartyId, gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' });
  masterData.putItem(companyId, { itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });
  const calculator = new GstCalculator({
    masterData, rates: FIXTURE_RATE_TABLE, mode: 'development',
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
  });

  // Stand-in for #365's stock movements: the goods leave the godown in the bill's transaction.
  const inventory: InventoryPort = {
    async reserve(_actor, request) { return { ok: true, reservationId: `pilot:${request.documentId}` }; },
    async release() {},
    async issue(by, documentId, _date, number) {
      await hooks.beforeStockWrite?.();
      await db.requireUnitOfWork(by.companyId).sql.query(
        'INSERT INTO uow_pilot_stock_movements (id, company_id, document_id, number) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, document_id) DO NOTHING',
        [crypto.randomUUID(), by.companyId, documentId, number],
      );
    },
    async returnToStock() {},
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
    store, ledger, calculator, repository: new PilotSalesRepository(db), inventory, compliance,
    permissions: permissionPortFromActor, audit, clock,
    policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: '' } },
  });

  return {
    actor, ledger, sales,
    /** Books for a brand-new synthetic company: chart of accounts and the customer's account. */
    async setUp(): Promise<void> {
      await db.query('INSERT INTO companies (id, legal_name) VALUES ($1, $2)', [ids.companyId, 'Synthetic Pilot Traders']);
      await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [ids.userId, `pilot-${ids.userId}@example.invalid`, 'Synthetic clerk']);
      const accountIds = new Map<string, string>();
      const chart = buildDefaultChart(companyId, (code) => {
        if (!accountIds.has(code)) accountIds.set(code, crypto.randomUUID());
        return accountIds.get(code) as AccountId;
      });
      await ledger.initialiseCompany(actor, { booksStartDate: isoDate('2026-04-01'), accounts: chart });
      await ledger.openPartyAccount(actor, { partyId: ids.partyId as PartyId, name: 'Synthetic Customer', kind: 'CUSTOMER' });
    },
    /** One business action: the bill is started and issued in a single unit of work. */
    recordSale(requestId: string) {
      return db.unitOfWork(companyId, async () => {
        const draft = await sales.createDraft(actor, {
          idempotencyKey: `sale:${requestId}`,
          input: {
            partyId: ids.partyId as PartyId, customerType: 'B2B', supplyKind: 'GOODS', documentDate: isoDate('2026-04-10'),
            lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: quantityFromString('3', 'PCS'), unitPrice: rupees(333, 33), priceBasis: 'EXCLUSIVE' }],
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
  const count = async (table: string): Promise<number> =>
    Number((await db.tenantTransaction(companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId]))).rows[0]?.n);
  return {
    bills: await count('uow_pilot_sales_invoices'),
    vouchers: await count('voucher'),
    journalLines: await count('journal_line'),
    stockMovements: await count('uow_pilot_stock_movements'),
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
