/**
 * Issue #366 — one contract suite for the purchase comparison's storage, run against the in-memory
 * stores (itc-repository-contract.test.ts) and against PostgreSQL as the application role
 * (itc-repository-contract.integration.test.ts).
 *
 * Nothing in this module has a version to conflict on or a "not found" error: the three histories
 * are append-only, and a lookup that finds nothing answers `null`. Both are covered as such.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { money, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import type { ImportBatchRepository, ItcClaimRepository, ItcDecisionRepository, PortalRecordRepository } from '../src/ports.ts';
import { taxPeriod, type ImportBatch, type ItcClaim, type ItcDecision, type PortalDocument } from '../src/types.ts';

export interface ItcRepositoryHarness {
  readonly records: PortalRecordRepository;
  readonly batches: ImportBatchRepository;
  readonly decisions: ItcDecisionRepository;
  readonly claims: ItcClaimRepository;
  /** A company and a person: rows that exist wherever the implementation keeps them. */
  company(): Promise<CompanyId>;
  user(): Promise<UserId>;
  /** Runs `work` as one business action — a unit of work on PostgreSQL, a plain call in memory. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

export const JULY = taxPeriod('2026-07');
export const AUGUST = taxPeriod('2026-08');
export const STEEL_GSTIN = syntheticGstin('27', 'AAECS5678D');
export const PAINT_GSTIN = syntheticGstin('29', 'AABCD7788M');
/** More paise than a JavaScript number can hold exactly. */
export const HUGE = 9_007_199_254_740_993n;

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

export const batchOf = (companyId: CompanyId, userId: UserId, over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: crypto.randomUUID(),
  companyId,
  period: JULY,
  source: 'GSTR2B_FILE',
  fileName: 'GSTR2B_072026.json',
  checksum: crypto.randomUUID(),
  importedBy: userId,
  importedAt: '2026-08-14T10:00:00.123Z',
  documentCount: 2,
  addedCount: 1,
  replacedCount: 1,
  unchangedCount: 0,
  rejected: [{ row: 'row 7', reason: 'The GST number on this row is one character short.' }],
  sentence: { 'en-IN': '2 purchases for July 2026 came from a file: 1 new, 1 updated.', 'hi-IN': 'July 2026 ki 2 kharid file se aayi: 1 nayi, 1 badli.' },
  ...over,
});

export const documentOf = (batch: ImportBatch, index: number, over: Partial<PortalDocument> = {}): PortalDocument => ({
  id: `${batch.id}:${index}`,
  companyId: batch.companyId,
  period: batch.period,
  supplierGstin: STEEL_GSTIN,
  supplierName: 'Synthetic Steel Traders',
  kind: 'INVOICE',
  number: `ST/26-27/${String(index + 1).padStart(4, '0')}`,
  documentDate: '2026-07-01' as IsoDate,
  amounts: { taxableValue: money(100_000_00n), cgst: money(9_000_00n), sgst: money(9_000_00n), igst: money(0n), cess: money(0n) },
  invoiceValue: money(118_000_00n),
  itcAvailableOnPortal: true,
  itcUnavailableReason: null,
  amends: null,
  reversed: false,
  reverseCharge: false,
  source: batch.source,
  batchId: batch.id,
  observedAt: batch.importedAt,
  ...over,
});

export const decisionOf = (companyId: CompanyId, userId: UserId, over: Partial<ItcDecision> = {}): ItcDecision => ({
  id: crypto.randomUUID(),
  companyId,
  period: JULY,
  lineKey: `${STEEL_GSTIN}|ST26271|INVOICE`,
  kind: 'ACCEPT',
  reason: '',
  decidedBy: userId,
  decidedAt: '2026-08-14T10:00:00.000Z',
  fingerprint: 'a'.repeat(64),
  idempotencyKey: crypto.randomUUID(),
  ...over,
});

export const claimOf = (companyId: CompanyId, userId: UserId, over: Partial<ItcClaim> = {}): ItcClaim => ({
  id: crypto.randomUUID(),
  companyId,
  sourceKind: 'purchase_bill',
  sourceId: `bill-${crypto.randomUUID()}`,
  period: JULY,
  outcome: 'CLAIM_NOW',
  lineKey: `${STEEL_GSTIN}|ST26271|INVOICE`,
  fingerprint: 'b'.repeat(64),
  claimedBy: userId,
  claimedAt: '2026-08-14T10:00:00.000Z',
  ...over,
});

/** Walks a list a page at a time and returns every row it was given, in order. */
export const everyPage = async <T extends { readonly id: string }>(
  list: (page: { limit: number; after?: string }) => Promise<readonly T[]>,
  limit = 2,
): Promise<T[]> => {
  const seen: T[] = [];
  for (let after: string | undefined; ;) {
    const rows = await list(after === undefined ? { limit } : { limit, after });
    assert.ok(rows.length <= limit, 'a page is never longer than its limit');
    seen.push(...rows);
    if (rows.length < limit) return seen;
    after = (rows.at(-1) as T).id;
  }
};

export function itcRepositoryContract(label: string, harness: () => ItcRepositoryHarness, skip: false | string = false): void {
  const scene = async () => {
    const h = harness();
    const companyId = await h.company();
    const userId = await h.user();
    return { h, companyId, userId };
  };
  /** A batch with its rows, stored the way the service stores them: the rows first, then the batch. */
  const imported = async (s: Awaited<ReturnType<typeof scene>>, documents: (batch: ImportBatch) => PortalDocument[], over: Partial<ImportBatch> = {}) => {
    const batch = batchOf(s.companyId, s.userId, over);
    const rows = documents(batch);
    const counts = await s.h.write(s.companyId, async () => {
      const put = await s.h.records.put(s.companyId, batch.period, rows);
      await s.h.batches.insert(batch);
      return put;
    });
    return { batch, rows, counts };
  };

  // ------------------------------------------------------------------ import batches

  test(`${label}: an import batch comes back exactly as it was stored, nulls and all`, { skip }, async () => {
    const s = await scene();
    const file = batchOf(s.companyId, s.userId);
    const typed = batchOf(s.companyId, s.userId, { source: 'TYPED', fileName: null, rejected: [], documentCount: 0, addedCount: 0, replacedCount: 0 });
    await s.h.write(s.companyId, async () => { await s.h.batches.insert(file); await s.h.batches.insert(typed); });

    assert.deepEqual(await s.h.batches.findByChecksum(s.companyId, JULY, file.checksum), file);
    assert.deepEqual(await s.h.batches.findByChecksum(s.companyId, JULY, typed.checksum), typed);
    assert.deepEqual(await s.h.batches.list(s.companyId, JULY), [file, typed], 'in the order they were imported');
    assert.deepEqual(await s.h.batches.latestFor(s.companyId, JULY), typed, 'the latest is the last one written, even at the same instant');
  });

  test(`${label}: a batch that is not there is null, and another month's batch is not this month's`, { skip }, async () => {
    const s = await scene();
    const file = batchOf(s.companyId, s.userId);
    await s.h.write(s.companyId, () => s.h.batches.insert(file));
    assert.equal(await s.h.batches.findByChecksum(s.companyId, JULY, 'no-such-checksum'), null);
    assert.equal(await s.h.batches.findByChecksum(s.companyId, AUGUST, file.checksum), null);
    assert.equal(await s.h.batches.latestFor(s.companyId, AUGUST), null);
    assert.deepEqual(await s.h.batches.list(s.companyId, AUGUST), []);
  });

  test(`${label}: the same file for the same month is refused a second time, and the first stays`, { skip }, async () => {
    const s = await scene();
    const file = batchOf(s.companyId, s.userId);
    await s.h.write(s.companyId, () => s.h.batches.insert(file));
    await assert.rejects(s.h.write(s.companyId, () => s.h.batches.insert(batchOf(s.companyId, s.userId, { checksum: file.checksum }))), code('ITC_IMPORT_DUPLICATE'));
    await assert.rejects(s.h.write(s.companyId, () => s.h.batches.insert({ ...file, checksum: 'another' })), code('ITC_IMPORT_DUPLICATE'));
    // The same file is a different import in a different month.
    await s.h.write(s.companyId, () => s.h.batches.insert(batchOf(s.companyId, s.userId, { checksum: file.checksum, period: AUGUST })));
    assert.deepEqual(await s.h.batches.list(s.companyId, JULY), [file]);
  });

  test(`${label}: import batches are paged without losing or repeating one`, { skip }, async () => {
    const s = await scene();
    const all = Array.from({ length: 5 }, () => batchOf(s.companyId, s.userId));
    await s.h.write(s.companyId, async () => { for (const batch of all) await s.h.batches.insert(batch); });
    assert.deepEqual(await everyPage((page) => s.h.batches.list(s.companyId, JULY, page)), all);
    assert.deepEqual(await s.h.batches.list(s.companyId, JULY, { limit: 2, after: 'not-a-batch' }), all.slice(0, 2), 'an unknown cursor starts from the beginning');
    assert.deepEqual(await s.h.batches.list(s.companyId, JULY, { limit: 2, after: crypto.randomUUID() }), all.slice(0, 2));
  });

  // ------------------------------------------------------------------ portal rows

  test(`${label}: portal rows come back exactly as stored: paise beyond 2^53, dates, nulls, an amendment`, { skip }, async () => {
    const s = await scene();
    const { rows, counts } = await imported(s, (batch) => [
      documentOf(batch, 0, { amounts: { taxableValue: money(HUGE), cgst: money(0n), sgst: money(0n), igst: money(HUGE), cess: money(1n) }, invoiceValue: money(HUGE * 2n) }),
      documentOf(batch, 1, { supplierName: null, itcAvailableOnPortal: null, documentDate: '2026-07-31' as IsoDate }),
      documentOf(batch, 2, {
        supplierGstin: PAINT_GSTIN, kind: 'CREDIT_NOTE', itcAvailableOnPortal: false, itcUnavailableReason: 'POS and supplier state are same for IGST',
        amends: { number: 'PN/0007', period: taxPeriod('2026-06') }, reversed: true, reverseCharge: true,
        amounts: { taxableValue: money(-5_000_00n), cgst: money(-450_00n), sgst: money(-450_00n), igst: money(0n), cess: money(0n) }, invoiceValue: money(-5_900_00n),
      }),
    ]);
    assert.deepEqual(counts, { added: 3, replaced: 0, unchanged: 0 });
    assert.deepEqual(await s.h.records.listForPeriod(s.companyId, JULY), rows);
    assert.deepEqual(await s.h.records.listThroughPeriod(s.companyId, JULY), rows);
  });

  test(`${label}: a second reading of the same document replaces the first instead of adding to it`, { skip }, async () => {
    const s = await scene();
    const first = await imported(s, (batch) => [documentOf(batch, 0), documentOf(batch, 1), documentOf(batch, 2)]);
    const second = await imported(s, (batch) => [
      documentOf(batch, 0), // the same figures
      // Written differently, the same document: "ST/26-27/0002" and "st 26-27 0002".
      documentOf(batch, 1, { number: 'st 26-27 0002', amounts: { ...documentOf(batch, 1).amounts, taxableValue: money(90_000_00n) } }),
      documentOf(batch, 3), // new
      documentOf(batch, 4, { number: 'ST/26-27/0001', kind: 'DEBIT_NOTE' }), // same number, another kind: another document
    ]);
    assert.deepEqual(second.counts, { added: 2, replaced: 1, unchanged: 1 });
    // Replaced rows keep their place; the row itself is the new reading, with its new batch.
    assert.deepEqual(await s.h.records.listForPeriod(s.companyId, JULY), [second.rows[0], second.rows[1], first.rows[2], second.rows[2], second.rows[3]]);
  });

  test(`${label}: one file carrying the same document twice keeps the last, and counts both`, { skip }, async () => {
    const s = await scene();
    const { rows, counts } = await imported(s, (batch) => [
      documentOf(batch, 0),
      documentOf(batch, 1, { number: documentOf(batch, 0).number, reversed: true }),
      documentOf(batch, 2, { number: documentOf(batch, 0).number, reversed: true }),
    ]);
    assert.deepEqual(counts, { added: 1, replaced: 1, unchanged: 1 });
    assert.deepEqual(await s.h.records.listForPeriod(s.companyId, JULY), [rows[2]]);
    assert.deepEqual(await s.h.write(s.companyId, () => s.h.records.put(s.companyId, JULY, [])), { added: 0, replaced: 0, unchanged: 0 });
  });

  test(`${label}: rows are read by month, up to a month, and by one bill`, { skip }, async () => {
    const s = await scene();
    const june = await imported(s, (batch) => [documentOf(batch, 0, { number: 'JUN-1' })], { period: taxPeriod('2026-06') });
    const july = await imported(s, (batch) => [documentOf(batch, 0, { number: 'JUL-1' }), documentOf(batch, 1, { number: 'JUL-2', supplierGstin: PAINT_GSTIN })]);
    const august = await imported(s, (batch) => [documentOf(batch, 0, { number: 'AUG-1' })], { period: AUGUST });

    assert.deepEqual(await s.h.records.listForPeriod(s.companyId, JULY), july.rows);
    assert.deepEqual(await s.h.records.listThroughPeriod(s.companyId, JULY), [...june.rows, ...july.rows]);
    assert.deepEqual(await s.h.records.listThroughPeriod(s.companyId, AUGUST), [...june.rows, ...july.rows, ...august.rows]);
    assert.deepEqual(await s.h.records.listForPeriod(s.companyId, taxPeriod('2026-05')), []);

    assert.deepEqual(await s.h.records.findByDocument(s.companyId, { supplierGstin: PAINT_GSTIN.toLowerCase(), invoiceNumber: 'jul 2' }), july.rows[1]);
    assert.equal(await s.h.records.findByDocument(s.companyId, { supplierGstin: PAINT_GSTIN, invoiceNumber: 'JUL-1' }), null, 'the number alone is not a match');
    assert.equal(await s.h.records.findByDocument(s.companyId, { supplierGstin: STEEL_GSTIN, invoiceNumber: 'NO-SUCH' }), null);
  });

  test(`${label}: portal rows are paged without losing or repeating one`, { skip }, async () => {
    const s = await scene();
    const june = await imported(s, (batch) => [0, 1, 2].map((index) => documentOf(batch, index, { number: `JUN-${index}` })), { period: taxPeriod('2026-06') });
    const july = await imported(s, (batch) => [0, 1, 2, 3].map((index) => documentOf(batch, index, { number: `JUL-${index}` })));
    assert.deepEqual(await everyPage((page) => s.h.records.listForPeriod(s.companyId, JULY, page)), july.rows);
    assert.deepEqual(await everyPage((page) => s.h.records.listThroughPeriod(s.companyId, JULY, page), 3), [...june.rows, ...july.rows]);
    assert.deepEqual(await everyPage((page) => s.h.records.listThroughPeriod(s.companyId, JULY, page), 1), [...june.rows, ...july.rows]);
  });

  // ------------------------------------------------------------------ decisions

  test(`${label}: every answer on a line is kept, in the order it was given`, { skip }, async () => {
    const s = await scene();
    // Three answers at the same instant: only the order they were written in tells them apart.
    const accept = decisionOf(s.companyId, s.userId);
    const reject = decisionOf(s.companyId, s.userId, { kind: 'REJECT', reason: 'The supplier billed the wrong quantity.' });
    const pending = decisionOf(s.companyId, s.userId, { kind: 'PENDING' });
    const other = decisionOf(s.companyId, s.userId, { lineKey: `${PAINT_GSTIN}|PN7|INVOICE`, decidedAt: '2026-08-15T04:30:00.007Z' });
    const august = decisionOf(s.companyId, s.userId, { period: AUGUST });
    await s.h.write(s.companyId, async () => { for (const decision of [accept, reject, other, pending, august]) await s.h.decisions.insert(decision); });

    assert.deepEqual(await s.h.decisions.latestForPeriod(s.companyId, JULY), [accept, reject, other, pending]);
    assert.deepEqual(await s.h.decisions.history(s.companyId, accept.lineKey), [accept, reject, pending, august], 'a line\'s history is not cut off at the month');
    assert.deepEqual(await s.h.decisions.history(s.companyId, 'no-such-line'), []);
    assert.deepEqual(await s.h.decisions.findByIdempotencyKey(s.companyId, reject.idempotencyKey), reject);
    assert.equal(await s.h.decisions.findByIdempotencyKey(s.companyId, 'never-used'), null);
  });

  test(`${label}: a repeated idempotency key is refused, and the first answer stays`, { skip }, async () => {
    const s = await scene();
    const first = decisionOf(s.companyId, s.userId);
    await s.h.write(s.companyId, () => s.h.decisions.insert(first));
    await assert.rejects(s.h.write(s.companyId, () => s.h.decisions.insert(decisionOf(s.companyId, s.userId, { kind: 'REJECT', reason: 'Changed my mind.', idempotencyKey: first.idempotencyKey }))), code('ITC_DECISION_DUPLICATE'));
    await assert.rejects(s.h.write(s.companyId, () => s.h.decisions.insert({ ...first, idempotencyKey: 'another-key' })), code('ITC_DECISION_DUPLICATE'));
    assert.deepEqual(await s.h.decisions.history(s.companyId, first.lineKey), [first]);
  });

  test(`${label}: decisions are paged without losing or repeating one`, { skip }, async () => {
    const s = await scene();
    const all = Array.from({ length: 5 }, (_, index) => decisionOf(s.companyId, s.userId, { kind: index % 2 === 0 ? 'ACCEPT' : 'PENDING' }));
    await s.h.write(s.companyId, async () => { for (const decision of all) await s.h.decisions.insert(decision); });
    assert.deepEqual(await everyPage((page) => s.h.decisions.latestForPeriod(s.companyId, JULY, page)), all);
    assert.deepEqual(await everyPage((page) => s.h.decisions.history(s.companyId, (all[0] as ItcDecision).lineKey, page), 4), all);
  });

  // ------------------------------------------------------------------ claims

  test(`${label}: a bill's credit is claimed once; a second claim hands back the first`, { skip }, async () => {
    const s = await scene();
    const first = claimOf(s.companyId, s.userId);
    const atRisk = claimOf(s.companyId, s.userId, { outcome: 'CLAIM_AT_RISK', period: AUGUST, claimedAt: '2026-09-11T18:29:59.999Z' });
    assert.deepEqual(await s.h.write(s.companyId, () => s.h.claims.insert(first)), { claim: first, inserted: true });
    assert.deepEqual(await s.h.write(s.companyId, () => s.h.claims.insert(atRisk)), { claim: atRisk, inserted: true });

    // The same bill again, in a later month, by a later click.
    const again = claimOf(s.companyId, s.userId, { sourceKind: first.sourceKind, sourceId: first.sourceId, period: AUGUST, outcome: 'CLAIM_AT_RISK' });
    assert.deepEqual(await s.h.write(s.companyId, () => s.h.claims.insert(again)), { claim: first, inserted: false });
    // The same id for another kind of document is a different claim.
    const debitNote = claimOf(s.companyId, s.userId, { sourceKind: 'purchase_return', sourceId: first.sourceId });
    assert.equal((await s.h.write(s.companyId, () => s.h.claims.insert(debitNote))).inserted, true);

    assert.deepEqual(await s.h.claims.listForCompany(s.companyId), [first, atRisk, debitNote]);
  });

  test(`${label}: claims are paged without losing or repeating one`, { skip }, async () => {
    const s = await scene();
    assert.deepEqual(await s.h.claims.listForCompany(s.companyId), []);
    const all = Array.from({ length: 7 }, () => claimOf(s.companyId, s.userId));
    await s.h.write(s.companyId, async () => { for (const claim of all) await s.h.claims.insert(claim); });
    assert.deepEqual(await everyPage((page) => s.h.claims.listForCompany(s.companyId, page), 3), all);
  });

  // ------------------------------------------------------------------ two companies

  test(`${label}: one company cannot read, replace or pre-empt another company's rows`, { skip }, async () => {
    const a = await scene();
    const b = await scene();
    const mine = await imported(a, (batch) => [documentOf(batch, 0)]);
    const decision = decisionOf(a.companyId, a.userId);
    const claim = claimOf(a.companyId, a.userId);
    await a.h.write(a.companyId, async () => { await a.h.decisions.insert(decision); await a.h.claims.insert(claim); });

    assert.deepEqual(await b.h.records.listForPeriod(b.companyId, JULY), []);
    assert.deepEqual(await b.h.records.listThroughPeriod(b.companyId, AUGUST), []);
    assert.equal(await b.h.records.findByDocument(b.companyId, { supplierGstin: STEEL_GSTIN, invoiceNumber: (mine.rows[0] as PortalDocument).number }), null);
    assert.equal(await b.h.batches.findByChecksum(b.companyId, JULY, mine.batch.checksum), null);
    assert.equal(await b.h.batches.latestFor(b.companyId, JULY), null);
    assert.deepEqual(await b.h.batches.list(b.companyId, JULY), []);
    assert.deepEqual(await b.h.decisions.latestForPeriod(b.companyId, JULY), []);
    assert.deepEqual(await b.h.decisions.history(b.companyId, decision.lineKey), []);
    assert.equal(await b.h.decisions.findByIdempotencyKey(b.companyId, decision.idempotencyKey), null);
    assert.deepEqual(await b.h.claims.listForCompany(b.companyId), []);

    // The same file, the same document, the same key and the same bill id are B's own, not a clash with A's.
    const theirs = await imported(b, (batch) => [documentOf(batch, 0, { reversed: true })], { checksum: mine.batch.checksum });
    assert.deepEqual(theirs.counts, { added: 1, replaced: 0, unchanged: 0 });
    const theirDecision = decisionOf(b.companyId, b.userId, { idempotencyKey: decision.idempotencyKey, kind: 'REJECT', reason: 'Not ours.' });
    const theirClaim = claimOf(b.companyId, b.userId, { sourceId: claim.sourceId });
    await b.h.write(b.companyId, async () => {
      await b.h.decisions.insert(theirDecision);
      assert.deepEqual(await b.h.claims.insert(theirClaim), { claim: theirClaim, inserted: true });
    });
    // A cursor from company A means nothing to company B: it starts from B's own beginning.
    assert.deepEqual(await b.h.claims.listForCompany(b.companyId, { limit: 5, after: claim.id }), [theirClaim]);

    assert.deepEqual(await a.h.records.listForPeriod(a.companyId, JULY), mine.rows, 'A still holds its own reading');
    assert.deepEqual(await a.h.batches.list(a.companyId, JULY), [mine.batch]);
    assert.deepEqual(await a.h.decisions.latestForPeriod(a.companyId, JULY), [decision]);
    assert.deepEqual(await a.h.claims.listForCompany(a.companyId), [claim]);
    assert.deepEqual(await b.h.records.listForPeriod(b.companyId, JULY), theirs.rows);
  });
}
