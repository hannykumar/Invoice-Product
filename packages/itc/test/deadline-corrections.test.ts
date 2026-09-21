/**
 * Two defects found in the #192 work after it was merged, each one a figure a business acts on.
 *
 * Reverting either fix makes these fail:
 *
 *  1. Section 16(4) was being applied to a supplier's **credit note**. The section covers credit a
 *     business *takes* — "in respect of any invoice or debit note". A credit note does the
 *     opposite: the supplier took goods back, so the tax comes off and the business gives that
 *     credit back. Barring an old one dropped the repayment and the return over-claimed by its tax.
 *  2. Credit barred by section 16(4) was counted in the month's **held back** figure, under a
 *     caution telling the business those amounts "come back on the month they are settled". Barred
 *     credit comes back on no month.
 *
 * Each bill below sits in its own month, as the books hold it, and reaches the December 2026
 * workspace the way a real unclaimed bill does: carried forward by #213.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, fixedClock, isoDate, type IsoDate } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords,
  InMemoryPurchaseBooks,
} from '../src/adapters.ts';
import { hasClaimDeadline } from '../src/deadline.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { SUNRISE_COMPANY, bill } from '../src/fixtures.ts';
import { ITC_PERMISSIONS, taxPeriod, totalTaxOf, type BookPurchaseDocument, type ItcWorkspace } from '../src/types.ts';

const SUPPLIER_GSTIN = '07AAFCB5566R1Z2';

const owner: ActorContext = {
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(ITC_PERMISSIONS),
};

/** One month's workspace, from the books given and whatever the supplier reported. */
const workspaceFor = async (
  books: readonly BookPurchaseDocument[],
  period: string,
  reported: readonly { readonly number: string; readonly date: string; readonly kind: 'INVOICE' | 'CREDIT_NOTE'; readonly taxable: string; readonly igst: string }[] = [],
): Promise<ItcWorkspace> => {
  const store = new InMemoryPurchaseBooks();
  store.add(...books);
  let counter = 0;
  const service = new ItcReconciliationService({
    books: store,
    records: new InMemoryPortalRecords(),
    batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(),
    claims: new InMemoryItcClaims(),
    audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-12-05T10:00:00.000Z'),
    idFactory: () => `id-${++counter}`,
  });
  for (const row of reported) {
    await service.addTypedRecord(owner, {
      period: taxPeriod(period),
      record: {
        supplierGstin: SUPPLIER_GSTIN, supplierName: 'Blessing Export', kind: row.kind,
        number: row.number, documentDate: row.date.split('-').reverse().join('-'),
        taxableValue: row.taxable, cgst: '0', sgst: '0', igst: row.igst, cess: '0',
        invoiceValue: String(Number(row.taxable) + Number(row.igst)), itcAvailableOnPortal: 'Y',
      },
    });
  }
  return service.workspace(owner, taxPeriod(period));
};

/** A supplier's credit note: ₹20,000 of goods taken back, so ₹3,600 of GST comes off the claim. */
const creditNote = (date: string): BookPurchaseDocument => bill({
  id: 'note-blessing', supplierName: 'Blessing Export', gstin: SUPPLIER_GSTIN,
  number: 'BE/CN/07', date, taxable: 20_000, igst: 3_600, kind: 'CREDIT_NOTE',
});

// ------------------------------------------------------ 1: the deadline runs one way only

test('section 16(4) does not reach a supplier’s credit note, whatever year it is from', () => {
  assert.equal(hasClaimDeadline('INVOICE'), true);
  assert.equal(hasClaimDeadline('DEBIT_NOTE'), true, 'a debit note adds to credit, so it has a deadline');
  assert.equal(hasClaimDeadline('CREDIT_NOTE'), false, 'a credit note gives credit back, so it has none');
});

test('an old credit note still gives its credit back, instead of being barred and quietly dropped', async () => {
  const reported = [{ number: 'BE/CN/07', date: '2026-03-13', kind: 'CREDIT_NOTE' as const, taxable: '20000', igst: '3600' }];
  // 13 March 2026 is in 2025-26, whose 30 November has long gone by the December 2026 return.
  const workspace = await workspaceFor([creditNote('2026-03-13')], '2026-12', reported);
  const line = workspace.lines[0];
  assert.ok(line !== undefined);

  assert.notEqual(line.outcome, 'TIME_BARRED', 'a credit note is never time-barred');
  assert.equal(line.lastClaimDate, null, 'and it carries no claim deadline to show');
  // ₹3,600 goes back to the government. Before the fix this was ₹0, and the return kept the money.
  assert.equal(totalTaxOf(workspace.returnLinkage.reversedItc).minor, 3_600_00n);
  assert.equal(totalTaxOf(workspace.claimable).minor, -3_600_00n);
});

test('a supplier’s invoice from the same old year is still barred, so the fix is not a blanket one', async () => {
  const oldInvoice = bill({
    id: 'bill-blessing', supplierName: 'Blessing Export', gstin: SUPPLIER_GSTIN,
    number: 'BE/DL/25-26/0139', date: '2026-03-13', taxable: 50_000, igst: 9_000,
  });
  const line = (await workspaceFor([oldInvoice], '2026-12')).lines[0];
  assert.equal(line?.outcome, 'TIME_BARRED');
  assert.equal(line?.lastClaimDate, '2026-11-30');
});

// ------------------------------------- 2: gone money is never described as money that returns

test('barred credit is kept out of held back, and the caution does not promise it comes back', async () => {
  const oldInvoice = bill({
    id: 'bill-blessing', supplierName: 'Blessing Export', gstin: SUPPLIER_GSTIN,
    number: 'BE/DL/25-26/0139', date: '2026-03-13', taxable: 50_000, igst: 9_000,
  });
  const workspace = await workspaceFor([oldInvoice], '2026-12');

  assert.equal(totalTaxOf(workspace.timeBarred).minor, 9_000_00n, 'it has its own figure');
  assert.equal(totalTaxOf(workspace.heldBack).minor, 0n, 'and it is not in the held-back one');
  const caution = workspace.returnLinkage.caution['en-IN'];
  assert.ok(!caution.includes('They are not lost'), 'this money is lost, and the caution must not say otherwise');
  assert.match(caution, /does not come back on any month/);
});

test('a month with both kinds names them separately rather than adding them together', async () => {
  const barred = bill({
    id: 'bill-old', supplierName: 'Blessing Export', gstin: SUPPLIER_GSTIN,
    number: 'BE/DL/25-26/0139', date: '2026-03-13', taxable: 50_000, igst: 9_000,
  });
  // A December bill the supplier has simply not filed yet: waiting, not lost.
  const waiting = bill({
    id: 'bill-new', supplierName: 'Blessing Export', gstin: SUPPLIER_GSTIN,
    number: 'BE/DL/26-27/0450', date: '2026-12-02', taxable: 10_000, igst: 1_800,
  });
  const workspace = await workspaceFor([barred, waiting], '2026-12');

  assert.equal(totalTaxOf(workspace.heldBack).minor, 1_800_00n, 'only the one that comes back');
  assert.equal(totalTaxOf(workspace.timeBarred).minor, 9_000_00n, 'only the one that does not');
  const caution = workspace.returnLinkage.caution['en-IN'];
  assert.match(caution, /₹1,800\.00 of GST on your purchases is deliberately not in this figure/);
  assert.match(caution, /A further ₹9,000\.00 is not in it either/);
});

test('the per-line figure is untouched, so a line still says where its own money went', async () => {
  const oldInvoice = bill({
    id: 'bill-blessing', supplierName: 'Blessing Export', gstin: SUPPLIER_GSTIN,
    number: 'BE/DL/25-26/0139', date: '2026-03-13', taxable: 50_000, igst: 9_000,
  });
  const line = (await workspaceFor([oldInvoice], '2026-12')).lines[0];
  assert.equal(totalTaxOf(line!.heldBack).minor, 9_000_00n);
  assert.equal(totalTaxOf(line!.claimable).minor, 0n);
  assert.equal(line!.lastClaimDate, isoDate('2026-11-30') as IsoDate);
});
