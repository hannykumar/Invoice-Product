/**
 * Issue #49 [X01] — what stands between us and a signed provider contract.
 *
 *   npm run vendor:readiness
 *
 * Exits non-zero when something blocking is outstanding, so this can gate a release later without
 * anybody having to remember to look.
 */
import { assess } from './readiness.ts';
import { DOCUMENT_LABELS, ENTITY_OPTIONS, VENDOR_LABELS } from './catalogue.ts';
import { CURRENT_STATE } from './state.ts';

const today = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const report = assess(CURRENT_STATE, today);

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

heading(`Company and vendor onboarding — as of ${report.asOf}`);
console.log(`  ${report.summary['en-IN']}`);

heading('The entity choice, still to be made with professional advice');
for (const option of ENTITY_OPTIONS) {
  console.log(`  ${option.name}`);
  console.log(`    For:     ${option.suitsUs['en-IN']}`);
  console.log(`    Against: ${option.against['en-IN']}`);
}

heading('The document pack');
for (const document of report.company.documents) {
  console.log(`  ${document.status.padEnd(12)} ${DOCUMENT_LABELS[document.kind]['en-IN']}`);
}

heading('What each provider is waiting for');
for (const vendor of report.vendors) {
  const mark = vendor.ready ? '✓' : '✗';
  console.log(`  ${mark} ${VENDOR_LABELS[vendor.vendor]['en-IN']}  —  blocks ${vendor.blocks.join(', ')}`);
  if (!vendor.ready) console.log(`      missing ${vendor.missing.length}: ${vendor.missing.map((kind) => DOCUMENT_LABELS[kind]['en-IN']).join('; ')}`);
}

heading('Findings');
const all = [...report.findings, ...report.vendors.flatMap((vendor) => vendor.findings)];
if (all.length === 0) console.log('  Nothing outstanding.');
for (const item of all) {
  console.log(`  [${item.level.padEnd(11)}] ${item.code}`);
  console.log(`     ${item.what['en-IN']}`);
  console.log(`     ${item.whatToDo['en-IN']}`);
  if (item.blocks.length > 0) console.log(`     Holds up: ${item.blocks.join(', ')}`);
}
console.log('');

if (!report.ready) {
  console.log('Not ready to sign with any provider yet. The list above is the work, in order.\n');
  process.exitCode = 1;
}
