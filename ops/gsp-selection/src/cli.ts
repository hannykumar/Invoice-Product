/**
 * Issue #50 [X02] — the requirement, the comparison and what is still to be asked.
 *
 *   npm run gsp:route
 *   npm run gsp:route -- --rfp          the requirement to send every provider, unchanged
 *   npm run gsp:route -- --conformance   run the checklist against the sandbox we have today
 *
 * It exits non-zero while a provider cannot honestly be recommended, so this can gate the work that
 * depends on it (#51, and the production wiring of #33) without anybody having to remember to look.
 *
 * The conformance run goes against #33's `SandboxGspProvider` and #26's synthetic IRP. That is not
 * a self-congratulating test: it proves the *harness* works before a real provider is judged by it,
 * and it prints exactly the output a real trial will print.
 */
import { fixedClock } from '@invoice/kernel';
import { SandboxGspProvider } from '@invoice/gsp';
import { SyntheticIrp, SyntheticIrpVault } from '../../../packages/gst/src/einvoice-adapters.ts';
import { SyntheticEwayBillPortal } from '../../../packages/transport/src/adapters.ts';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier } from '../../../packages/platform/src/connectors.ts';
import { CANDIDATES, REQUEST_FOR_PROPOSAL } from './candidates.ts';
import { CAPABILITIES, uncoveredOperations } from './capabilities.ts';
import { CRITERIA } from './criteria.ts';
import { runConformance, type SandboxUnderTest } from './conformance.ts';
import { SCALES, TYPICAL_SMALL_BUSINESS, costCurve } from './cost.ts';
import { PROPOSALS, evidenceState } from './proposals.ts';
import { recommend } from './scoring.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);
const rupees = (paise: bigint): string => `₹${(Number(paise) / 100).toFixed(2)}`;
const flag = (name: string): boolean => process.argv.includes(name);

const TODAY = '2026-09-01';

if (flag('--rfp')) {
  heading('The requirement, sent to every provider unchanged');
  console.log('So the answers are comparable at all. For 10 to 50 GSTINs.\n');
  for (const question of REQUEST_FOR_PROPOSAL) console.log(`  · ${question}`);
  process.exit(0);
}

heading('What we need a provider to do');
console.log('Taken from the operations this product already sends, so a gap here is a feature that stops working.\n');
for (const capability of CAPABILITIES) {
  const mark = capability.critical ? 'critical' : 'wanted';
  console.log(`  ${mark.padEnd(9)} ${capability.label['en-IN']}`);
  console.log(`            needed by ${capability.neededBy}${capability.usedBy === null ? ' — not called yet' : ` — sent today as ${capability.usedBy}`}`);
}
const uncovered = uncoveredOperations();
if (uncovered.length > 0) console.log(`\n  Operations this product sends that nobody has put on the checklist: ${uncovered.join(', ')}`);

heading('What the comparison weighs, and by how much');
for (const criterion of CRITERIA) {
  console.log(`  ${String(criterion.weight).padStart(3)}  ${criterion.label['en-IN']}${criterion.essential ? '  (essential)' : ''}`);
  console.log(`       ${criterion.why}`);
}

heading('Where each provider stands');
const evidence = evidenceState(PROPOSALS);
for (const candidate of CANDIDATES) {
  const proposal = PROPOSALS.find((item) => item.candidateId === candidate.id);
  const state = proposal?.state ?? (candidate.id === 'no_provider' ? 'ALREADY BUILT' : 'NOT_APPROACHED');
  console.log(`  ${state.padEnd(18)} ${candidate.name}`);
}
console.log(`\n  Written quotations: ${evidence.written}. Sandboxes granted: ${evidence.sandboxes}.`);

heading('What it would cost, once somebody quotes');
console.log(`  Volumes assumed per GST number per month: ${TYPICAL_SMALL_BUSINESS.irnsPerGstin} IRNs, ${TYPICAL_SMALL_BUSINESS.ewayBillsPerGstin} e-way bills, ${TYPICAL_SMALL_BUSINESS.returnFilingsPerGstin} filings, ${TYPICAL_SMALL_BUSINESS.gstr2bFetchesPerGstin} GSTR-2B fetches.`);
console.log('  These are a stated assumption about a small trading business, not a measurement.\n');
let quoted = 0;
for (const candidate of CANDIDATES) {
  if (candidate.cost.value === null) {
    console.log(`  ${candidate.name}: no quotation.`);
    continue;
  }
  quoted += 1;
  const curve = costCurve(candidate.cost.value);
  console.log(`  ${candidate.name}: ${curve.map((point) => `${point.gstins} GSTINs ${rupees(point.monthly.total)}/month`).join('  ·  ')}`);
}
if (quoted <= 1) console.log(`\n  Only the built-in route has a cost, so there is no curve to compare at ${SCALES.join(', ')} GSTINs yet.`);

if (flag('--conformance')) {
  heading('The checklist, run against the sandbox we have today');
  const clock = fixedClock('2026-09-01T04:30:00.000Z');
  const irp = new SyntheticIrp(() => clock.now());
  const ewayPortal = new SyntheticEwayBillPortal(() => clock.now());
  const sandbox: SandboxUnderTest = {
    name: 'the synthetic IRP and sandbox GSP in this repository',
    provider: new SandboxGspProvider({ now: () => clock.now() }),
    // The GST connector is deliberately absent rather than mocked: a `MockConnector` answers
    // "accepted" to anything, so wiring one would report a green run for return filing we cannot
    // actually do. The report says NOT_ATTEMPTED instead, which is the truth.
    gateway: new ConnectorGateway([irp, ewayPortal], new SyntheticIrpVault(), new StaticWebhookVerifier()),
    companyId: '11111111-1111-4111-8111-111111111111',
    gstin: '29AAECS1234H1ZG',
    legalName: 'Sunrise Hardware',
    otp: '123456',
    payloads: {
      irn_generate: {
        connector: 'irp', operation: 'einvoice.generate',
        payload: {
          Version: '1.1',
          SellerDtls: { Gstin: '29AAECS1234H1ZG', LglNm: 'Sunrise Hardware', Loc: 'Bengaluru', Pin: 560001, Stcd: '29' },
          DocDtls: { Typ: 'INV', No: 'CONF-1', Dt: '01/09/2026' },
          ValDtls: { AssVal: 100000, CgstVal: 9000, SgstVal: 9000, TotInvVal: 118000 },
        },
      },
      // {{irn}} and {{ewayBillNo}} are filled in from what the sandbox has already answered, the
      // same way a real trial has to cancel the invoice it just registered.
      irn_fetch: { connector: 'irp', operation: 'einvoice.fetch', payload: { Irn: '{{irn}}' } },
      irn_cancel: { connector: 'irp', operation: 'einvoice.cancel', payload: { Irn: '{{irn}}', CnlRsn: '2', CnlRem: 'Conformance run' } },
      eway_generate: {
        connector: 'eway_bill', operation: 'eway.generate',
        payload: {
          fromGstin: '29AAECS1234H1ZG', docNo: 'CONF-1', docDate: '01/09/2026',
          transDistance: 120, vehicleNo: 'KA01AB1234', vehicleType: 'R',
        },
      },
      eway_fetch: { connector: 'eway_bill', operation: 'eway.fetch', payload: { ewbNo: '{{ewayBillNo}}' } },
      eway_update: { connector: 'eway_bill', operation: 'eway.vehicle', payload: { ewbNo: '{{ewayBillNo}}', vehicleNo: 'KA01CD5678', fromPlace: 'Bengaluru', fromState: '29', reasonCode: '1', reasonRem: 'Breakdown' } },
      eway_cancel: { connector: 'eway_bill', operation: 'eway.cancel', payload: { ewbNo: '{{ewayBillNo}}', cancelRsnCode: '2', cancelRmrk: 'Conformance run' } },
    },
  };
  const report = await runConformance(sandbox);
  for (const item of report.checks) {
    console.log(`  ${item.state.padEnd(14)} ${item.critical ? '[critical] ' : '           '}${item.what}`);
    console.log(`                 ${item.detail}`);
  }
  console.log(`\n  ${report.summary}`);
}

const report = recommend(CANDIDATES, PROPOSALS, TODAY);

heading('Recommendation');
console.log(`  ${report.summary['en-IN']}`);
if (report.deferral !== null) {
  console.log(`  ${report.deferral.why['en-IN']}\n`);
  console.log('  What to do next:');
  for (const question of report.deferral.toAsk.slice(0, 6)) console.log(`    · ${question}`);
  if (report.deferral.toAsk.length > 6) console.log(`    · …and ${report.deferral.toAsk.length - 6} more — run with --rfp for the full requirement.`);
  process.exitCode = 1;
} else {
  console.log(`  Primary:  ${report.primary?.candidate.name} (${report.primary?.score}/100)`);
  console.log(`  Fallback: ${report.fallback?.candidate.name} (${report.fallback?.score}/100)`);
}
