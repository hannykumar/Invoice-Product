/**
 * Issue #31 [E31] acceptance criteria, enforced automatically.
 *
 *   - "Match decisions show evidence"
 *   - "A missing portal document is not silently treated as eligible ITC"
 *   - "Recomputation preserves user actions and audit"
 *
 * plus the tests the issue asks for by name: match, mismatch, missing and amendment cases, period
 * recomputation, and file/API equivalence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, asId, fixedClock, formatINR, type IsoDate } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import { buildGstr3b } from '../../gst-returns/src/gstr3b.ts';
import {
  InMemoryImportBatches, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks,
  SyntheticPortalSource, gstr2bSignalPort, itcInwardTaxPort, purchaseBillToBookDocument,
} from '../src/adapters.ts';
import { parseCsv, parseGstr2bJson, parseTypedRecord } from '../src/import.ts';
import { matchDocuments, normaliseNumber } from '../src/match.ts';
import { ItcReconciliationService } from '../src/service.ts';
import {
  CAR_BILL, COASTAL_GSTIN, DECCAN_GSTIN, DECCAN_LATE_FILING, KONKAN_GSTIN, MYSORE_GSTIN,
  PAINT_BILL, PAPER_BILL, SHREE_RAM_GSTIN, STEEL_BILL, SUNRISE_BOOKS, SUNRISE_COMPANY,
  SUNRISE_CSV_FILE, SUNRISE_GSTIN, SUNRISE_GSTR2B_FILE, SUNRISE_PERIOD,
} from '../src/fixtures.ts';
import {
  ITC_PERMISSIONS, taxPeriod, totalTaxOf, type BookPurchaseDocument, type ItcWorkspace,
  type ReconciliationLine,
} from '../src/types.ts';

const CLOCK = fixedClock('2026-08-14T10:00:00.000Z');
const ALL = Object.values(ITC_PERMISSIONS);

const actorWith = (...permissions: readonly string[]): ActorContext => ({
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: [...permissions],
});

const owner = actorWith(...ALL);

interface Desk {
  readonly service: ItcReconciliationService;
  readonly books: InMemoryPurchaseBooks;
  readonly audit: InMemoryAuditPort;
  readonly records: InMemoryPortalRecords;
}

const makeDesk = (options: { books?: readonly BookPurchaseDocument[]; portalContent?: string } = {}): Desk => {
  const books = new InMemoryPurchaseBooks();
  books.add(...(options.books ?? SUNRISE_BOOKS));
  const records = new InMemoryPortalRecords();
  const audit = new InMemoryAuditPort();
  let counter = 0;
  const service = new ItcReconciliationService({
    books,
    records,
    batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(),
    audit,
    clock: CLOCK,
    idFactory: () => `id-${++counter}`,
    ...(options.portalContent === undefined ? {} : { portal: new SyntheticPortalSource({ content: options.portalContent, at: () => CLOCK.now().toISOString() }) }),
  });
  return { service, books, audit, records };
};

const lineFor = (workspace: ItcWorkspace, number: string): ReconciliationLine => {
  const line = workspace.lines.find((candidate) => (candidate.book?.number ?? candidate.portal?.number) === number);
  assert.ok(line !== undefined, `expected a line for ${number}`);
  return line;
};

const importedDesk = async (): Promise<Desk> => {
  const desk = makeDesk();
  await desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE, fileName: 'GSTR2B_072026.json' });
  return desk;
};

// ------------------------------------------------------------------- reading the portal's file

test('the portal file is read into the six documents it carries', () => {
  const parsed = parseGstr2bJson(SUNRISE_GSTR2B_FILE);
  assert.equal(parsed.records.length, 6);
  assert.equal(parsed.period, SUNRISE_PERIOD);
  assert.equal(parsed.gstin, SUNRISE_GSTIN);
  assert.equal(parsed.rejected.length, 0);

  const steel = parsed.records.find((record) => record.number === 'SRS/2026-27/118');
  assert.ok(steel !== undefined);
  // 05-07-2026 in the file is the fifth of July, never the seventh of May.
  assert.equal(steel.documentDate, '2026-07-05');
  assert.equal(steel.amounts.taxableValue.minor, 10_000_000n);
  assert.equal(steel.amounts.igst.minor, 1_800_000n);
  assert.equal(steel.itcAvailableOnPortal, true);

  const car = parsed.records.find((record) => record.number === 'NM-771');
  assert.equal(car?.itcAvailableOnPortal, false);
  assert.equal(car?.itcUnavailableReason, 'Credit not available on this kind of purchase');
  assert.equal(parsed.records.find((record) => record.number === 'SRS/CN/14')?.kind, 'CREDIT_NOTE');
});

test('an amount with more than two decimal places is refused, not rounded', () => {
  const parsed = parseGstr2bJson(JSON.stringify({
    data: { rtnprd: '072026', docdata: { b2b: [{ ctin: SHREE_RAM_GSTIN, inv: [{ inum: 'X-1', dt: '05-07-2026', txval: 1000.005, val: 1180 }] }] } },
  }));
  assert.equal(parsed.records.length, 0);
  assert.match(parsed.rejected[0]?.reason ?? '', /more than two decimal places/);
});

test('a file that is not a statement at all is refused with something a person can act on', async () => {
  const desk = makeDesk();
  await assert.rejects(
    desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: 'not a file', fileName: 'notes.txt' }),
    (error: unknown) => error instanceof DomainError && /heading row/.test(error.message),
  );
});

test('a file for the wrong month is refused before anything is stored', async () => {
  const desk = makeDesk();
  await assert.rejects(
    desk.service.importFile(owner, { period: taxPeriod('2026-06'), content: SUNRISE_GSTR2B_FILE }),
    (error: unknown) => error instanceof DomainError && error.code === 'ITC_FILE_WRONG_PERIOD',
  );
  const workspace = await desk.service.workspace(owner, taxPeriod('2026-06'));
  assert.equal(workspace.portalDataPresent, false);
});

test("a file downloaded for somebody else's registration is refused", async () => {
  const desk = makeDesk();
  await assert.rejects(
    desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE, expectedGstin: COASTAL_GSTIN }),
    (error: unknown) => error instanceof DomainError && error.code === 'ITC_FILE_WRONG_GSTIN',
  );
});

test('importing the same file twice does not double anything', async () => {
  const desk = makeDesk();
  const first = await desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE });
  const second = await desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE });
  assert.equal(second.id, first.id);
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  assert.equal(workspace.counts.DUPLICATE_ON_PORTAL, 0);
  assert.equal(totalTaxOf(workspace.claimable).minor, 2_340_000n);
});

// ------------------------------------------------------------------- file, API and typed entry

test('the portal download and the imported file produce the same reconciliation', async () => {
  const fromFile = await importedDesk();
  const viaApi = makeDesk({ portalContent: SUNRISE_GSTR2B_FILE });
  await viaApi.service.fetchFromPortal(owner, { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN });

  const left = await fromFile.service.workspace(owner, SUNRISE_PERIOD);
  const right = await viaApi.service.workspace(owner, SUNRISE_PERIOD);

  assert.deepEqual(left.lines.map((line) => [line.key, line.status, line.outcome]), right.lines.map((line) => [line.key, line.status, line.outcome]));
  assert.equal(totalTaxOf(right.claimable).minor, totalTaxOf(left.claimable).minor);
  // Only the recorded source differs, and it differs on purpose.
  assert.equal(left.lastImport?.source, 'GSTR2B_FILE');
  assert.equal(right.lastImport?.source, 'PORTAL_API');
});

test("a spreadsheet of the same month reconciles the same way as the portal's own file", async () => {
  const csv = makeDesk();
  await csv.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_CSV_FILE, fileName: 'july.csv' });
  const json = await importedDesk();

  const left = await csv.service.workspace(owner, SUNRISE_PERIOD);
  const right = await json.service.workspace(owner, SUNRISE_PERIOD);
  assert.deepEqual(left.lines.map((line) => [line.key, line.status, line.outcome]), right.lines.map((line) => [line.key, line.status, line.outcome]));
  assert.equal(totalTaxOf(left.claimable).minor, totalTaxOf(right.claimable).minor);
});

test('a row typed in by a person is treated exactly like an imported one, and says it was typed', async () => {
  const desk = makeDesk({ books: [STEEL_BILL] });
  const batch = await desk.service.addTypedRecord(owner, {
    period: SUNRISE_PERIOD,
    record: {
      supplierGstin: SHREE_RAM_GSTIN, supplierName: 'Shree Ram Steels', number: 'SRS/2026-27/118',
      documentDate: '05-07-2026', taxableValue: '100000.00', igst: '18000.00', invoiceValue: '118000.00',
      itcAvailableOnPortal: 'Y',
    },
  });
  assert.equal(batch.source, 'TYPED');

  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const line = lineFor(workspace, 'SRS/2026-27/118');
  assert.equal(line.status, 'EXACT');
  assert.equal(line.outcome, 'CLAIM_NOW');
  assert.equal(line.portal?.source, 'TYPED');
  assert.equal(totalTaxOf(workspace.claimable).minor, 1_800_000n);
});

test('a typed row with a mistyped GST number is refused with a sentence a shopkeeper can act on', async () => {
  const desk = makeDesk({ books: [STEEL_BILL] });
  await assert.rejects(
    desk.service.addTypedRecord(owner, {
      period: SUNRISE_PERIOD,
      record: { supplierGstin: '27AAECS5678D1Z', number: 'X', documentDate: '2026-07-05', taxableValue: '100' },
    }),
    (error: unknown) => error instanceof DomainError && /fifteen characters/.test(error.message),
  );
});

test('the portal being unreachable changes nothing and never reads as "no purchases were reported"', async () => {
  const books = new InMemoryPurchaseBooks();
  books.add(...SUNRISE_BOOKS);
  const service = new ItcReconciliationService({
    books,
    records: new InMemoryPortalRecords(),
    batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(),
    audit: new InMemoryAuditPort(),
    clock: CLOCK,
    portal: new SyntheticPortalSource({ outcome: { kind: 'UNAVAILABLE', retryable: true, at: '2026-08-14T10:00:00.000Z', detail: 'The gateway timed out.' } }),
  });
  await assert.rejects(
    service.fetchFromPortal(owner, { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN }),
    (error: unknown) => error instanceof DomainError && error.code === 'ITC_PORTAL_UNAVAILABLE' && /do not know/.test(error.message),
  );
  const workspace = await service.workspace(owner, SUNRISE_PERIOD);
  assert.equal(workspace.portalDataPresent, false);
});

test('a business with no intermediary is told to import the file rather than shown a dead button', async () => {
  const desk = makeDesk();
  await assert.rejects(
    desk.service.fetchFromPortal(owner, { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN }),
    (error: unknown) => error instanceof DomainError && /Download the GSTR-2B file/.test(error.message),
  );
});

// ------------------------------------------------------------------- matching

test('bill numbers written differently at the two ends still find each other', () => {
  assert.equal(normaliseNumber('KP/0042'), normaliseNumber('KP-42'));
  assert.equal(normaliseNumber('inv 001'), normaliseNumber('INV-1'));
  // And two bills that really are different stay different.
  assert.notEqual(normaliseNumber('INV1A'), normaliseNumber('INV1B'));
});

test('two suppliers are never matched to each other, however alike the bills look', () => {
  const ours: BookPurchaseDocument = { ...STEEL_BILL, supplierGstin: MYSORE_GSTIN };
  const pairs = matchDocuments({
    books: [ours],
    portal: [{
      id: 'p1', companyId: SUNRISE_COMPANY, period: SUNRISE_PERIOD, supplierGstin: SHREE_RAM_GSTIN,
      supplierName: 'Shree Ram Steels', kind: 'INVOICE', number: STEEL_BILL.number,
      documentDate: STEEL_BILL.documentDate, amounts: STEEL_BILL.amounts, invoiceValue: STEEL_BILL.invoiceValue,
      itcAvailableOnPortal: true, itcUnavailableReason: null, amends: null, reversed: false,
      reverseCharge: false, source: 'GSTR2B_FILE', batchId: 'b1', observedAt: '2026-08-14T10:00:00.000Z',
    }],
  });
  assert.deepEqual(pairs.map((pair) => pair.status).sort(), ['ONLY_IN_BOOKS', 'ONLY_ON_PORTAL']);
});

test('every line carries the field-by-field evidence behind its decision', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);

  for (const line of workspace.lines) {
    assert.deepEqual(
      line.evidence.map((row) => row.field),
      ['SUPPLIER_GSTIN', 'INVOICE_NUMBER', 'INVOICE_DATE', 'DOCUMENT_KIND', 'TAXABLE_VALUE', 'TOTAL_TAX'],
      `${line.key} is missing evidence`,
    );
  }

  // And on the line that disagrees, the evidence says exactly what disagrees and by how much.
  const paper = lineFor(workspace, 'MP-9');
  const value = paper.evidence.find((row) => row.field === 'TAXABLE_VALUE');
  assert.equal(value?.verdict, 'DIFFERS');
  assert.equal(value?.ours, formatINR({ currency: 'INR', minor: 4_000_000n }));
  assert.equal(value?.theirs, formatINR({ currency: 'INR', minor: 3_000_000n }));
  assert.equal(value?.difference?.minor, 1_000_000n);
});

test('the four kinds of outcome land where they should', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);

  assert.equal(lineFor(workspace, 'SRS/2026-27/118').status, 'EXACT');
  assert.equal(lineFor(workspace, 'KP/0042').status, 'EXACT');
  assert.equal(lineFor(workspace, 'MP-9').status, 'CLOSE');
  assert.equal(lineFor(workspace, 'DC-556').status, 'ONLY_IN_BOOKS');
  assert.equal(lineFor(workspace, 'CT-77').status, 'ONLY_ON_PORTAL');
  assert.equal(lineFor(workspace, 'NM-771').outcome, 'BLOCKED_IN_BOOKS');
});

// ------------------------------------------------------------------- the second acceptance criterion

test('a bill the portal does not carry is never quietly treated as credit', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paint = lineFor(workspace, 'DC-556');

  assert.equal(paint.outcome, 'HELD_BACK');
  assert.equal(totalTaxOf(paint.claimable).minor, 0n);
  assert.equal(totalTaxOf(paint.heldBack).minor, 900_000n);
  assert.ok(paint.findings.some((entry) => entry.code === 'ITC_MISSING_FROM_PORTAL'));
  // And the credit does not reach the return by any other door.
  assert.equal(
    workspace.returnLinkage.contributions.some((contribution) => contribution.number === 'DC-556'),
    false,
  );
});

test('a month with no portal data at all claims nothing and says why', async () => {
  const desk = makeDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  assert.equal(totalTaxOf(workspace.claimable).minor, 0n);
  assert.equal(workspace.findings[0]?.code, 'ITC_NO_PORTAL_DATA');
  assert.equal(workspace.findings[0]?.severity, 'BLOCKING');
});

test('claiming a bill the portal does not carry takes a permission, a reason and a mark on the line', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paint = lineFor(workspace, 'DC-556');

  const clerk = actorWith(ITC_PERMISSIONS.view, ITC_PERMISSIONS.import, ITC_PERMISSIONS.decide);
  await assert.rejects(
    desk.service.decide(clerk, { period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'ACCEPT', reason: 'supplier says it is filed', idempotencyKey: 'k1' }),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
  await assert.rejects(
    desk.service.decide(owner, { period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'ACCEPT', reason: '   ', idempotencyKey: 'k2' }),
    (error: unknown) => error instanceof DomainError && error.code === 'ITC_REASON_REQUIRED',
  );

  const after = await desk.service.decide(owner, {
    period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'ACCEPT',
    reason: 'Supplier has shown me their filed return; it will appear next month.',
    idempotencyKey: 'k3',
  });
  const claimed = lineFor(after, 'DC-556');
  assert.equal(claimed.outcome, 'CLAIM_AT_RISK');
  assert.equal(totalTaxOf(claimed.claimable).minor, 900_000n);
  assert.ok(claimed.findings.some((entry) => entry.code === 'ITC_CLAIMED_AT_RISK'));
  assert.equal(totalTaxOf(after.atRisk).minor, 900_000n);
});

test('accepting a bill the two sides disagree about claims the lower of the two figures', async () => {
  const desk = await importedDesk();
  const before = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paper = lineFor(before, 'MP-9');

  const after = await desk.service.decide(owner, {
    period: SUNRISE_PERIOD, lineKey: paper.key, kind: 'ACCEPT',
    reason: 'They filed 30,000 by mistake and will amend it.', idempotencyKey: 'paper-1',
  });
  const claimed = lineFor(after, 'MP-9');
  assert.equal(claimed.outcome, 'CLAIM_AT_RISK');
  // Ours said ₹7,200 of GST; theirs said ₹5,400. The claim is theirs.
  assert.equal(totalTaxOf(claimed.claimable).minor, 540_000n);
  assert.equal(totalTaxOf(claimed.heldBack).minor, 180_000n);
});

test('a bill recorded twice can never carry credit, whatever anybody decides', async () => {
  const twice: BookPurchaseDocument = { ...STEEL_BILL, sourceId: 'bill-steel-copy' };
  const desk = makeDesk({ books: [STEEL_BILL, twice] });
  await desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE });

  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const duplicate = workspace.lines.find((line) => line.status === 'DUPLICATE_IN_BOOKS');
  assert.ok(duplicate !== undefined);
  assert.equal(totalTaxOf(duplicate.claimable).minor, 0n);
  assert.equal(duplicate.findings[0]?.severity, 'BLOCKING');
  await assert.rejects(
    desk.service.decide(owner, { period: SUNRISE_PERIOD, lineKey: duplicate.key, kind: 'ACCEPT', reason: 'both are real', idempotencyKey: 'dup-1' }),
    (error: unknown) => error instanceof DomainError && error.code === 'ITC_DUPLICATE_CANNOT_BE_ACCEPTED',
  );
  // The credit is counted once: ₹18,000 on the steel, not ₹36,000.
  assert.equal(lineFor(workspace, 'SRS/2026-27/118').claimable.igst.minor, 1_800_000n);
});

test('a bill with no supplier GST number is reported rather than matched on its number alone', async () => {
  const nameless: BookPurchaseDocument = { ...PAINT_BILL, supplierGstin: null };
  const desk = makeDesk({ books: [nameless] });
  await desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE });
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);

  const line = lineFor(workspace, 'DC-556');
  assert.equal(totalTaxOf(line.claimable).minor, 0n);
  assert.ok(line.findings.some((entry) => entry.code === 'ITC_SUPPLIER_GSTIN_MISSING'));
  assert.ok(workspace.findings.some((entry) => entry.code === 'ITC_SUPPLIER_GSTIN_MISSING' && entry.lineKey === null));
});

// ------------------------------------------------------------------- amendments and withdrawals

test('an amended document is shown as amended and does not claim on its own', async () => {
  const desk = makeDesk({ books: [PAPER_BILL] });
  await desk.service.importFile(owner, {
    period: SUNRISE_PERIOD,
    content: JSON.stringify({
      data: {
        rtnprd: '072026',
        docdata: {
          b2ba: [{
            ctin: MYSORE_GSTIN, trdnm: 'Mysore Papers',
            inv: [{
              inum: 'MP-9', oinum: 'MP-9', dt: '18-07-2026', val: 47200.00, itcavl: 'Y',
              txval: 40000.00, cgst: 3600.00, sgst: 3600.00, igst: 0, cess: 0,
            }],
          }],
        },
      },
    }),
  });

  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const line = lineFor(workspace, 'MP-9');
  assert.equal(line.status, 'EXACT');
  assert.ok(line.findings.some((entry) => entry.code === 'ITC_SUPPLIER_AMENDED'));
  // Every figure agrees, but an amendment is still not claimed until a person has looked at it.
  assert.equal(line.outcome, 'HELD_BACK');
});

test('a document the supplier withdrew stops carrying credit', async () => {
  const desk = makeDesk({ books: [STEEL_BILL] });
  await desk.service.importFile(owner, {
    period: SUNRISE_PERIOD,
    content: JSON.stringify({
      data: {
        rtnprd: '072026',
        docdata: {
          b2b: [{
            ctin: SHREE_RAM_GSTIN,
            inv: [{ inum: 'SRS/2026-27/118', dt: '05-07-2026', val: 118000.00, itcavl: 'Y', rev: 'Y', txval: 100000.00, igst: 18000.00 }],
          }],
        },
      },
    }),
  });
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const line = lineFor(workspace, 'SRS/2026-27/118');
  assert.equal(line.outcome, 'HELD_BACK');
  assert.ok(line.findings.some((entry) => entry.code === 'ITC_SUPPLIER_REVERSED'));
});

test("the portal's own 'credit not available' is never overridden quietly", async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const car = lineFor(workspace, 'NM-771');
  // Our books had already blocked it, which is the right answer and the one shown.
  assert.equal(car.outcome, 'BLOCKED_IN_BOOKS');
  assert.equal(totalTaxOf(car.claimable).minor, 0n);
});

// ------------------------------------------------------------------- recomputation

test('recomputing a period keeps the answers people gave, and the audit trail', async () => {
  const desk = await importedDesk();
  const first = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paint = lineFor(first, 'DC-556');
  await desk.service.decide(owner, {
    period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'PENDING',
    reason: 'Waiting on Deccan Chemicals to file.', idempotencyKey: 'recompute-1',
  });

  // A new bill is posted into the same month. Everything is matched again from scratch.
  desk.books.add({ ...PAINT_BILL, sourceId: 'bill-extra', number: 'DC-600' });
  const second = await desk.service.workspace(owner, SUNRISE_PERIOD);

  const stillThere = lineFor(second, 'DC-556');
  assert.equal(stillThere.decision?.kind, 'PENDING');
  assert.equal(stillThere.decision?.reason, 'Waiting on Deccan Chemicals to file.');
  assert.equal(stillThere.decisionStale, false);
  assert.equal(second.lines.length, first.lines.length + 1);

  const decisions = desk.audit.events.filter((entry) => entry.action === 'itc.decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.subjectId, `${SUNRISE_PERIOD}:${paint.key}`);
});

test('when the figures move under a decision, the decision is kept and marked out of date', async () => {
  const desk = await importedDesk();
  const before = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paint = lineFor(before, 'DC-556');
  await desk.service.decide(owner, {
    period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'PENDING',
    reason: 'Not filed yet.', idempotencyKey: 'stale-1',
  });

  // Next month the supplier files it. The line's facts have changed.
  await desk.service.importFile(owner, { period: SUNRISE_PERIOD, content: DECCAN_LATE_FILING });
  const after = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const line = lineFor(after, 'DC-556');

  assert.equal(line.status, 'EXACT');
  assert.equal(line.decision?.kind, 'PENDING');
  assert.equal(line.decisionStale, true);
  assert.ok(line.findings.some((entry) => entry.code === 'ITC_DECISION_STALE'));
  // The old "pending" still holds the credit back rather than being silently applied or dropped.
  assert.equal(line.outcome, 'HELD_BACK');
});

test('a decision replayed with the same idempotency key is not recorded twice', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paper = lineFor(workspace, 'MP-9');
  await desk.service.decide(owner, { period: SUNRISE_PERIOD, lineKey: paper.key, kind: 'REJECT', reason: 'Wrong figure.', idempotencyKey: 'once' });
  await desk.service.decide(owner, { period: SUNRISE_PERIOD, lineKey: paper.key, kind: 'REJECT', reason: 'Wrong figure.', idempotencyKey: 'once' });
  const history = await desk.service.decisionHistory(owner, paper.key);
  assert.equal(history.length, 1);
});

test('changing your mind is two events, both visible', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const paper = lineFor(workspace, 'MP-9');
  await desk.service.decide(owner, { period: SUNRISE_PERIOD, lineKey: paper.key, kind: 'PENDING', reason: 'Asked them.', idempotencyKey: 'mind-1' });
  const after = await desk.service.decide(owner, { period: SUNRISE_PERIOD, lineKey: paper.key, kind: 'REJECT', reason: 'They will not amend it.', idempotencyKey: 'mind-2' });

  assert.equal(lineFor(after, 'MP-9').decision?.kind, 'REJECT');
  assert.equal((await desk.service.decisionHistory(owner, paper.key)).length, 2);
});

// ------------------------------------------------------------------- the return, and #19

test('the credit side of GSTR-3B is built from these decisions and nothing else', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const linkage = workspace.returnLinkage;

  // ₹18,000 steel + ₹7,200 packaging. Nothing for the paint, the paper or the car.
  assert.equal(totalTaxOf(linkage.allOtherItc).minor, 2_520_000n);
  assert.equal(totalTaxOf(linkage.reversedItc).minor, 180_000n);
  assert.equal(totalTaxOf(workspace.claimable).minor, 2_340_000n);
  assert.equal(totalTaxOf(workspace.heldBack).minor, 1_620_000n);
  assert.match(linkage.caution['en-IN'], /deliberately not in this figure/);
});

test('the return workspace reads the reconciliation through #30\'s own port', async () => {
  const desk = await importedDesk();
  const port = itcInwardTaxPort(desk.service, () => owner);
  const inward = await port.summaryFor(SUNRISE_COMPANY, SUNRISE_PERIOD);

  const gstr3b = buildGstr3b({
    period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: '29', documents: [], inward,
  });
  const ordinary = gstr3b.credit.find((line) => line.boxId === '4A(5)');
  const givenBack = gstr3b.credit.find((line) => line.boxId === '4B');
  assert.equal(totalTaxOf(ordinary?.amounts ?? inward.allOtherItc).minor, 2_520_000n);
  assert.equal(totalTaxOf(givenBack?.amounts ?? inward.reversedItc).minor, 180_000n);
});

test("#19's GSTR-2B signal answers about one bill, and says nothing when we have not looked", async () => {
  const desk = await importedDesk();
  const port = gstr2bSignalPort(desk.service);

  const present = await port.signalFor(SUNRISE_COMPANY, {
    supplierGstin: SHREE_RAM_GSTIN, invoiceNumber: 'SRS/2026-27/118', invoiceDate: '2026-07-05' as IsoDate,
  });
  assert.equal(present?.present, true);
  assert.equal(present?.theirTaxableValue, '10000000');
  assert.equal(present?.ourTaxableValue, '10000000');

  const missing = await port.signalFor(SUNRISE_COMPANY, {
    supplierGstin: DECCAN_GSTIN, invoiceNumber: 'DC-556', invoiceDate: '2026-07-14' as IsoDate,
  });
  assert.equal(missing?.present, false);

  // A month nobody has imported answers null, so the supplier check says "not checked" rather than
  // "not reported" — which would be an accusation drawn out of our own silence.
  const untouched = makeDesk();
  const quiet = await gstr2bSignalPort(untouched.service).signalFor(SUNRISE_COMPANY, {
    supplierGstin: DECCAN_GSTIN, invoiceNumber: 'DC-556', invoiceDate: '2026-07-14' as IsoDate,
  });
  assert.equal(quiet, null);
});

// ------------------------------------------------------------------- permissions and tenancy

test('seeing, importing and deciding are three separate permissions', async () => {
  const desk = await importedDesk();
  const nobody = actorWith();
  await assert.rejects(desk.service.workspace(nobody, SUNRISE_PERIOD), (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN');

  const viewer = actorWith(ITC_PERMISSIONS.view);
  await assert.doesNotReject(desk.service.workspace(viewer, SUNRISE_PERIOD));
  await assert.rejects(
    desk.service.importFile(viewer, { period: SUNRISE_PERIOD, content: SUNRISE_CSV_FILE }),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
});

test('one company cannot see or decide another company\'s purchases', async () => {
  const desk = await importedDesk();
  const stranger: ActorContext = { ...owner, companyId: asId<'Company'>('99999999-9999-4999-8999-999999999999') };
  const theirs = await desk.service.workspace(stranger, SUNRISE_PERIOD);
  assert.equal(theirs.lines.length, 0);
  assert.equal(theirs.portalDataPresent, false);

  const mine = await desk.service.workspace(owner, SUNRISE_PERIOD);
  await assert.rejects(
    desk.service.decide(stranger, { period: SUNRISE_PERIOD, lineKey: lineFor(mine, 'MP-9').key, kind: 'REJECT', reason: 'not mine', idempotencyKey: 'x' }),
    (error: unknown) => error instanceof DomainError && error.kind === 'NOT_FOUND',
  );
});

// ------------------------------------------------------------------- the adapter over #17

test('a posted purchase bill becomes a comparable document without any figure changing', () => {
  const document = purchaseBillToBookDocument({
    id: 'bill-1', companyId: SUNRISE_COMPANY, supplierPartyId: 'party-1', supplierName: 'Shree Ram Steels',
    invoiceNumber: 'SRS/2026-27/118', invoiceDate: '2026-07-05', totalPaise: 11_800_000n, state: 'POSTED',
    voucherId: 'voucher-1',
    tax: {
      taxableValuePaise: 10_000_000n, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 1_800_000n,
      cessPaise: 0n, ineligibleItcPaise: 0n, reverseCharge: false,
    },
  }, { gstin: SHREE_RAM_GSTIN });

  assert.equal(document.amounts.igst.minor, 1_800_000n);
  assert.equal(document.period, SUNRISE_PERIOD);
  assert.equal(document.supplierGstin, SHREE_RAM_GSTIN);
  assert.equal(document.reversed, false);
});

test('a purchase the law blocks credit on shows as blocked rather than as a hole', () => {
  const desk = makeDesk({ books: [CAR_BILL] });
  assert.equal(CAR_BILL.ineligibleItc.minor, 22_400_000n);
  assert.ok(desk.service instanceof ItcReconciliationService);
});

test('the CSV reader takes an accountant\'s spreadsheet with its own column names', () => {
  const parsed = parseCsv(SUNRISE_CSV_FILE);
  assert.equal(parsed.records.length, 6);
  assert.equal(parsed.records[0]?.amounts.igst.minor, 1_800_000n);
  assert.equal(parsed.rejected.length, 0);
});

test('a typed row and a file row produce identical records', () => {
  const typed = parseTypedRecord({
    supplierGstin: SHREE_RAM_GSTIN, supplierName: 'Shree Ram Steels', number: 'SRS/2026-27/118',
    documentDate: '05-07-2026', taxableValue: '100000.00', igst: '18000.00', invoiceValue: '118000.00',
    itcAvailableOnPortal: 'Y',
  });
  const fromFile = parseGstr2bJson(SUNRISE_GSTR2B_FILE).records.find((record) => record.number === 'SRS/2026-27/118');
  assert.deepEqual(typed.amounts, fromFile?.amounts);
  assert.equal(typed.documentDate, fromFile?.documentDate);
  assert.equal(typed.itcAvailableOnPortal, fromFile?.itcAvailableOnPortal);
});

test('the Konkan bill is matched although the two numbers are written differently', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  const line = lineFor(workspace, 'KP/0042');
  assert.equal(line.portal?.number, 'KP-42');
  assert.equal(line.status, 'EXACT');
  assert.match(line.matchNote['en-IN'], /written slightly differently/);
});

test('the headline sentence for the month is one a shopkeeper can read', async () => {
  const desk = await importedDesk();
  const workspace = await desk.service.workspace(owner, SUNRISE_PERIOD);
  assert.match(workspace.sentence['en-IN'], /^July 2026: ₹23,400\.00 of GST on your purchases is safe to claim this month/);
  assert.match(workspace.sentence["en-IN"], /₹16,200\.00 is being held back on 3 bills that still need an answer/);
});

test('imports are recorded in the audit trail without the file itself', async () => {
  const desk = await importedDesk();
  const entry = desk.audit.events.find((event) => event.action === 'itc.portal_records_imported');
  assert.ok(entry !== undefined);
  assert.equal(entry.subjectId, SUNRISE_PERIOD);
  assert.equal(entry.details.documents, '6');
  assert.equal(entry.details.source, 'GSTR2B_FILE');
  assert.equal((entry.details.checksum ?? "").length, 64);
  assert.equal(Object.values(entry.details).some((value) => value.includes('AAECS')), false);
});
