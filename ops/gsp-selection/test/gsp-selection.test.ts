/**
 * Issue #50 [X02] acceptance criteria, enforced automatically.
 *
 *   - "At least two written comparable proposals"
 *   - "A sandbox demonstrates required critical endpoints"
 *   - "Recommendation identifies primary and fallback provider"
 *
 * plus the two non-goals, which are the easy things to fail: choosing on headline price, and
 * assuming one vendor offers everything without proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '@invoice/kernel';
import { OPERATION_SCOPES, SandboxGspProvider } from '@invoice/gsp';
import { ConnectorError, ConnectorGateway, StaticWebhookVerifier, type ConnectorRequest } from '../../../packages/platform/src/connectors.ts';
import { SyntheticIrp, SyntheticIrpVault } from '../../../packages/gst/src/einvoice-adapters.ts';
import { SyntheticEwayBillPortal } from '../../../packages/transport/src/adapters.ts';
import { CANDIDATES } from '../src/candidates.ts';
import { CAPABILITIES, uncoveredOperations } from '../src/capabilities.ts';
import { CRITERIA } from '../src/criteria.ts';
import { capabilityEvidence, runConformance, type SandboxUnderTest } from '../src/conformance.ts';
import { TYPICAL_SMALL_BUSINESS, costCurve, monthlyCost } from '../src/cost.ts';
import { PROPOSALS, evidenceState, stillToApproach } from '../src/proposals.ts';
import { missingCritical, recommend, scoreCandidate } from '../src/scoring.ts';
import { isWrittenProposal, known, unknown, type Candidate, type CostShape, type ProposalRecord } from '../src/model.ts';

const TODAY = '2026-09-01';
const clock = fixedClock('2026-09-01T04:30:00.000Z');

// ------------------------------------------------------------------- the checklist is the product's

test('every operation this product sends is on the checklist we send providers', () => {
  assert.deepEqual(uncoveredOperations(), [], 'a capability nobody listed is a gap a provider is never asked about');
});

test('the scope table is spelled the way the adapters actually send, not the way it reads nicely', () => {
  // This is the bug this issue's own checklist caught: the authorised channel (#33) listed
  // `eway.update_vehicle` while #27 posts `eway.vehicle`, so changing a lorry at nine at night
  // would have been refused as an operation nobody mapped to a permission.
  const sources = ['../../../packages/transport/src/adapters.ts', '../../../packages/gst/src/einvoice-adapters.ts'];
  const sent = new Set<string>();
  for (const source of sources) {
    const text = readFileSync(fileURLToPath(new URL(source, import.meta.url)), 'utf8');
    for (const match of text.matchAll(/"((?:einvoice|eway)\.[a-z_]+)"/g)) sent.add(match[1] as string);
  }
  assert.ok(sent.size >= 10, 'the scan found nothing, so it is no longer watching anything');
  for (const operation of sent) {
    assert.ok(operation in OPERATION_SCOPES, `${operation} is sent by an adapter but has no scope in @invoice/gsp`);
  }
});

test('a critical capability names the issue whose feature stops working without it', () => {
  for (const capability of CAPABILITIES) {
    assert.match(capability.neededBy, /^#\d+$/);
    assert.ok(capability.why.length > 40, `${capability.id} has no reason a person could argue with`);
  }
});

// ------------------------------------------------------------------- the evidence bar

test('nothing has been requested yet, so the honest output is a deferral naming who to ask', () => {
  const report = recommend(CANDIDATES, PROPOSALS, TODAY);
  assert.equal(report.primary, null);
  assert.equal(report.fallback, null);
  assert.equal(report.writtenProposals, 0);
  assert.ok(report.deferral !== null);
  assert.match(report.deferral.toAsk[0] ?? '', /IRIS, FinAGG, MasterGST, Clear/);
  assert.deepEqual(stillToApproach(CANDIDATES, PROPOSALS), ['IRIS', 'FinAGG', 'MasterGST', 'Clear']);
});

test('a quotation nobody can open is not a written proposal', () => {
  const remembered: ProposalRecord = {
    candidateId: 'iris', state: 'QUOTATION_RECEIVED', requestedOn: TODAY, receivedOn: TODAY,
    documentRef: null, sandboxGrantedOn: null, note: 'They said about ₹8 a GSTIN on a call.',
  };
  assert.equal(isWrittenProposal(remembered), false);
  assert.equal(isWrittenProposal({ ...remembered, documentRef: 'quotations/iris-2026-09-01.pdf' }), true);
  assert.equal(evidenceState([remembered]).enough, false);
});

test('no provider is named while the product has never been told what any of them charge', () => {
  for (const candidate of CANDIDATES) {
    if (candidate.id === 'no_provider') continue;
    assert.equal(candidate.cost.confidence, 'UNKNOWN', `${candidate.name} carries a commercial figure nobody supplied`);
    for (const capability of Object.values(candidate.capabilities)) {
      assert.equal(capability.confidence, 'UNKNOWN', `${candidate.name} claims a capability nobody has demonstrated`);
    }
  }
});

// ------------------------------------------------------------------- the rules price cannot buy

const fullyPriced: CostShape = {
  monthlyPlatformFeePaise: 500_000n, perGstinPerMonthPaise: 20_000n, perIrnPaise: 30n,
  perEwayBillPaise: 50n, perReturnFilingPaise: 1_000n, perGstr2bFetchPaise: 500n,
  monthlyMinimumPaise: 0n, oneOffOnboardingPaise: 0n,
};

const complete = (id: string, name: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  name,
  authModel: 'API_USER_WITH_OTP',
  summary: { 'en-IN': 'A test candidate.', 'hi-IN': 'Test ke liye.' },
  capabilities: Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, known(true, 'CONFIRMED', 'sandbox run', TODAY)])),
  assessments: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, known(4, 'CONFIRMED', 'their written quotation', TODAY)])),
  cost: known(fullyPriced, 'CONFIRMED', 'their written quotation', TODAY),
  openQuestions: [],
  ...overrides,
});

test('a provider that wants the customer’s portal password is disqualified, whatever it costs', () => {
  const cheapest = complete('cheap', 'Cheapest GSP', {
    authModel: 'PORTAL_PASSWORD',
    assessments: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, known(5, 'CONFIRMED', 'their quotation', TODAY)])),
  });
  const score = scoreCandidate(cheapest);
  assert.equal(score.verdict, 'DISQUALIFIED');
  assert.equal(score.score, null, 'it is not scored at all, so nothing can outweigh it');
  assert.match(score.reason['en-IN'], /nowhere to keep one/);
});

test('a missing critical capability is a stop, not a deduction', () => {
  const noIrn = complete('no_irn', 'Everything but IRNs', {
    capabilities: {
      ...Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, known(true, 'CONFIRMED', 'sandbox run', TODAY)])),
      irn_generate: known(false, 'CONFIRMED', 'sandbox run', TODAY),
    },
  });
  const score = scoreCandidate(noIrn);
  assert.equal(score.verdict, 'CANNOT_SAY_YET');
  assert.deepEqual(score.missingCritical, ['irn_generate']);
  assert.ok((score.score ?? 0) > 70, 'it scores well on everything else, and still cannot be chosen');
});

test('an unanswered essential question stops a verdict rather than being averaged away', () => {
  const quiet = complete('quiet', 'Answered half the questions', {
    assessments: {
      ...Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, known(5, 'CONFIRMED', 'their quotation', TODAY)])),
      data_storage: unknown<number>('They have not said what they keep.'),
    },
  });
  const score = scoreCandidate(quiet);
  assert.equal(score.verdict, 'CANNOT_SAY_YET');
  assert.match(score.reason['en-IN'], /what they keep/i);
});

test('once two providers have proved themselves, one is primary and the other the fallback', () => {
  const strong = complete('strong', 'Provider A');
  const weaker = complete('weaker', 'Provider B', {
    assessments: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, known(3, 'CONFIRMED', 'their quotation', TODAY)])),
  });
  const proposals: readonly ProposalRecord[] = [
    { candidateId: 'strong', state: 'SANDBOX_GRANTED', requestedOn: TODAY, receivedOn: TODAY, documentRef: 'quotations/a.pdf', sandboxGrantedOn: TODAY, note: null },
    { candidateId: 'weaker', state: 'QUOTATION_RECEIVED', requestedOn: TODAY, receivedOn: TODAY, documentRef: 'quotations/b.pdf', sandboxGrantedOn: null, note: null },
  ];
  const report = recommend([...CANDIDATES, strong, weaker], proposals, TODAY);
  assert.equal(report.deferral, null);
  assert.equal(report.primary?.candidate.name, 'Provider A');
  assert.equal(report.fallback?.candidate.name, 'Provider B');
  assert.equal(report.primary?.verdict, 'RECOMMENDED');
  assert.equal(report.fallback?.verdict, 'FALLBACK');
  assert.equal(report.writtenProposals, 2);
  // The baseline is not a GSP and must never be recommended as one.
  assert.notEqual(report.primary?.candidate.id, 'no_provider');
});

test('one viable provider is not a plan, so it still defers', () => {
  const only = complete('only', 'The only one that answered');
  const proposals: readonly ProposalRecord[] = [
    { candidateId: 'only', state: 'SANDBOX_GRANTED', requestedOn: TODAY, receivedOn: TODAY, documentRef: 'quotations/only.pdf', sandboxGrantedOn: TODAY, note: null },
    { candidateId: 'iris', state: 'QUOTATION_RECEIVED', requestedOn: TODAY, receivedOn: TODAY, documentRef: 'quotations/iris.pdf', sandboxGrantedOn: null, note: null },
  ];
  const report = recommend([...CANDIDATES, only], proposals, TODAY);
  assert.equal(report.primary, null);
  assert.match(report.deferral?.why['en-IN'] ?? '', /single-provider plan is not a plan|cannot be chosen yet/);
});

// ------------------------------------------------------------------- the cost curve

test('a monthly minimum is a floor, not another line on the bill', () => {
  const withMinimum: CostShape = { ...fullyPriced, monthlyPlatformFeePaise: 0n, perGstinPerMonthPaise: 0n, monthlyMinimumPaise: 1_000_000n };
  const small = monthlyCost(withMinimum, { gstins: 1, volume: TYPICAL_SMALL_BUSINESS, amortiseOneOffOverMonths: 12 });
  assert.equal(small.total, 1_000_000n, 'below the minimum, the minimum is the bill');
  assert.ok(small.minimumTopUp > 0n);
  const large = monthlyCost(withMinimum, { gstins: 200, volume: TYPICAL_SMALL_BUSINESS, amortiseOneOffOverMonths: 12 });
  assert.equal(large.minimumTopUp, 0n, 'above it, the minimum adds nothing');
  assert.ok(large.total > 1_000_000n);
});

test('the cost is compared as a curve, because a provider can be cheap at fifty and dear at ten', () => {
  const perDocumentHeavy: CostShape = { ...fullyPriced, monthlyPlatformFeePaise: 0n, perGstinPerMonthPaise: 0n, monthlyMinimumPaise: 2_000_000n };
  const curve = costCurve(perDocumentHeavy);
  assert.deepEqual(curve.map((point) => point.gstins), [10, 25, 50]);
  const [ten, , fifty] = curve as [typeof curve[number], typeof curve[number], typeof curve[number]];
  assert.ok(ten.monthly.perGstinEffective > fifty.monthly.perGstinEffective, 'the per-GSTIN cost has to fall as the minimum is absorbed');
  assert.equal(monthlyCost(perDocumentHeavy, { gstins: 0, volume: TYPICAL_SMALL_BUSINESS, amortiseOneOffOverMonths: 12 }).perGstinEffective, 2_000_000n);
});

test('the one-off charge is spread rather than dropped', () => {
  const withOneOff: CostShape = { ...fullyPriced, oneOffOnboardingPaise: 12_000_000n };
  const monthly = monthlyCost(withOneOff, { gstins: 10, volume: TYPICAL_SMALL_BUSINESS, amortiseOneOffOverMonths: 12 });
  assert.equal(monthly.amortisedOneOff, 1_000_000n);
});

// ------------------------------------------------------------------- the sandbox harness

const sandboxUnderTest = (options: { irp?: SyntheticIrp; eway?: SyntheticEwayBillPortal; extra?: readonly unknown[] } = {}): SandboxUnderTest => {
  const irp = options.irp ?? new SyntheticIrp(() => clock.now());
  const eway = options.eway ?? new SyntheticEwayBillPortal(() => clock.now());
  return {
    name: 'the sandbox in this repository',
    provider: new SandboxGspProvider({ now: () => clock.now() }),
    gateway: new ConnectorGateway([irp, eway] as never, new SyntheticIrpVault(), new StaticWebhookVerifier()),
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
          DocDtls: { Typ: 'INV', No: 'TEST-1', Dt: '01/09/2026' },
          ValDtls: { AssVal: 100000, CgstVal: 9000, SgstVal: 9000, TotInvVal: 118000 },
        },
      },
      irn_fetch: { connector: 'irp', operation: 'einvoice.fetch', payload: { Irn: '{{irn}}' } },
      eway_generate: {
        connector: 'eway_bill', operation: 'eway.generate',
        payload: { fromGstin: '29AAECS1234H1ZG', docNo: 'TEST-1', docDate: '01/09/2026', transDistance: 120, vehicleNo: 'KA01AB1234', vehicleType: 'R' },
      },
      eway_fetch: { connector: 'eway_bill', operation: 'eway.fetch', payload: { ewbNo: '{{ewayBillNo}}' } },
    },
  };
};

test('the harness proves the authorisation dance, the endpoints and one retry', async () => {
  const report = await runConformance(sandboxUnderTest());
  const state = (id: string): string => report.checks.find((check) => check.id === id)?.state ?? 'MISSING';

  assert.equal(state('api_user_otp'), 'PASSED');
  assert.match(report.checks.find((check) => check.id === 'api_user_otp')?.detail ?? '', /wrong code was refused/);
  assert.equal(state('irn_generate'), 'PASSED');
  assert.equal(state('irn_fetch'), 'PASSED', 'the IRN from the first call is filled into the second');
  assert.equal(state('eway_generate'), 'PASSED');
  assert.equal(state('idempotent_retry'), 'PASSED');
  assert.equal(state('credential_is_a_reference'), 'PASSED');
  // Nothing was supplied for the GST return endpoints, and unproven is not the same as absent.
  assert.equal(state('return_file'), 'NOT_ATTEMPTED');
  assert.equal(report.passed, false, 'critical endpoints nobody demonstrated cannot be signed for');
  assert.ok(report.criticalGaps.includes('return_file'));
});

test('an endpoint the sandbox refuses is reported as not supported, not as a pass', async () => {
  const irp = new SyntheticIrp(() => clock.now());
  irp.rejectNext('2172', 'This taxpayer is not enabled for e-invoicing.');
  const report = await runConformance(sandboxUnderTest({ irp }));
  const generate = report.checks.find((check) => check.id === 'irn_generate');
  assert.equal(generate?.state, 'NOT_SUPPORTED');
  assert.match(generate?.detail ?? '', /2172/);
  assert.equal(report.passed, false);
  assert.ok(report.criticalGaps.includes('irn_generate'));
});

test('a sandbox that hands back a secret fails, however well it works otherwise', async () => {
  const leaky = {
    kind: 'irp' as const,
    async execute(request: ConnectorRequest) {
      return { providerRequestId: 'leak-1', status: 'completed' as const, payload: { Irn: 'irn-1', accessToken: 'abcd', echoed: request.idempotencyKey } };
    },
    async health() { return 'healthy' as const; },
  };
  const report = await runConformance(sandboxUnderTest({ irp: leaky as never }));
  const generate = report.checks.find((check) => check.id === 'irn_generate');
  assert.equal(generate?.state, 'FAILED');
  assert.match(generate?.detail ?? '', /token/);
});

test('a sandbox that is simply down fails rather than quietly passing', async () => {
  const down = {
    kind: 'irp' as const,
    async execute() { throw new ConnectorError('OUTAGE', true); },
    async health() { return 'unavailable' as const; },
  };
  const report = await runConformance(sandboxUnderTest({ irp: down as never }));
  assert.equal(report.checks.find((check) => check.id === 'irn_generate')?.state, 'FAILED');
  assert.equal(report.checks.find((check) => check.id === 'health')?.state, 'PASSED', 'the provider surface is separate from the connector that is down');
});

test('a sandbox run becomes evidence the comparison can use', async () => {
  const report = await runConformance(sandboxUnderTest());
  const evidence = capabilityEvidence(report);
  assert.equal(evidence.irn_generate?.value, true);
  assert.equal(evidence.irn_generate?.confidence, 'CONFIRMED');
  assert.match(evidence.irn_generate?.source ?? '', /sandbox conformance run/);
  assert.equal(evidence.return_file, undefined, '"we did not try" is not a finding');

  // And the evidence moves a candidate: what the run proved is settled, and what it never tried
  // stays outstanding. This sandbox was given four requests, so five critical capabilities remain
  // unproven — which is exactly the list to go back to the provider with.
  const proved = complete('proved', 'Provider with a sandbox run', { capabilities: { ...evidence } });
  assert.deepEqual(
    [...missingCritical(proved)].sort(),
    ['eway_cancel', 'eway_update', 'gstr2b_fetch', 'irn_cancel', 'return_file', 'return_status'],
  );
  assert.equal(evidence.irn_fetch?.value, true, 'what it did prove is settled and needs no second trial');
});
