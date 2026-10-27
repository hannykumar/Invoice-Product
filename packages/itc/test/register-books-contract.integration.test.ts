/**
 * Issue #366 — the purchase comparison's view of our books on a real PostgreSQL.
 *
 *  - The books contract (register-books-contract.ts) with posted bills in `purchase_bills`, read as
 *    the application role, so forced row-level security is really in force.
 *  - The whole comparison — import, workspace, decisions, claims — on PostgreSQL gives the same
 *    month as the in-memory books do, and a bill the portal does not carry is still never credit.
 *  - Restart survival: a second pool (a new process) sees the first one's imports, decisions,
 *    claims and bills. Two service instances at once see each other's data.
 *  - A GSTR-2B outage leaves the books readable, and the held-back answer stands.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { asId, fixedClock, type CompanyId, type UserId } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { billFor, type Scene } from '../../purchasing/test/purchasing-contract.ts';
import type { PurchaseBill } from '../../purchasing/src/posting-types.ts';
import { InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks, SyntheticPortalSource } from '../src/adapters.ts';
import { SUNRISE_BOOKS, SUNRISE_GSTIN, SUNRISE_GSTR2B_FILE, SUNRISE_PERIOD } from '../src/fixtures.ts';
import { RegisterPurchaseBooks } from '../src/register-books.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { ITC_PERMISSIONS, type BookPurchaseDocument } from '../src/types.ts';
import { registerBooksContract, type BooksHarness } from './register-books-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the ITC books database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';
const login = `invoice_app_itcbooks_${randomBytes(6).toString('hex')}`;

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let appUrl: string;
let harness: BooksHarness;
let pg: typeof import('../src/postgres-repository.ts');
let purchasing: typeof import('../../purchasing/src/postgres-repositories.ts');

const scene = async (): Promise<Scene> => {
  const s = { companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID(), partyId: crypto.randomUUID(), itemId: crypto.randomUUID(), warehouseId: crypto.randomUUID(), batchId: crypto.randomUUID() };
  await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Books Traders')", [s.companyId]);
  await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic accountant')", [s.userId, `itcbooks-${s.userId}@example.invalid`]);
  await owner.query(
    "INSERT INTO master_records (id, company_id, kind) VALUES ($1, $5, 'party'), ($2, $5, 'item'), ($3, $5, 'warehouse'), ($4, $5, 'batch')",
    [s.partyId, s.itemId, s.warehouseId, s.batchId, s.companyId]);
  return s;
};

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  pg = await import('../src/postgres-repository.ts');
  purchasing = await import('../../purchasing/src/postgres-repositories.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const u = new URL(url);
  u.username = login;
  u.password = password;
  appUrl = u.toString();
  app = createDatabase(appUrl);
  harness = { bills: new purchasing.PostgresPurchaseBillRepository(app), scene, write: (companyId, work) => app.unitOfWork(companyId, () => work()) };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

registerBooksContract('postgres as the application role', () => harness, skip);

/** The Sunrise fixture's invoices as posted bills of one company, supplier by supplier. */
const SUNRISE_INVOICES = SUNRISE_BOOKS.filter((book) => book.kind === 'INVOICE');
const postedBills = (s: Scene, parties: Map<string, string>): PurchaseBill[] => SUNRISE_INVOICES.map((book, index) => {
  const template = billFor(s, index + 1);
  const party = parties.get(book.supplierGstin as string) as string;
  const blocked = book.ineligibleItc.minor;
  return {
    ...template,
    supplierPartyId: party,
    supplierName: book.supplierName,
    invoiceNumber: book.number,
    invoiceDate: book.documentDate,
    totalPaise: book.invoiceValue.minor,
    tax: {
      taxableValuePaise: book.amounts.taxableValue.minor,
      // What the portal shows is claimable plus blocked; a blocked bill is stored with its heads apart.
      cgstPaise: book.amounts.cgst.minor - blocked / 2n, sgstPaise: book.amounts.sgst.minor - blocked / 2n,
      igstPaise: book.amounts.igst.minor, cessPaise: 0n, ineligibleItcPaise: blocked,
      ...(blocked === 0n ? {} : { ineligibleHeads: { cgstPaise: blocked / 2n, sgstPaise: blocked / 2n, igstPaise: 0n, cessPaise: 0n } }),
      intraState: book.amounts.igst.minor === 0n, reverseCharge: false,
    },
  };
});

const lineSummary = (lines: readonly { book: BookPurchaseDocument | null; portal: { supplierGstin: string; number: string } | null; outcome: string; claimable: { cgst: { minor: bigint }; sgst: { minor: bigint }; igst: { minor: bigint } } }[]) =>
  lines.map((line) => {
    const side = line.book ?? line.portal as { supplierGstin: string | null; number: string };
    return `${side.supplierGstin}|${side.number}|${line.outcome}|${line.claimable.cgst.minor}/${line.claimable.sgst.minor}/${line.claimable.igst.minor}`;
  }).sort();

const gstins = [...new Set(SUNRISE_INVOICES.map((book) => book.supplierGstin as string))];

test('the comparison reads the same month from PostgreSQL bills as from the in-memory books, and an unfiled bill is never credit', { skip }, async () => {
  const s = await scene();
  const actor: ActorContext = { companyId: s.companyId, branchId: asId<'Branch'>('main'), userId: s.userId as UserId, permissions: Object.values(ITC_PERMISSIONS) };
  const parties = new Map<string, string>();
  for (const gstin of gstins) {
    const id = crypto.randomUUID();
    await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, 'party')", [id, s.companyId]);
    parties.set(gstin, id);
  }
  const bills = postedBills(s, parties);
  await app.unitOfWork(s.companyId, async () => { for (const bill of bills) await harness.bills.insert(bill); });
  const gstinOfParty = new Map([...parties].map(([gstin, id]) => [id, gstin]));

  const service = (db: TransactionalExecutor, books: RegisterPurchaseBooks | InMemoryPurchaseBooks, stores: object) => new ItcReconciliationService({
    ...(stores as ConstructorParameters<typeof ItcReconciliationService>[0]), books, audit: new InMemoryAuditPort(), clock: fixedClock('2026-08-14T10:00:00.000Z'), idFactory: () => crypto.randomUUID(),
  });
  const pgStores = (db: TransactionalExecutor) => ({ records: new pg.PostgresPortalRecords(db), batches: new pg.PostgresImportBatches(db), decisions: new pg.PostgresItcDecisions(db), claims: new pg.PostgresItcClaims(db) });
  const booksOver = (db: TransactionalExecutor) => new RegisterPurchaseBooks({
    bills: new purchasing.PostgresPurchaseBillRepository(db),
    returns: { list: async () => [] },
    suppliers: { gstinOf: (_c, party) => gstinOfParty.get(party) ?? null, registrationOf: () => 'regular' },
  });

  // The reference month: the same bills as in-memory books, the same file, in-memory stores.
  const reference = new InMemoryPurchaseBooks();
  reference.add(...SUNRISE_INVOICES.map((book) => ({ ...book, companyId: s.companyId })));
  const memory = service(app, reference, { records: new InMemoryPortalRecords(), batches: new InMemoryImportBatches(), decisions: new InMemoryItcDecisions(), claims: new InMemoryItcClaims() });
  await memory.importFile(actor, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE, fileName: 'GSTR2B_072026.json' });
  const expected = lineSummary((await memory.workspace(actor, SUNRISE_PERIOD)).lines);

  const first = service(app, booksOver(app), pgStores(app));
  await app.unitOfWork(s.companyId, () => first.importFile(actor, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE, fileName: 'GSTR2B_072026.json' }));
  const opened = await first.workspace(actor, SUNRISE_PERIOD);
  assert.deepEqual(lineSummary(opened.lines), expected);

  // The invariant: Deccan Chemicals has not filed, so its bill is held back and claims nothing.
  const paint = opened.lines.find((line) => line.book?.number === 'DC-556');
  assert.ok(paint !== undefined);
  assert.notEqual(paint.outcome, 'CLAIM_NOW');
  assert.equal(paint.claimable.cgst.minor + paint.claimable.sgst.minor + paint.claimable.igst.minor, 0n);
  // And the blocked car credit is not credit, though the portal carries it.
  const car = opened.lines.find((line) => line.book?.number === 'NM-771');
  assert.ok(car !== undefined);
  assert.equal(car.claimable.cgst.minor + car.claimable.sgst.minor, 0n);

  // Two instances at once, and a process that starts afterwards, see one month.
  const decideInput = { period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'PENDING' as const, reason: 'Waiting on the supplier to file.', idempotencyKey: 'pending-books-1' };
  const second = service(app, booksOver(app), pgStores(app));
  await app.unitOfWork(s.companyId, () => first.decide(actor, decideInput));
  const [fromSecond, claimsA, claimsB] = [
    await second.workspace(actor, SUNRISE_PERIOD),
    ...await Promise.all([
      app.unitOfWork(s.companyId, () => first.claimPeriod(actor, SUNRISE_PERIOD)),
      app.unitOfWork(s.companyId, () => second.claimPeriod(actor, SUNRISE_PERIOD)).catch(() => []),
    ]),
  ];
  assert.equal(fromSecond.lines.find((line) => line.key === paint.key)?.decision?.kind, 'PENDING', 'a decision made by one instance is seen by the other');
  assert.ok(claimsA.length > 0);
  assert.deepEqual(claimsB, claimsA, 'two instances claiming at once get the same claims');

  const { createDatabase } = await import('../../platform/src/database.ts');
  const restarted = createDatabase(appUrl);
  try {
    const after = service(restarted, booksOver(restarted), pgStores(restarted));
    const reopened = await after.workspace(actor, SUNRISE_PERIOD);
    assert.deepEqual(lineSummary(reopened.lines), lineSummary((await first.workspace(actor, SUNRISE_PERIOD)).lines), 'the same month after a restart');
    assert.equal(reopened.lines.find((line) => line.key === paint.key)?.decision?.kind, 'PENDING');
    assert.equal((await after.imports(actor, SUNRISE_PERIOD)).length, 1);
    // Claiming again after the restart claims nothing twice.
    const again = await restarted.unitOfWork(s.companyId, () => after.claimPeriod(actor, SUNRISE_PERIOD));
    assert.deepEqual(again, claimsA, 'each bill is claimed once, whichever instance claims');
    const stored = await owner.query('SELECT count(*)::int AS n FROM itc_claims WHERE company_id = $1', [s.companyId]);
    assert.equal(stored.rows[0]?.n, claimsA.length);
  } finally {
    await restarted.close();
  }

  // Another company in the same database sees none of it.
  const other = await scene();
  const otherActor: ActorContext = { ...actor, companyId: other.companyId, userId: other.userId as UserId };
  const stranger = service(app, new RegisterPurchaseBooks({ bills: new purchasing.PostgresPurchaseBillRepository(app), returns: { list: async () => [] }, suppliers: { gstinOf: () => null, registrationOf: () => null } }), pgStores(app));
  assert.deepEqual((await stranger.workspace(otherActor, SUNRISE_PERIOD)).lines, []);
});

test('with the government statement unavailable, the books are readable and nothing is claimable', { skip }, async () => {
  const s = await scene();
  const actor: ActorContext = { companyId: s.companyId, branchId: asId<'Branch'>('main'), userId: s.userId as UserId, permissions: Object.values(ITC_PERMISSIONS) };
  await app.unitOfWork(s.companyId, () => harness.bills.insert(billFor(s, 1)));
  const service = new ItcReconciliationService({
    records: new pg.PostgresPortalRecords(app), batches: new pg.PostgresImportBatches(app), decisions: new pg.PostgresItcDecisions(app), claims: new pg.PostgresItcClaims(app),
    books: new RegisterPurchaseBooks({
      bills: new purchasing.PostgresPurchaseBillRepository(app), returns: { list: async () => [] },
      suppliers: { gstinOf: () => 'SYNTHETIC', registrationOf: () => 'regular' },
    }),
    portal: new SyntheticPortalSource({ outcome: { kind: 'UNAVAILABLE', retryable: true, at: '2026-08-14T10:00:00.000Z', detail: 'The gateway timed out.' } }),
    audit: new InMemoryAuditPort(), clock: fixedClock('2026-08-14T10:00:00.000Z'), idFactory: () => crypto.randomUUID(),
  });
  await assert.rejects(app.unitOfWork(s.companyId, () => service.fetchFromPortal(actor, { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN })), (error: unknown) => (error as { code?: string }).code === 'ITC_PORTAL_UNAVAILABLE');
  const opened = await service.workspace(actor, SUNRISE_PERIOD);
  assert.equal(opened.lines.length, 1, 'the bill is still in the workspace');
  assert.ok(opened.lines.every((line) => line.outcome !== 'CLAIM_NOW'), 'a bill the portal does not carry is never credit');
  assert.deepEqual(await app.unitOfWork(s.companyId, () => service.claimPeriod(actor, SUNRISE_PERIOD)), []);
});
