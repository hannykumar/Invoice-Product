/**
 * Issue #53 [X05] — the application, what is stopping it, and what the product does meanwhile.
 *
 *   npm run vehicle:access
 *   npm run vehicle:access -- --application   the dossier, as it would be sent
 *   npm run vehicle:access -- --sample        the synthetic authority's response, reviewed against #28
 *   npm run vehicle:access -- --fallback      the manual workflow, which is what runs today
 *
 * It exits non-zero while no authorised access exists, so the work that depends on it cannot be
 * quietly marked done. That is the honest state and it should be noisy.
 */
import { REQUESTED_FIELDS, DECLINED_FIELDS, personalDataFields } from './fields.ts';
import { reviewNecessity } from './necessity.ts';
import { CANDIDATES, disqualification, stillToAsk } from './providers.ts';
import { permittedUseTerms, RETENTION, reviewCaching } from './permitted-use.ts';
import { MANUAL_FALLBACK } from './fallback.ts';
import { reviewSampleResponse } from './sample-review.ts';
import { dossier, readyToSubmit, trackerReport } from './application.ts';
import { APPLICATIONS, WITHOUT_APPROVAL } from './state.ts';
import { SYNTHETIC_VAHAN_ROWS } from '../../../packages/transport/src/vehicle-record-adapters.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);
const flag = (name: string): boolean => process.argv.includes(name);

const TODAY = '2026-09-01';

if (flag('--fallback')) {
  heading('What happens with no authorised access, and when the provider is down');
  console.log(`  ${MANUAL_FALLBACK.when}\n`);
  for (const step of MANUAL_FALLBACK.steps) {
    console.log(`  ${step.order}. ${step.what['en-IN']}`);
    console.log(`     ${step.why}`);
  }
  console.log('\n  What this must never do:');
  for (const limit of MANUAL_FALLBACK.limits) console.log(`    · ${limit}`);
  process.exit(0);
}

if (flag('--application')) {
  heading('The application, as it would be sent');
  for (const entry of dossier()) {
    console.log(`  ${entry.question}`);
    console.log(`    ${entry.answer ?? '— nobody can answer this yet —'}`);
    console.log(`    (${entry.derivedFrom})\n`);
  }
  process.exit(0);
}

if (flag('--sample')) {
  heading('A provider response, reviewed against what #28 needs');
  console.log('  Run against the synthetic authority in #29, which returns everything it holds — including,');
  console.log('  on the scooter’s record, the chassis number and the owner’s address we never asked for.\n');
  const lorry = SYNTHETIC_VAHAN_ROWS.find((row) => row.rc_regn_no === 'KA01AB1234') ?? {};
  const scooter = SYNTHETIC_VAHAN_ROWS.find((row) => row.rc_regn_no === 'KA05MN9012') ?? {};
  for (const [number, row] of [['KA01AB1234', lorry], ['KA05MN9012', scooter]] as const) {
    const review = reviewSampleResponse('the synthetic authority', row, {
      registrationNumber: number,
      retrievedAt: `${TODAY}T04:30:00.000Z`,
    });
    console.log(`  ${number}: ${review.summary['en-IN']}`);
    if (review.declinedFieldsOffered.length > 0) {
      console.log(`    Offered and dropped at the boundary: ${review.declinedFieldsOffered.join(', ')}`);
    }
    for (const gap of review.gaps) console.log(`    · ${gap}`);
    console.log('');
  }
  process.exit(0);
}

heading('What we are asking the registering authority for');
console.log(`  ${REQUESTED_FIELDS.length} fields, taken from the allow-list the code already enforces — not a list typed out separately.\n`);
for (const request of REQUESTED_FIELDS) {
  console.log(`  ${request.field.padEnd(22)} ${request.plainName}${request.personalData ? '   [names a person]' : ''}`);
}
console.log(`\n  Deliberately not asked for: ${DECLINED_FIELDS.map((field) => field.describedAs).join('; ')}.`);
const personal = personalDataFields();
console.log(`  Fields naming a person: ${personal.length} (${personal.map((field) => `${field.field}, stored ${field.storedAs.toLowerCase().replace('_', ' ')}`).join('; ')}).`);

heading('Privacy minimisation, checked against the rules themselves');
const necessity = reviewNecessity(TODAY);
for (const finding of necessity.findings) {
  console.log(`  ${finding.verdict.padEnd(20)} ${finding.field}`);
  if (finding.verdict !== 'DECIDES_A_RULE') console.log(`                       ${finding.note}`);
}
console.log(`\n  ${necessity.summary['en-IN']}`);

heading('What we undertake to do with it');
for (const term of permittedUseTerms()) {
  console.log(`  · ${term.rule}`);
  console.log(`    Kept true by: ${term.enforcedBy}`);
}
const caching = reviewCaching(null);
console.log(`\n  Caching: ${caching.note['en-IN']}`);
console.log(`  Retention: ${RETENTION.auditYears} years. ${RETENTION.why}`);

heading('Who could answer, and what nobody has asked them');
for (const item of CANDIDATES) {
  const stopped = disqualification(item);
  console.log(`  ${item.route.padEnd(22)} ${item.name}${stopped === null ? '' : '  [disqualified]'}`);
  if (stopped !== null) console.log(`                         ${stopped}`);
}
const questions = stillToAsk();
console.log(`\n  ${questions.length} questions nobody has asked yet. The first five:`);
for (const item of questions.slice(0, 5)) console.log(`    · ${item.provider}: ${item.question}`);

heading('Where the application stands');
const tracker = trackerReport(APPLICATIONS, TODAY);
for (const record of tracker.records) {
  console.log(`  ${record.state.padEnd(24)} ${record.providerId}`);
  if (record.note !== null) console.log(`                           ${record.note}`);
}
console.log(`\n  ${tracker.summary['en-IN']}`);
if (tracker.problems.length > 0) {
  console.log('\n  Records whose state is not backed by evidence:');
  for (const problem of tracker.problems) console.log(`    · ${problem}`);
}

const readiness = readyToSubmit();
heading('Can it be sent?');
console.log(`  ${readiness.summary['en-IN']}`);
for (const blocker of readiness.blockers) console.log(`    · ${blocker}`);

heading('What the product does meanwhile');
for (const item of WITHOUT_APPROVAL.works) console.log(`  works    ${item}`);
for (const item of WITHOUT_APPROVAL.doesNot) console.log(`  does not ${item}`);
console.log(`\n  The fallback that carries this: ${MANUAL_FALLBACK.steps.length} steps, run with --fallback to read them.`);

if (!readiness.ready || tracker.approved.length === 0) process.exitCode = 1;
