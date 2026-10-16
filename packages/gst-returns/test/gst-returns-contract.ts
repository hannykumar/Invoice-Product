/**
 * Issue #366 — one contract suite for the return workspace's storage, run against the in-memory
 * stores (gst-returns-contract.test.ts) and against PostgreSQL as the application role
 * (gst-returns-contract.integration.test.ts).
 *
 * The lifecycle test drives the real service through the repository, so every move it makes —
 * prepare, approve, export, a rejected and an unanswered submission, reopen, filing — is shown to
 * pass the database's freeze rules (docs/contracts/database-immutability-v1.md).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { asId, fixedClock, isoDate, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import { InMemoryBookTax, InMemoryInwardTax, InMemoryOutwardSupplies, SyntheticGspChannel } from '../src/adapters.ts';
import { INV_001, SUNRISE_BOOK_TAX, SUNRISE_DOCUMENTS, SUNRISE_GSTIN, SUNRISE_INWARD, SUNRISE_PERIOD, SUNRISE_STATE } from '../src/fixtures.ts';
import { emptyInward } from '../src/gstr3b.ts';
import { preparationCursor, type Page, type ReturnPreparationRepository } from '../src/ports.ts';
import { GstReturnService } from '../src/service.ts';
import type { DeclaredThreshold } from '../src/thresholds.ts';
import { GST_RETURN_PERMISSIONS, taxPeriod, type ReturnPreparation, type TaxPeriod } from '../src/types.ts';

type Maybe<T> = T | Promise<T>;
export interface GstReturnHarness {
  preparations: ReturnPreparationRepository;
  thresholds: {
    declare(threshold: DeclaredThreshold): Maybe<void>;
    find(companyId: string, on: IsoDate): Maybe<DeclaredThreshold | undefined>;
    list(companyId: string, page?: Page): Maybe<readonly DeclaredThreshold[]>;
  };
  /** A company and a user: rows that exist wherever the implementation keeps them. */
  company(): Promise<CompanyId>;
  user(): Promise<UserId>;
  /** One business action: the unit of work a command handler opens. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? '');
const CLOCK = fixedClock('2026-08-11T09:30:00.000Z');

/** A preparation with bigint paise in its snapshot and its findings, nulls, and nothing approved. */
export const samplePreparation = (companyId: CompanyId, userId: UserId, period: TaxPeriod = SUNRISE_PERIOD): ReturnPreparation => {
  const document = { ...INV_001, companyId };
  return {
    id: crypto.randomUUID(),
    companyId,
    gstin: SUNRISE_GSTIN,
    period,
    returnType: 'GSTR1',
    state: 'DRAFT',
    snapshot: {
      period, takenAt: '2026-08-11T09:30:00.000Z', takenBy: userId, documentCount: 1, fingerprint: `fp-${period}`,
      documents: [document], inward: emptyInward(period), cancelledNumbers: [],
    },
    findings: [{
      code: 'GSTR1_SAMPLE', severity: 'WARNING', origin: 'VALIDATION',
      message: { 'en-IN': 'Check this bill.', 'hi-IN': 'Yeh bill dekhiye.' },
      whatToDo: { 'en-IN': 'Open it.', 'hi-IN': 'Ise kholiye.' },
      source: { sourceKind: 'sales_invoice', sourceId: 'inv-001', number: 'INV-001', date: document.documentDate, voucherId: 'vch-inv-001', amount: { currency: 'INR', minor: 9_007_199_254_740_993n } },
    }],
    approval: null,
    exportedAt: null,
    submission: null,
    createdBy: userId,
    createdAt: '2026-08-11T09:30:00.000Z',
    idempotencyKey: `key-${crypto.randomUUID()}`,
    version: 1,
  };
};

export function gstReturnContract(label: string, harness: () => GstReturnHarness, skip: false | string = false): void {
  const scene = async () => {
    const h = harness();
    const companyId = await h.company();
    const userId = await h.user();
    return { h, companyId, userId, repo: h.preparations };
  };

  test(`${label}: a preparation is stored and read back exactly, by period and by idempotency key`, { skip }, async () => {
    const { h, companyId, userId, repo } = await scene();
    const preparation = samplePreparation(companyId, userId);
    assert.equal(await repo.find(companyId, SUNRISE_PERIOD, 'GSTR1'), null, 'not found before it is stored');
    assert.equal(await repo.findByIdempotencyKey(companyId, preparation.idempotencyKey), null);
    await h.write(companyId, () => repo.insert(preparation));

    assert.deepEqual(await repo.find(companyId, SUNRISE_PERIOD, 'GSTR1'), preparation);
    assert.deepEqual(await repo.findByIdempotencyKey(companyId, preparation.idempotencyKey), preparation);
    assert.equal(await repo.find(companyId, SUNRISE_PERIOD, 'GSTR3B'), null, 'the other return of the month is its own row');
    assert.deepEqual(await repo.list(companyId), [preparation]);
  });

  test(`${label}: a second preparation for the month, or a reused idempotency key, is refused`, { skip }, async () => {
    const { h, companyId, userId, repo } = await scene();
    const first = samplePreparation(companyId, userId);
    await h.write(companyId, () => repo.insert(first));
    await assert.rejects(h.write(companyId, () => repo.insert({ ...samplePreparation(companyId, userId), id: crypto.randomUUID() })), code('GST_RETURN_EXISTS'));
    await assert.rejects(
      h.write(companyId, () => repo.insert({ ...samplePreparation(companyId, userId, taxPeriod('2026-06')), idempotencyKey: first.idempotencyKey })),
      code('GST_RETURN_EXISTS'),
    );
    assert.deepEqual(await repo.list(companyId), [first], 'neither refusal left anything behind');
  });

  test(`${label}: a stale update is refused, and so is an update of a return that is not stored`, { skip }, async () => {
    const { h, companyId, userId, repo } = await scene();
    const first = samplePreparation(companyId, userId);
    await assert.rejects(h.write(companyId, () => repo.update(first, 1)), code('GST_RETURN_MISSING'));
    await h.write(companyId, () => repo.insert(first));

    const second: ReturnPreparation = { ...first, state: 'NEEDS_ATTENTION', idempotencyKey: `key-${crypto.randomUUID()}`, version: 2 };
    await h.write(companyId, () => repo.update(second, 1));
    assert.deepEqual(await repo.find(companyId, SUNRISE_PERIOD, 'GSTR1'), second);
    assert.equal(await repo.findByIdempotencyKey(companyId, first.idempotencyKey), null, 'the replaced key no longer answers');

    await assert.rejects(h.write(companyId, () => repo.update({ ...second, state: 'DRAFT', version: 2 }, 1)), code('GST_RETURN_CHANGED'));
    assert.deepEqual(await repo.find(companyId, SUNRISE_PERIOD, 'GSTR1'), second, 'the stale write changed nothing');
  });

  test(`${label}: one company cannot read or change another company's return`, { skip }, async () => {
    const { h, companyId, userId, repo } = await scene();
    const other = await h.company();
    const mine = samplePreparation(companyId, userId);
    await h.write(companyId, () => repo.insert(mine));

    assert.equal(await repo.find(other, SUNRISE_PERIOD, 'GSTR1'), null);
    assert.equal(await repo.findByIdempotencyKey(other, mine.idempotencyKey), null);
    assert.deepEqual(await repo.list(other), []);
    await assert.rejects(h.write(other, () => repo.update({ ...mine, companyId: other, state: 'NEEDS_ATTENTION', version: 2 }, 1)), code('GST_RETURN_MISSING'));
    assert.deepEqual(await repo.find(companyId, SUNRISE_PERIOD, 'GSTR1'), mine);
  });

  test(`${label}: pages of the list return every return exactly once, newest month first`, { skip }, async () => {
    const { h, companyId, userId, repo } = await scene();
    const periods = ['2026-03', '2026-07', '2026-05', '2026-04', '2026-06'].map((p) => taxPeriod(p));
    for (const period of periods) await h.write(companyId, () => repo.insert(samplePreparation(companyId, userId, period)));

    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await repo.list(companyId, { limit: 2, ...(after === undefined ? {} : { after }) });
      assert.ok(page.length <= 2);
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.period));
      after = preparationCursor(page.at(-1) as ReturnPreparation);
    }
    assert.deepEqual(seen, ['2026-07', '2026-06', '2026-05', '2026-04', '2026-03']);
    assert.deepEqual((await repo.list(companyId)).map((row) => row.period).sort(), [...periods].sort(), 'without a page, everything');
  });

  test(`${label}: the service's whole lifecycle goes through the repository`, { skip }, async () => {
    const { h, companyId, userId, repo } = await scene();
    const outward = new InMemoryOutwardSupplies();
    outward.add(...SUNRISE_DOCUMENTS.map((document) => ({ ...document, companyId })));
    const inward = new InMemoryInwardTax();
    inward.set(companyId, SUNRISE_INWARD);
    const books = new InMemoryBookTax();
    books.set(companyId, SUNRISE_BOOK_TAX);
    const gsp = new SyntheticGspChannel(() => CLOCK.now().toISOString());
    const service = new GstReturnService({ outward, inward, books, repository: repo, audit: new InMemoryAuditPort(), clock: CLOCK, government: gsp });
    const actor: ActorContext = { companyId, branchId: asId<'Branch'>('main'), userId, permissions: Object.values(GST_RETURN_PERMISSIONS) };
    const input = { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE };
    const stored = async () => repo.find(companyId, SUNRISE_PERIOD, 'GSTR1');
    const act = <T>(work: () => Promise<T>) => h.write(companyId, work);

    const prepared = await act(() => service.prepare(actor, { ...input, idempotencyKey: 'july-1' }));
    assert.equal(prepared.state, 'DRAFT');
    assert.deepEqual(await stored(), prepared.preparation);
    await act(() => service.prepare(actor, { ...input, idempotencyKey: 'july-1' }));
    assert.equal((await stored())?.version, 1, 'the repeated key took no second photograph');

    const approved = await act(() => service.approve(actor, { ...input, note: 'Checked against the bills.' }));
    assert.deepEqual(await stored(), approved.preparation);
    assert.equal((await stored())?.approval?.note, 'Checked against the bills.');

    await act(() => service.exportFile(actor, { ...input, returnType: 'GSTR1' }));
    assert.equal((await stored())?.state, 'EXPORTED');
    assert.equal((await stored())?.exportedAt, CLOCK.now().toISOString());

    gsp.willReject([{ code: 'RET191113', detail: 'Invalid GSTIN in B2B section' }]);
    const rejected = await act(() => service.submit(actor, { ...input, returnType: 'GSTR1' }));
    assert.equal(rejected.state, 'SUBMISSION_FAILED');
    assert.deepEqual(await stored(), rejected);

    gsp.willTimeOut();
    const unknown = await act(() => service.submit(actor, { ...input, returnType: 'GSTR1' }));
    assert.equal(unknown.state, 'SUBMITTING');
    assert.equal(unknown.submission?.outcome, 'UNKNOWN');
    assert.deepEqual(await stored(), unknown, 'a retry of the same filing replaced the earlier attempt');

    const reopened = await act(() => service.reopen(actor, SUNRISE_PERIOD, 'A July bill turned up in August.'));
    assert.deepEqual(await stored(), reopened);
    assert.equal(reopened.approval, null);

    const again = await act(() => service.prepare(actor, { ...input, idempotencyKey: 'july-2' }));
    assert.deepEqual(await stored(), again.preparation);
    assert.equal((await stored())?.submission, null, 'a return prepared again starts with no submission');

    const reapproved = await act(() => service.approve(actor, input));
    assert.deepEqual(await stored(), reapproved.preparation);
    assert.equal((await stored())?.approval?.note, null);

    gsp.willAccept();
    const filed = await act(() => service.submit(actor, { ...input, returnType: 'GSTR1' }));
    assert.equal(filed.state, 'FILED');
    assert.deepEqual(await stored(), filed);

    await assert.rejects(act(() => service.reopen(actor, SUNRISE_PERIOD, 'we changed our minds')), code('GST_RETURN_ALREADY_FILED'));
    await act(() => service.exportFile(actor, { ...input, returnType: 'GSTR3B' }));
    assert.equal((await stored())?.state, 'FILED', 'a filed return can still be downloaded, and stays filed');
    assert.deepEqual((await service.list(actor)).map((row) => row.state), ['FILED']);
  });

  const declared = (companyId: string, userId: string, effectiveFrom: string, effectiveTo: string | null = null): DeclaredThreshold => ({
    companyId, aboveValue: { currency: 'INR', minor: 9_007_199_254_740_993n }, effectiveFrom: isoDate(effectiveFrom),
    effectiveTo: effectiveTo === null ? null : isoDate(effectiveTo), declaredBy: userId, declaredOn: isoDate('2026-08-11'),
    basis: 'Our accountant, by letter.',
  });

  test(`${label}: a declared threshold is stored exactly and found by the date it applies on`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const other = await h.company();
    const early = declared(companyId, userId, '2025-04-01', '2026-03-31');
    const late = declared(companyId, userId, '2026-04-01');
    await h.write(companyId, async () => { await h.thresholds.declare(early); await h.thresholds.declare(late); });

    assert.deepEqual(await h.thresholds.find(companyId, isoDate('2026-03-31')), early);
    assert.deepEqual(await h.thresholds.find(companyId, isoDate('2026-07-15')), late);
    assert.equal(await h.thresholds.find(companyId, isoDate('2025-03-31')), undefined, 'nothing declared that early');
    assert.deepEqual(await h.thresholds.list(companyId), [early, late]);
    assert.equal(await h.thresholds.find(other, isoDate('2026-07-15')), undefined, "another company's figure is not ours");
    assert.deepEqual(await h.thresholds.list(other), []);
  });

  test(`${label}: a second threshold from the same date, or one with no author's reason, is refused`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const first = declared(companyId, userId, '2026-04-01');
    await h.write(companyId, async () => h.thresholds.declare(first));
    await assert.rejects(h.write(companyId, async () => h.thresholds.declare({ ...first, basis: 'A different story.' })), code('DECLARED_THRESHOLD_EXISTS'));
    await assert.rejects(h.write(companyId, async () => h.thresholds.declare({ ...declared(companyId, userId, '2026-05-01'), basis: '  ' })), code('DECLARED_THRESHOLD_NO_BASIS'));
    assert.deepEqual(await h.thresholds.list(companyId), [first]);
  });

  test(`${label}: pages of declared thresholds return each one exactly once, oldest first`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const dates = ['2026-01-01', '2024-01-01', '2025-01-01', '2023-01-01', '2022-01-01'];
    for (const date of dates) await h.write(companyId, async () => h.thresholds.declare(declared(companyId, userId, date)));

    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await h.thresholds.list(companyId, { limit: 2, ...(after === undefined ? {} : { after }) });
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.effectiveFrom));
      after = page.at(-1)?.effectiveFrom;
    }
    assert.deepEqual(seen, [...dates].sort());
  });
}
