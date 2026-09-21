/** Issue #213 — unclaimed purchase credit follows the bill until it is claimed or time-barred. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, fixedClock } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  InMemoryImportBatches,
  InMemoryItcClaims,
  InMemoryItcDecisions,
  InMemoryPortalRecords,
  InMemoryPurchaseBooks,
} from '../src/adapters.ts';
import { bill, SUNRISE_COMPANY } from '../src/fixtures.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { ITC_PERMISSIONS, taxPeriod, totalTaxOf, type BookPurchaseDocument, type ItcWorkspace } from '../src/types.ts';

const APRIL = taxPeriod('2026-04');
const MAY = taxPeriod('2026-05');
const JUNE = taxPeriod('2026-06');
const JULY = taxPeriod('2026-07');

const owner: ActorContext = {
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(ITC_PERMISSIONS),
};

const aprilBill = (id: string, tax = 1_800): BookPurchaseDocument => bill({
  id,
  supplierName: `Supplier ${id}`,
  gstin: '27AAECS5678D1Z4',
  number: `APR/${id}`,
  date: '2026-04-05',
  taxable: 10_000,
  igst: tax,
});

const desk = (documents: readonly BookPurchaseDocument[]) => {
  const books = new InMemoryPurchaseBooks();
  books.add(...documents);
  const claims = new InMemoryItcClaims();
  let id = 0;
  const service = new ItcReconciliationService({
    books,
    claims,
    records: new InMemoryPortalRecords(),
    batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(),
    audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-05-20T10:00:00.000Z'),
    idFactory: () => `id-${++id}`,
  });
  return { service, claims };
};

const lineFor = (workspace: ItcWorkspace, sourceId: string) => {
  const line = workspace.lines.find((candidate) => candidate.book?.sourceId === sourceId);
  assert.ok(line !== undefined, `expected ${sourceId} in ${workspace.period}`);
  return line;
};

const accept = async (service: ItcReconciliationService, period: typeof MAY, sourceId: string, key: string) => {
  const line = lineFor(await service.workspace(owner, period), sourceId);
  return service.decide(owner, {
    period,
    lineKey: line.key,
    kind: 'ACCEPT',
    reason: 'Checked by the owner for this return.',
    idempotencyKey: key,
  });
};

test('a bill missing from the April portal record appears again in May as held back', async () => {
  const { service } = desk([aprilBill('late')]);

  assert.equal(lineFor(await service.workspace(owner, APRIL), 'late').outcome, 'HELD_BACK');
  const may = lineFor(await service.workspace(owner, MAY), 'late');

  assert.equal(may.outcome, 'HELD_BACK');
  assert.equal(totalTaxOf(may.heldBack).minor, 1_800_00n);
});

test('an unclaimed bill keeps its earlier portal evidence in the next month', async () => {
  const { service } = desk([aprilBill('reported')]);
  await service.addTypedRecord(owner, {
    period: APRIL,
    record: {
      supplierGstin: '27AAECS5678D1Z4',
      supplierName: 'Supplier reported',
      number: 'APR/reported',
      documentDate: '2026-04-05',
      taxableValue: '10000',
      igst: '1800',
      invoiceValue: '11800',
      itcAvailableOnPortal: 'Y',
    },
  });

  assert.equal(lineFor(await service.workspace(owner, MAY), 'reported').outcome, 'CLAIM_NOW');
});

test('a bill accepted and claimed in May is absent from June and its total', async () => {
  const { service } = desk([aprilBill('claimed')]);

  const may = await accept(service, MAY, 'claimed', 'claim-in-may');
  assert.equal(lineFor(may, 'claimed').outcome, 'CLAIM_AT_RISK');

  // Reopening May and changing the answer cannot erase the claim that was already recorded.
  await service.decide(owner, {
    period: MAY,
    lineKey: lineFor(may, 'claimed').key,
    kind: 'REJECT',
    reason: 'A later review changed the workspace answer.',
    idempotencyKey: 'reopened-may',
  });

  const june = await service.workspace(owner, JUNE);
  assert.equal(june.lines.some((line) => line.book?.sourceId === 'claimed'), false);
  assert.equal(totalTaxOf(june.claimable).minor, 0n);
});

test('a clean CLAIM_NOW line is recorded when its GSTR-3B period is prepared', async () => {
  const { service } = desk([aprilBill('clean')]);
  await service.addTypedRecord(owner, {
    period: MAY,
    record: {
      supplierGstin: '27AAECS5678D1Z4',
      supplierName: 'Supplier clean',
      number: 'APR/clean',
      documentDate: '2026-04-05',
      taxableValue: '10000',
      igst: '1800',
      invoiceValue: '11800',
      itcAvailableOnPortal: 'Y',
    },
  });

  assert.equal(lineFor(await service.workspace(owner, MAY), 'clean').outcome, 'CLAIM_NOW');
  await service.claimPeriod(owner, MAY);

  assert.equal((await service.workspace(owner, JUNE)).lines.some((line) => line.book?.sourceId === 'clean'), false);
});

test('property: any set of bills decided across two months contributes each credit at most once', async () => {
  for (let mayMask = 0; mayMask < 8; mayMask += 1) {
    const documents = [aprilBill('a', 900), aprilBill('b', 1_800), aprilBill('c', 2_700)];
    const { service, claims } = desk(documents);

    for (const [index, document] of documents.entries()) {
      if ((mayMask & (1 << index)) !== 0) await accept(service, MAY, document.sourceId, `may-${mayMask}-${index}`);
    }
    const may = await service.workspace(owner, MAY);
    const juneBefore = await service.workspace(owner, JUNE);
    for (const [index, document] of documents.entries()) {
      assert.equal(
        juneBefore.lines.some((line) => line.book?.sourceId === document.sourceId),
        (mayMask & (1 << index)) === 0,
      );
    }
    for (const line of juneBefore.lines) {
      if (line.book !== null) await accept(service, JUNE, line.book.sourceId, `june-${mayMask}-${line.book.sourceId}`);
    }
    const june = await service.workspace(owner, JUNE);
    const claimedSources = [...may.lines, ...june.lines]
      .filter((line) => line.book !== null && (line.outcome === 'CLAIM_NOW' || line.outcome === 'CLAIM_AT_RISK'))
      .map((line) => line.book!.sourceId);

    assert.equal(claimedSources.length, new Set(claimedSources).size);
    assert.equal((await claims.listForCompany(SUNRISE_COMPANY)).length, 3);
    assert.equal((await service.workspace(owner, JULY)).lines.length, 0);
  }
});

test('an April bill still unclaimed after 30 November 2027 is time-barred in December', async () => {
  const { service } = desk([aprilBill('expired')]);
  const line = lineFor(await service.workspace(owner, taxPeriod('2027-12')), 'expired');

  assert.equal(line.lastClaimDate, '2027-11-30');
  assert.equal(line.outcome, 'TIME_BARRED');
  assert.equal(line.sentence['en-IN'], 'Credit on this bill had to be claimed by 30 November 2027.');
  assert.equal(totalTaxOf(line.claimable).minor, 0n);
});
