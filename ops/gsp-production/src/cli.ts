/**
 * Issue #51 [X03] — what stands between this product and acting for a real taxpayer.
 *
 *   npm run gsp:golive          the gate, and the drills
 *   npm run gsp:golive --drills only the drills
 *
 * Exits non-zero while production access is not available, so this can gate a release without
 * anybody having to remember to look — and so nobody can point the product at the live portal on
 * the strength of a green test run alone.
 */
import { PRODUCTION_ACCESS } from '@invoice/gst';
import { runAllDrills } from './drills.ts';
import { assess } from './readiness.ts';
import { CURRENT_STATE } from './state.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

const today = process.argv.find((argument) => /^\d{4}-\d{2}-\d{2}$/.test(argument)) ?? new Date().toISOString().slice(0, 10);
const report = assess(CURRENT_STATE, today);

heading(`Government production access — as of ${report.asOf}`);
console.log(`  ${report.summary['en-IN']}`);
console.log(`  Wired to: ${report.register.sandboxProvider ?? 'nothing'} (${report.register.environment}).`);
console.log(`  The connector's own switch: production access is ${PRODUCTION_ACCESS.active ? 'ACTIVE' : 'NOT active'}.`);

heading('The standing decision this all sits under');
for (const line of report.register.standingDecision.split('. ').filter((part) => part.trim() !== '')) {
  console.log(`  ${line.trim().replace(/\.?$/, '.')}`);
}

heading('The go-live conditions, in the order they have to happen');
for (const step of report.steps) {
  const mark = step.state === 'DONE' ? '✓' : step.state === 'ON_HOLD_BY_DECISION' ? '—' : '✗';
  const who = step.answerable === 'PERSON' ? 'a person' : step.answerable === 'PROVIDER' ? 'the provider' : 'this repository';
  console.log(`  ${mark} ${step.label['en-IN']}`);
  console.log(`      ${step.state.padEnd(20)} needs ${who}${step.evidence === null ? '' : `  ·  ${step.evidence}`}`);
}

heading('Findings');
for (const item of report.findings) {
  console.log(`  [${item.level.padEnd(11)}] ${item.code}`);
  console.log(`     ${item.what['en-IN']}`);
  console.log(`     ${item.whatToDo['en-IN']}`);
}
if (report.findings.length === 0) console.log('  Nothing outstanding.');

heading('Drills — run now, against the sandbox, with no production credential');
for (const drill of await runAllDrills()) {
  console.log(`  ${drill.passed ? '✓' : '✗'} ${drill.drill}`);
  for (const step of drill.steps) {
    console.log(`      ${step.passed ? '·' : '!'} ${step.name}`);
    console.log(`        ${step.evidence}`);
  }
}

console.log('');
if (!report.productionAllowed) {
  console.log('Production access is not available, and the product cannot call the live portal.');
  console.log('The list above is the work, in order. Read docs/compliance/x03-gsp-production-onboarding.md first.\n');
  process.exitCode = 1;
}
