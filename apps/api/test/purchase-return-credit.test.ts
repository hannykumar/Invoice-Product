/**
 * Issue #249 — goods sent back to a supplier take their GST credit off the return.
 *
 * The ledger already reduced input GST when a purchase return was posted, but the purchase check that
 * feeds GSTR-3B read only purchase bills, so the return kept claiming the full credit. The worked
 * numbers, through the same application the screens call:
 *
 *   bought   500 KGS TMT at ₹64 from Shree Ram Steels (another state) = ₹32,000, IGST 18% = ₹5,760
 *   sent back 50 KGS = ₹3,200, IGST 18% = ₹576
 *   credit   ₹5,760 − ₹576 = ₹5,184, the same as the ledger's input GST for the month
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_OWNER_PERMISSIONS, SYNTHETIC_PLATFORM_COMPANIES } from '../../../packages/platform/src/seed.ts';
import type { RequestContext } from '../../../packages/platform/src/index.ts';
import { apiRuntime } from '../src/runtime.ts';
import { appToday, useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const DATE = appToday();
const MONTH = DATE.slice(0, 7);
const SHREE_RAM = 'sampoorna:party:supplier';
const SHREE_RAM_GSTIN = '27AAECS5678D1Z4';

// The owner of the synthetic company, as the running app would authenticate them. No sign-in is
// needed: the test talks to the same application object the endpoints do.
const company = SYNTHETIC_PLATFORM_COMPANIES[0];
const context: RequestContext = {
  companyId: company.companyId, branchId: company.branchId, actorId: company.userId,
  sessionId: 'purchase-return-credit-test', permissions: new Set(PRODUCT_OWNER_PERMISSIONS),
};
const runtime = apiRuntime();
const actor = runtime.actor(context);
const app = () => runtime.application(context);

const itcLine = (workspace: any, number: string) => workspace.lines.find((line: any) => line.number === number);
const warnings = (workspace: any) => [
  ...workspace.findings,
  ...workspace.lines.flatMap((line: any) => line.findings),
].filter((finding: any) => finding.severity !== 'INFORMATION' && finding.code !== 'ITC_NO_PORTAL_DATA');

const bought = (async () => {
  const application = await app();
  const bill = await application.recordPurchase(actor, {
    supplierId: SHREE_RAM, reference: 'SRS-101', date: DATE,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }],
  });
  const documents = await application.returnDocuments(actor);
  const document: any = documents.documents.find((entry: any) => entry.kind === 'PURCHASE_RETURN' && entry.number === 'SRS-101');
  assert.ok(document, JSON.stringify(bill));
  const recorded = await application.recordReturn(actor, {
    kind: 'PURCHASE_RETURN', documentId: document.id, lineId: document.lines[0].id,
    quantity: '50', unit: 'KGS', disposition: 'ACCEPTED', date: DATE, reference: 'srs-back-50',
    reason: 'Bent bars',
    // The screen's date field starts at today; an empty number means the note has not come yet.
    supplierNoteNumber: '', supplierNoteDate: DATE,
  });
  return { application, note: recorded.note };
})();

test('with no government rows yet, the return waits with its bill: ₹5,184 held back, nothing claimed', async () => {
  const { application } = await bought;
  const workspace = await application.itcWorkspace(actor, { period: MONTH });
  assert.equal(workspace.claimable, 0);
  assert.equal(workspace.heldBack, 5184, '₹5,760 on the bill less ₹576 sent back');
  const note: any = workspace.lines.find((line: any) => line.kind === 'CREDIT_NOTE');
  assert.equal(note.againstBill, 'SRS-101');
  assert.equal(note.awaitingSupplierNote, true);
  assert.equal(note.heldBack, -576);
  assert.match(note.sentence, /50 KGS back to Shree Ram Steels .* against bill SRS-101\. ₹576\.00 of credit comes off that bill/);
});

test('the supplier\'s bill in 2B and no credit note yet: ₹576 comes off this month, and the return says so', async () => {
  const { application } = await bought;
  const workspace = await application.addTypedItcRecord(actor, {
    period: MONTH, gstin: SHREE_RAM_GSTIN, supplierName: 'Shree Ram Steels', kind: 'INVOICE', number: 'SRS-101',
    date: DATE, taxableValue: '32000', igst: '5760', invoiceValue: '37760',
  });
  assert.equal(workspace.claimable, 5184);
  assert.match(workspace.summary, /₹5,184\.00 of GST on your purchases is safe to claim this month/);
  const note: any = workspace.lines.find((line: any) => line.kind === 'CREDIT_NOTE');
  assert.equal(note.outcome, 'CLAIM_NOW');
  assert.equal(note.claimable, 576);
  assert.equal(note.outcomeLabel, "Comes off this month's credit");
  assert.equal(
    note.sentence,
    'You sent 50 KGS back to Shree Ram Steels Private Limited against bill SRS-101. ₹576.00 of credit comes off this month. Ask them for their credit note.',
  );
  // Issue #286 — the ₹576 comes off 4(A)(5), as GSTR-2B nets it, not through 4(B).
  assert.equal(workspace.returnLinkage.allOtherItc, 5184);
  assert.equal(workspace.returnLinkage.reversedItc, 0);

  const gst = await application.gstReturnWorkspace(actor, { period: MONTH });
  const igst: any = gst.gstr3b.heads.find((head: any) => head.head === 'IGST');
  assert.equal(igst.credit, 5184);
  assert.equal(gst.purchaseReconciliation!.agrees, true);
  assert.equal(gst.purchaseReconciliation!.onTheReturn, 5184);
  assert.equal(gst.purchaseReconciliation!.inTheBooks, 5184, 'the ledger: ₹5,760 in, ₹576 back out');
  assert.equal(gst.findings.some((finding: any) => finding.code === 'GSTR_CREDIT_ABOVE_BOOKS'), false);
});

test('the supplier\'s credit note, added later and typed from the portal, matches: ₹5,184 and no warning', async () => {
  const { application, note } = await bought;
  await assert.rejects(
    application.recordSupplierCreditNote(actor, { noteId: note.id, supplierNoteNumber: 'SRS-CREDIT-NOTE-0001', supplierNoteDate: DATE }),
    (error: any) => error.code === 'RETURN_SUPPLIER_NOTE_NUMBER_TOO_LONG',
  );
  const added = await application.recordSupplierCreditNote(actor, { noteId: note.id, supplierNoteNumber: 'SRS-CN-1', supplierNoteDate: DATE });
  assert.equal(added.note.supplierCreditNote?.number, 'SRS-CN-1');
  const workspace = await application.addTypedItcRecord(actor, {
    period: MONTH, gstin: SHREE_RAM_GSTIN, supplierName: 'Shree Ram Steels', kind: 'CREDIT_NOTE', number: 'SRS-CN-1',
    date: DATE, taxableValue: '3200', igst: '576', invoiceValue: '3776',
  });
  assert.equal(workspace.claimable, 5184);
  const matched = itcLine(workspace, 'SRS-CN-1');
  assert.equal(matched.status, 'EXACT');
  assert.equal(matched.claimable, 576, 'reduced once, not twice');
  assert.deepEqual(warnings(workspace), []);
  const gst = await application.gstReturnWorkspace(actor, { period: MONTH });
  assert.equal((gst.gstr3b.heads.find((head: any) => head.head === 'IGST') as any).credit, 5184);
  assert.equal(gst.purchaseReconciliation!.agrees, true);
});

test('a supplier credit note in 2B with no return in the books keeps its warning and names the bill', async () => {
  const { application } = await bought;
  const workspace = await application.addTypedItcRecord(actor, {
    period: MONTH, gstin: SHREE_RAM_GSTIN, supplierName: 'Shree Ram Steels', kind: 'CREDIT_NOTE', number: 'SRS-CN-9',
    date: DATE, taxableValue: '640', igst: '115.20', invoiceValue: '755.20',
  });
  const line = itcLine(workspace, 'SRS-CN-9');
  assert.equal(line.status, 'ONLY_ON_PORTAL');
  const warning = line.findings.find((finding: any) => finding.code === 'ITC_ONLY_ON_PORTAL');
  assert.match(warning.message, /credit note SRS-CN-9 .* no return against it\. It will be against their bill SRS-101\./);
  assert.equal(workspace.claimable, 5184, 'nothing is taken off for a note we cannot explain');
});
