/**
 * Issue #30 [E30] — preparing a month's GST returns, start to finish.
 *
 *   npm run demo:gst-returns
 *
 * Sunrise Soap Works of Pune close their July books. Four bills and one credit note, which is a
 * real month for a business this size. Everything below comes from the real classifier, the real
 * validations, the real reconciliation against the ledger figures and the real audit trail; only
 * the licensed intermediary at the far end is synthetic, so nothing here needs a credential, a
 * network or a GSP agreement.
 */
import { formatINR, fixedClock, asId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { InMemoryAuditPort } from '@invoice/ledger';
import { GstReturnService } from './service.ts';
import {
  InMemoryBookTax, InMemoryInwardTax, InMemoryOutwardSupplies, InMemoryPeriodLocks,
  InMemoryReturnPreparations, SyntheticGspChannel,
} from './adapters.ts';
import { describeHead } from './gstr3b.ts';
import { describeRow } from './gstr1.ts';
import {
  SUNRISE_BOOK_TAX, SUNRISE_COMPANY, SUNRISE_DOCUMENTS, SUNRISE_GSTIN, SUNRISE_INWARD,
  SUNRISE_PERIOD, SUNRISE_STATE, UNRESOLVED_INVOICE,
} from './fixtures.ts';
import { GST_RETURN_PERMISSIONS, GSTR1_SECTION_NAMES, totalTaxOf } from './types.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

const clock = fixedClock('2026-08-11T09:30:00.000Z');
const outward = new InMemoryOutwardSupplies();
outward.add(...SUNRISE_DOCUMENTS, UNRESOLVED_INVOICE);
const inward = new InMemoryInwardTax();
inward.set(SUNRISE_COMPANY, SUNRISE_INWARD);
// The books hold all six documents, INV-005 included: the bill was posted in the shop like any
// other. It is only the *return* that cannot place it, because nobody has said whether that
// customer has a GST number. So the ledger and the return start out disagreeing by exactly that
// bill, which is the ordinary way a month looks before somebody sits down with the exceptions.
const books = new InMemoryBookTax();
books.set(SUNRISE_COMPANY, {
  ...SUNRISE_BOOK_TAX,
  cgst: { currency: 'INR', minor: SUNRISE_BOOK_TAX.cgst.minor + 90_000n },
  sgst: { currency: 'INR', minor: SUNRISE_BOOK_TAX.sgst.minor + 90_000n },
  contributions: [
    ...SUNRISE_BOOK_TAX.contributions,
    {
      sourceKind: UNRESOLVED_INVOICE.sourceKind, sourceId: UNRESOLVED_INVOICE.sourceId,
      number: UNRESOLVED_INVOICE.number, date: UNRESOLVED_INVOICE.documentDate,
      voucherId: UNRESOLVED_INVOICE.voucherId, amount: UNRESOLVED_INVOICE.invoiceValue,
    },
  ],
});
const audit = new InMemoryAuditPort();
const gsp = new SyntheticGspChannel(() => clock.now().toISOString());

const service = new GstReturnService({
  outward,
  inward,
  books,
  repository: new InMemoryReturnPreparations(),
  audit,
  clock,
  government: gsp,
  periods: new InMemoryPeriodLocks(),
});

const owner: ActorContext = {
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(GST_RETURN_PERMISSIONS),
};

const input = { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE };

heading('1. What July looks like before anything is decided');
const first = await service.prepare(owner, { ...input, idempotencyKey: 'july-2026' });
console.log(`  ${first.sentence['en-IN']}`);
console.log(`  Status: ${first.stateLabel['en-IN']}`);
for (const section of first.gstr1.sections) {
  console.log(`\n  ${GSTR1_SECTION_NAMES[section.id]['en-IN']} (${section.id})`);
  console.log(`    ${section.sentence['en-IN']}`);
  for (const row of section.rows) {
    console.log(`      ${describeRow(row).padEnd(34)} ${formatINR(row.amounts.taxableValue).padStart(14)} + ${formatINR(totalTaxOf(row.amounts))} tax`);
  }
}

heading('2. The one bill nobody can file yet');
for (const exception of first.exceptions) {
  console.log(`  ${exception.document.number} — ${exception.document.partyName}, ${formatINR(exception.document.invoiceValue)}`);
  for (const finding of exception.findings) {
    console.log(`    ${finding.message['en-IN']}`);
    console.log(`    What to do: ${finding.whatToDo['en-IN']}`);
  }
}
console.log('\n  Nothing was guessed and nothing was left out quietly. The bill is off the return and on this list.');

heading('3. Why each bill went where it did');
for (const reason of first.reasons) {
  const document = SUNRISE_DOCUMENTS.find((entry) => entry.sourceId === reason.sourceId);
  console.log(`  ${(document?.number ?? reason.sourceId).padEnd(9)} → ${reason.section.padEnd(6)} ${reason.reason['en-IN']}`);
}

heading('4. Does the return agree with the books?');
console.log(`  ${first.reconciliation.sentence['en-IN']}`);
for (const head of first.reconciliation.heads) {
  console.log(`    ${head.head.padEnd(5)} return ${formatINR(head.onTheReturn).padStart(12)}   books ${formatINR(head.inTheBooks).padStart(12)}   ${head.agrees ? 'agrees' : 'DOES NOT AGREE'}`);
}
for (const finding of first.reconciliation.findings) {
  console.log(`\n    ${finding.message['en-IN']}`);
  console.log(`    ${finding.whatToDo['en-IN']}`);
}

heading('5. Every figure traces back to a bill');
const b2b = first.gstr1.sections.find((section) => section.id === 'B2B');
for (const source of service.sourcesOf(first, 'B2B')) {
  console.log(`  ${source.number.padEnd(9)} ${source.date}  ${formatINR(source.amount).padStart(13)}  ledger voucher ${source.voucherId ?? '—'}`);
}
console.log(`  That is the whole of "${b2b?.name['en-IN']}" opened up. Nothing on the return is a number without a bill under it.`);

heading('6. The short return that decides the money');
console.log(`  ${first.gstr3b.sentence['en-IN']}`);
for (const line of first.gstr3b.outward) {
  console.log(`    ${line.boxId.padEnd(7)} ${line.label['en-IN'].padEnd(52)} ${formatINR(line.amounts.taxableValue).padStart(14)}`);
}
console.log();
for (const head of first.gstr3b.heads) {
  console.log(`    ${describeHead(head)['en-IN']}`);
}
console.log(`\n  ${first.gstr3b.caution['en-IN']}`);

heading('7. Somebody answers the question, and the month can be approved');
outward.replace('inv-005', { ...UNRESOLVED_INVOICE, unregisteredConfirmed: true });
const answered = await service.workspace(owner, input);
console.log(`  ${answered.sentence['en-IN']}`);
console.log(`  Waiting on a decision: ${answered.exceptions.length}. May be approved: ${answered.mayApprove ? 'yes' : 'no'}.`);

heading('8. Approving it, and then the books move underneath');
const approved = await service.approve(owner, { ...input, note: 'Checked against the sales register.' });
console.log(`  Approved by ${approved.preparation?.approval?.approvedBy} at ${approved.preparation?.approval?.approvedAt}`);
console.log(`  Fingerprint ${approved.preparation?.approval?.fingerprint.slice(0, 24)}…`);
console.log(`  Taxable value as approved: ${formatINR(approved.gstr1.totals.taxableValue)}`);

outward.add({ ...SUNRISE_DOCUMENTS[1]!, sourceId: 'inv-007', number: 'INV-007', voucherId: 'vch-inv-007' });
const afterwards = await service.workspace(owner, input);
console.log(`\n  Somebody raises another July bill after the approval.`);
console.log(`  ${afterwards.drift?.message['en-IN']}`);
console.log(`  Taxable value still shown: ${formatINR(afterwards.gstr1.totals.taxableValue)} — the approved figures did not move.`);

heading('9. The file a shop with no GSP uploads by hand');
const file = await service.exportFile(owner, { ...input, returnType: 'GSTR1' });
console.log(`  ${file.fileName}`);
console.log(`  ${file.sentence['en-IN']}`);
const preview = JSON.stringify(file.payload, null, 2).split('\n').slice(0, 22);
for (const line of preview) console.log(`    ${line}`);
console.log('    …');

heading('10. And, for a business that has a licensed intermediary');
gsp.willTimeOut();
const timedOut = await service.submit(owner, { ...input, returnType: 'GSTR1' });
console.log(`  First attempt timed out: ${timedOut.submission?.message}`);
console.log(`  Status: ${timedOut.state} — not "failed", because we do not know that it failed.`);
gsp.willAccept();
const filed = await service.submit(owner, { ...input, returnType: 'GSTR1' });
console.log(`  Second attempt: ${filed.submission?.message}`);
console.log(`  The intermediary has ${gsp.filings().length} filing on record, not two. A retry is the same return, not another one.`);

heading('11. What the audit trail kept');
for (const event of audit.events) {
  console.log(`  ${event.at}  ${event.action.padEnd(22)} ${event.summary}`);
}
console.log('\n  Actor, moment, and what changed — and not one line of the filing payload.');
