/**
 * Issue #52 [X04] — the comparison, the recommendation and the cost curve.
 *
 *   npm run bank:route
 *
 * It also runs the conformance harness against the one sandbox we have today — #24's synthetic
 * provider — so the harness itself is proved to work before a real provider is judged by it.
 */
import { SyntheticBankFeedProvider } from '@invoice/bank-feeds';
import { CANDIDATES } from './candidates.ts';
import { CRITERIA } from './criteria.ts';
import { runConformance } from './conformance.ts';
import { marginAgainstPlan, monthlyCost } from './cost.ts';
import { recommend } from './scoring.ts';
import type { CostShape } from './model.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);
const rupees = (paise: bigint): string => `₹${(Number(paise) / 100).toFixed(2)}`;

heading('What the comparison weighs, and by how much');
for (const criterion of CRITERIA) {
  console.log(`  ${String(criterion.weight).padStart(3)}  ${criterion.label['en-IN']}${criterion.essential ? '  (essential)' : ''}`);
  console.log(`       ${criterion.why}`);
}

const report = recommend(CANDIDATES, '2026-08-31');

heading('The routes');
for (const score of report.scores) {
  const verdict = score.score === null ? score.verdict : `${score.verdict} (${score.score}/100)`;
  console.log(`  ${verdict.padEnd(26)} ${score.candidate.name}`);
  console.log(`       ${score.reason['en-IN']}`);
}

heading('Recommendation');
console.log(`  ${report.summary['en-IN']}`);
if (report.deferral !== null) {
  console.log(`  ${report.deferral.why['en-IN']}`);
  for (const question of report.deferral.toAsk) console.log(`    · ${question}`);
} else if (report.chosen !== null) {
  console.log(`  Chosen: ${report.chosen.candidate.name}`);
  console.log(`  ${report.chosen.candidate.summary['en-IN']}`);
}

heading('Still to be asked, before any of the live-feed routes can be scored');
for (const candidate of CANDIDATES.filter((item) => item.openQuestions.length > 0)) {
  console.log(`  ${candidate.name}`);
  for (const question of candidate.openQuestions) console.log(`    · ${question}`);
}

heading('The cost model, run on an illustrative quotation');
// Not a quotation from anybody: numbers chosen to show the shape of the arithmetic and where the
// line falls. Replace with a real one and re-run before deciding anything.
const illustrative: CostShape = {
  monthlyPlatformFeePaise: 25_000_00n,
  perConnectionPaise: 40_00n,
  perSyncPaise: 20n,
  oneOffPaise: 150_000_00n,
};
console.log('  Illustrative only — no provider supplied these. Shown to demonstrate where the line falls.\n');
for (const connections of [100, 500, 2_000, 10_000]) {
  const cost = monthlyCost(illustrative, { connections, syncsPerConnectionPerMonth: 30, amortiseOneOffOverMonths: 24 });
  const margin = marginAgainstPlan(cost, 499_00n);
  console.log(`  ${String(connections).padStart(6)} businesses  total ${rupees(cost.total).padStart(14)}  per business ${rupees(cost.perConnection).padStart(10)}  ${margin.sustainable ? 'sustainable' : 'LOSS-MAKING'}`);
}
console.log(`\n  ${marginAgainstPlan(monthlyCost(illustrative, { connections: 500, syncsPerConnectionPerMonth: 30, amortiseOneOffOverMonths: 24 }), 499_00n).sentence['en-IN']}`);

heading('Conformance: the one sandbox we have today');
const sandbox = new SyntheticBankFeedProvider();
// Seed the sandbox the way a provider's own sandbox arrives seeded, with invented Indian data.
sandbox.addTransaction('current-conformance-company', { providerTransactionId: 'upi-1', bookedOn: '2026-08-29', description: 'UPI settlement from yesterday', amountMinor: 48_750_00n, direction: 'CREDIT', reference: 'SYNTHETIC-UTR-240829' });
sandbox.addTransaction('current-conformance-company', { providerTransactionId: 'neft-1', bookedOn: '2026-08-29', description: 'Shop rent NEFT', amountMinor: 25_000_00n, direction: 'DEBIT', reference: 'SYNTHETIC-NEFT-240829' });
const conformance = await runConformance(sandbox, {
  companyId: 'conformance-company',
  redirectUri: 'https://karobar.example/bank/return',
  authorizationCode: 'sandbox-approved',
});
for (const item of conformance.checks) {
  const mark = item.state === 'PASSED' ? '✓' : item.state === 'FAILED' ? '✗' : '·';
  console.log(`  ${mark} ${item.id.padEnd(18)} ${item.what}`);
  console.log(`      ${item.detail}`);
}
console.log(`\n  ${conformance.summary}\n`);
if (!conformance.passed) process.exitCode = 1;
