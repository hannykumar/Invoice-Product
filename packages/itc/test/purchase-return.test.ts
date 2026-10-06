/**
 * Issue #249 — goods sent back to a supplier, across months, as the purchase check sees them.
 *
 *   bill      500 KGS at ₹64 = ₹32,000, IGST ₹5,760, in April
 *   returned  50 KGS = ₹3,200, IGST ₹576
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, fixedClock } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks,
} from '../src/adapters.ts';
import { bill, SUNRISE_COMPANY } from '../src/fixtures.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { ITC_PERMISSIONS, taxPeriod, totalTaxOf, type BookPurchaseDocument } from '../src/types.ts';

const APRIL = taxPeriod('2026-04');
const MAY = taxPeriod('2026-05');
const GSTIN = '27AAECS5678D1Z4';

const owner: ActorContext = {
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(ITC_PERMISSIONS),
};

const steel = (over: Partial<Parameters<typeof bill>[0]> = {}) =>
  bill({ id: 'srs-101', supplierName: 'Shree Ram Steels', gstin: GSTIN, number: 'SRS-101', date: '2026-04-10', taxable: 32_000, igst: 5_760, ...over });

const returned = (date: string, over: Partial<Parameters<typeof bill>[0]> = {}): BookPurchaseDocument => ({
  ...bill({ id: 'dn-1', supplierName: 'Shree Ram Steels', gstin: GSTIN, number: 'DN/26-27/0000001', date, taxable: 3_200, igst: 576, kind: 'CREDIT_NOTE', ...over }),
  sourceKind: 'purchase_return',
  original: { sourceKind: 'purchase_bill', sourceId: 'srs-101', number: 'SRS-101', date: '2026-04-10' as never },
  goodsReturned: '50 KGS',
  ourReference: 'DN/26-27/0000001',
  awaitingSupplierNote: true,
});

const desk = (documents: readonly BookPurchaseDocument[]) => {
  const books = new InMemoryPurchaseBooks();
  books.add(...documents);
  let id = 0;
  const service = new ItcReconciliationService({
    books, claims: new InMemoryItcClaims(), records: new InMemoryPortalRecords(), batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(), audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-05-20T10:00:00.000Z'), idFactory: () => `id-${++id}`,
  });
  return service;
};

const typeBill = (service: ItcReconciliationService, period = APRIL) => service.addTypedRecord(owner, {
  period,
  record: {
    supplierGstin: GSTIN, supplierName: 'Shree Ram Steels', kind: 'INVOICE', number: 'SRS-101', documentDate: '2026-04-10',
    taxableValue: '32000', cgst: '0', sgst: '0', igst: '5760', invoiceValue: '37760', itcAvailableOnPortal: 'Y',
  },
});

test('a bill claimed in April and goods sent back in May: ₹576 comes off May, once', async () => {
  const service = desk([steel(), returned('2026-05-06')]);
  await typeBill(service);
  await service.claimPeriod(owner, APRIL);
  const may = await service.workspace(owner, MAY);
  assert.equal(totalTaxOf(may.claimable).minor, -57_600n, 'April took ₹5,760; May gives ₹576 back');
  // Issue #286 — it comes off 4(A)(5), as GSTR-2B nets it.
  assert.equal(totalTaxOf(may.returnLinkage.allOtherItc).minor, -57_600n);
  await service.claimPeriod(owner, MAY);
  const june = await service.workspace(owner, taxPeriod('2026-06'));
  assert.equal(totalTaxOf(june.returnLinkage.allOtherItc).minor, 0n, 'reduced once, not again in June');
});

test('the return waits with a bill whose credit is held back, and follows it onto the return', async () => {
  const service = desk([steel(), returned('2026-04-20')]);
  const april = await service.workspace(owner, APRIL);
  assert.equal(totalTaxOf(april.claimable).minor, 0n, 'no credit taken, so none given back');
  assert.equal(totalTaxOf(april.heldBack).minor, 518_400n, '₹5,760 − ₹576 is what is waiting');
  assert.match(april.sentence['en-IN'], /held back on 1 bill that still needs an answer/);
  await service.claimPeriod(owner, APRIL);
  await typeBill(service, MAY);
  const may = await service.workspace(owner, MAY);
  assert.equal(totalTaxOf(may.claimable).minor, 518_400n, 'the bill and its return go on May together');
  assert.deepEqual(may.returnLinkage.booksExplanation && totalTaxOf(may.returnLinkage.booksExplanation.fromEarlierMonths).minor, 518_400n);
});

test('reverse-charge tax owed belongs to the month of the bill, and a return lowers it', async () => {
  const service = desk([
    steel({ reverseCharge: true }),
    { ...returned('2026-05-06', { reverseCharge: true }) },
  ]);
  const april = await service.workspace(owner, APRIL);
  assert.equal(totalTaxOf(april.returnLinkage.reverseChargeLiability).minor, 576_000n);
  const may = await service.workspace(owner, MAY);
  assert.equal(totalTaxOf(may.returnLinkage.reverseChargeLiability).minor, -57_600n,
    'April\'s bill is not owed again in May; May carries only the ₹576 coming off');
});
