/**
 * Issue #31 [E31] — a month of purchases compared with what the suppliers told the government.
 *
 *   npm run demo:itc
 *
 * Sunrise Hardware of Bengaluru bought from six suppliers in July 2026. Their accountant downloads
 * the GSTR-2B file, imports it, and finds that five of the six agree, one supplier has not filed at
 * all, and one has filed a smaller figure than the bill in the drawer.
 *
 * Everything below runs the real reader, the real matching, the real credit rules and the real
 * audit trail. Nothing here needs a credential, a network or a government connection: the file is
 * a file, which is the whole point of "file import first".
 */
import { formatINR, asId, fixedClock } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  InMemoryImportBatches, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks,
} from './adapters.ts';
import { ItcReconciliationService } from './service.ts';
import { DECCAN_LATE_FILING, SUNRISE_BOOKS, SUNRISE_COMPANY, SUNRISE_GSTR2B_FILE, SUNRISE_PERIOD } from './fixtures.ts';
import { ITC_PERMISSIONS, totalTaxOf, type ReconciliationLine } from './types.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

const clock = fixedClock('2026-08-14T10:00:00.000Z');
const books = new InMemoryPurchaseBooks();
books.add(...SUNRISE_BOOKS);
const records = new InMemoryPortalRecords();
const batches = new InMemoryImportBatches();
const decisions = new InMemoryItcDecisions();
const audit = new InMemoryAuditPort();

const service = new ItcReconciliationService({ books, records, batches, decisions, audit, clock });

const owner: ActorContext = {
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(ITC_PERMISSIONS),
};

const describe = (line: ReconciliationLine): void => {
  const name = line.book?.supplierName ?? line.portal?.supplierName ?? 'unknown supplier';
  const number = line.book?.number ?? line.portal?.number ?? '';
  console.log(`\n  ${name} · ${number}`);
  console.log(`    ${line.statusLabel['en-IN']} — ${line.outcomeLabel['en-IN']}`);
  console.log(`    ${line.sentence['en-IN']}`);
  for (const row of line.evidence.filter((entry) => entry.verdict === 'DIFFERS')) {
    console.log(`    · ${row.label['en-IN']}: yours ${row.ours ?? '—'}, theirs ${row.theirs ?? '—'}`);
  }
};

const run = async (): Promise<void> => {
  heading('1. Before the portal file is imported');
  const before = await service.workspace(owner, SUNRISE_PERIOD);
  console.log(before.sentence['en-IN']);
  console.log(`  ${(before.findings[0] as { message: { 'en-IN': string } }).message['en-IN']}`);

  heading('2. Importing the GSTR-2B file downloaded from the portal');
  const batch = await service.importFile(owner, {
    period: SUNRISE_PERIOD,
    content: SUNRISE_GSTR2B_FILE,
    fileName: 'GSTR2B_072026.json',
  });
  console.log(batch.sentence['en-IN']);
  const again = await service.importFile(owner, {
    period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE, fileName: 'GSTR2B_072026.json',
  });
  console.log(`Pressing import a second time: ${again.id === batch.id ? 'the same import, nothing doubled.' : 'a second import — this would be a bug.'}`);

  heading('3. The month, bill by bill');
  const workspace = await service.workspace(owner, SUNRISE_PERIOD);
  console.log(workspace.sentence['en-IN']);
  for (const line of workspace.lines) describe(line);

  heading('4. What goes on GSTR-3B');
  const linkage = workspace.returnLinkage;
  console.log(`  Ordinary purchases (box 4A(5)): ${formatINR(totalTaxOf(linkage.allOtherItc))}`);
  console.log(`  Credit given back (box 4B):     ${formatINR(totalTaxOf(linkage.reversedItc))}`);
  console.log(`  Held back, not on the return:   ${formatINR(totalTaxOf(workspace.heldBack))}`);
  console.log(`  ${linkage.caution['en-IN']}`);

  heading('5. The accountant answers the two bills that need an answer');
  // Mysore Papers filed ₹30,000 against a bill for ₹40,000. The accountant takes the credit on the
  // part the supplier did report and leaves the rest — so the claim is ₹5,400, not ₹7,200.
  const paper = workspace.lines.find((line) => line.book?.number === 'MP-9') as ReconciliationLine;
  const accepted = await service.decide(owner, {
    period: SUNRISE_PERIOD, lineKey: paper.key, kind: 'ACCEPT',
    reason: 'Rang Mysore Papers — they filed ₹30,000 by mistake and will amend it. Taking the smaller figure for now.',
    idempotencyKey: 'demo-paper-accept',
  });
  const paperNow = accepted.lines.find((line) => line.key === paper.key) as ReconciliationLine;
  console.log(`  Mysore Papers: ${paperNow.outcomeLabel['en-IN']}`);
  console.log(`  ${paperNow.sentence['en-IN']}`);
  const paint = workspace.lines.find((line) => line.book?.number === 'DC-556') as ReconciliationLine;
  await service.decide(owner, {
    period: SUNRISE_PERIOD, lineKey: paint.key, kind: 'PENDING',
    reason: 'Deccan Chemicals have not filed July yet.',
    idempotencyKey: 'demo-paint-pending',
  });
  const answered = await service.workspace(owner, SUNRISE_PERIOD);
  console.log(answered.sentence['en-IN']);

  heading('6. August: the late supplier files, and July is looked at again');
  await service.importFile(owner, {
    period: SUNRISE_PERIOD, content: DECCAN_LATE_FILING, fileName: 'GSTR2B_082026.json',
  });
  const after = await service.workspace(owner, SUNRISE_PERIOD);
  const paintNow = after.lines.find((line) => line.book?.number === 'DC-556') as ReconciliationLine;
  console.log(`Deccan Chemicals' bill: ${paintNow.statusLabel['en-IN']} — ${paintNow.outcomeLabel['en-IN']}`);
  console.log(`  ${paintNow.sentence['en-IN']}`);
  console.log(`  The accountant's note from July is still on the line: ${paintNow.decision === null ? 'no' : `"${paintNow.decision.reason}"`}`);
  console.log(`  ...and it is marked out of date, because the facts changed: ${paintNow.decisionStale ? 'yes' : 'no'}`);
  console.log(`\n${after.sentence['en-IN']}`);

  heading('7. The audit trail');
  for (const entry of audit.events) console.log(`  ${entry.at} · ${entry.action} · ${entry.summary}`);
};

await run();
