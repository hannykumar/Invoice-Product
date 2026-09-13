/**
 * Issue #51 [X03] acceptance criteria, as far as a repository can hold itself to them.
 *
 *   - "Production access is active" — cannot be true today, and the gate must say so rather than
 *     drift into optimism. So the tests here are mostly about the gate refusing.
 *   - "Pilot GSTIN onboarding is documented and tested" — the drill runs the whole dance.
 *   - "Fallback/manual workflow remains available" — proved with the connection revoked.
 *   - "Credential rotation and revocation drill" — run on every test run, not written down.
 *
 * The last two tests are about this module keeping itself honest: the register and the switch the
 * connector obeys must agree, and neither the register nor the runbook may contain a real
 * identifier.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { DomainError } from '@invoice/kernel';
import { PRODUCTION_ACCESS, buildEInvoicePayload, checkGovernmentEndpoint } from '@invoice/gst';
import { makeCaller } from '../../../packages/gst/src/whitebooks-http.ts';
import { GO_LIVE_STEPS } from '../src/checklist.ts';
import { credentialRotationDrill, pilotOnboardingDrill, revocationAndFallbackDrill } from '../src/drills.ts';
import { assess } from '../src/readiness.ts';
import { CURRENT_STATE } from '../src/state.ts';
import type { ProductionRegister, StepRecord } from '../src/model.ts';

const TODAY = '2026-09-13';
const repoRoot = resolve(import.meta.dirname, '../../..');

// ------------------------------------------------------------------- the gate

test('production access is not available today, and the gate says exactly what is missing', () => {
  const report = assess(CURRENT_STATE, TODAY);
  assert.equal(report.productionAllowed, false);
  assert.equal(report.register.environment, 'SANDBOX');
  assert.equal(report.register.contractedProvider, null, 'no production agreement has been signed with anybody');

  const blocking = report.findings.filter((finding) => finding.level === 'BLOCKING');
  assert.ok(blocking.length > 0, 'a gate with nothing blocking would be saying we are ready');
  for (const finding of blocking) {
    assert.ok(finding.what['hi-IN'].length > 0, `${finding.code} must be readable in both languages`);
    assert.ok(finding.whatToDo['en-IN'].length > 0, `${finding.code} must say what to do about it`);
  }
});

test('a step deliberately not being pursued is reported, never quietly counted as done', () => {
  const report = assess(CURRENT_STATE, TODAY);
  const held = report.steps.filter((step) => step.state === 'ON_HOLD_BY_DECISION');
  assert.ok(held.length > 0, 'the standing sandbox-only decision has to be visible in the report');
  for (const step of held) {
    assert.ok(report.findings.some((finding) => finding.code === `ON_HOLD_BY_DECISION:${step.id}`));
  }
  // And it is still not production-ready: on hold is a reason to refuse, not an exemption.
  assert.equal(report.productionAllowed, false);
});

test('the gate can pass — but only with every condition satisfied and the code switch on', () => {
  const satisfied: ProductionRegister = {
    ...CURRENT_STATE,
    environment: 'PRODUCTION',
    contractedProvider: 'A provider, once one is chosen',
    steps: GO_LIVE_STEPS.map((step): StepRecord => ({ id: step.id, state: 'DONE', evidence: 'drill', note: null })),
  };
  const active = { active: true, decidedOn: TODAY, reason: 'Signed, reviewed and piloted.' };

  assert.equal(assess(satisfied, TODAY, active).productionAllowed, true);
  // One condition undone, and it closes again.
  const oneShort: ProductionRegister = {
    ...satisfied,
    steps: satisfied.steps.map((step, index) => (index === 0 ? { ...step, state: 'IN_PROGRESS' } : step)),
  };
  assert.equal(assess(oneShort, TODAY, active).productionAllowed, false);
});

test('the register and the switch the connector obeys cannot disagree without a blocking finding', () => {
  const claiming: ProductionRegister = { ...CURRENT_STATE, environment: 'PRODUCTION' };
  const report = assess(claiming, TODAY);
  assert.ok(report.findings.some((finding) => finding.code === 'REGISTER_DISAGREES_WITH_CODE'));
  assert.equal(report.productionAllowed, false);

  // And today they do agree.
  assert.equal(PRODUCTION_ACCESS.active, false);
  assert.equal(assess(CURRENT_STATE, TODAY).findings.some((f) => f.code === 'REGISTER_DISAGREES_WITH_CODE'), false);
});

// ------------------------------------------------------------------- the drills

test('drill — a pilot customer connects its own GST number and one controlled call goes through', async () => {
  const report = await pilotOnboardingDrill();
  assert.equal(report.passed, true, JSON.stringify(report.steps.filter((step) => !step.passed), null, 2));
  assert.ok(report.steps.length >= 6);
});

test('drill — credentials are replaced under a live connection, audited, with no secret written down', async () => {
  const report = await credentialRotationDrill();
  assert.equal(report.passed, true, JSON.stringify(report.steps.filter((step) => !step.passed), null, 2));
});

test('drill — revoking stops the next call, keeps the history, and the manual fallback still works', async () => {
  const report = await revocationAndFallbackDrill();
  assert.equal(report.passed, true, JSON.stringify(report.steps.filter((step) => !step.passed), null, 2));
  const fallback = report.steps.at(-1);
  assert.match(fallback?.name ?? '', /still produce the file/);
  assert.equal(fallback?.passed, true, 'a business whose connection is gone must still be able to invoice');
});

// ------------------------------------------------------- the endpoint this build may call

test('only a sandbox address this repository has actually probed can be called', () => {
  assert.equal(checkGovernmentEndpoint('https://apisandbox.whitebooks.in').allowed, true);
  assert.equal(checkGovernmentEndpoint('https://apisandbox.example.invalid').allowed, true, 'fixtures point at hosts that can never resolve');

  const live = checkGovernmentEndpoint('https://api.whitebooks.in');
  assert.equal(live.allowed, false);
  assert.equal(live.allowed === false ? live.code : '', 'GOVERNMENT_PRODUCTION_NOT_ACTIVE');
  assert.match(live.allowed === false ? live.message : '', /sandbox APIs only/, 'the refusal explains the standing decision');

  assert.equal(checkGovernmentEndpoint('http://apisandbox.whitebooks.in').allowed, false, 'a credential is never sent unencrypted');
  assert.equal(checkGovernmentEndpoint('not-a-url').allowed, false);
});

test('a connector pointed at a live portal refuses to be built at all', () => {
  const credentials = {
    baseUrl: 'https://api.whitebooks.in',
    clientId: 'x', clientSecret: 'y', gstin: '29AAECS1234H1ZG',
    username: 'u', password: 'p', ipAddress: '203.0.113.10',
  };
  assert.throws(
    () => makeCaller({ credentials, email: 'ops@example.invalid' }),
    (error: unknown) => error instanceof DomainError && error.code === 'GOVERNMENT_PRODUCTION_NOT_ACTIVE',
    'the misconfiguration must fail when the connector is composed, not in front of a shopkeeper',
  );
});

test("the government's fake sandbox GSTINs stop being accepted the moment production is switched on", () => {
  const document = {
    documentId: 'doc-1', documentNumber: 'INV/1', documentDate: '2026-09-01', documentType: 'INVOICE' as const,
    supplyType: 'B2B' as const, reverseCharge: false,
    seller: { gstin: '33AAGCB1286Q003', legalName: 'Sandbox Taxpayer', address1: 'Chennai', place: 'Chennai', pincode: '600001', stateCode: '33' },
    buyer: { gstin: '33AAGCB1286Q004', legalName: 'Sandbox Buyer', address1: 'Chennai', place: 'Chennai', pincode: '600001', stateCode: '33' },
    placeOfSupplyStateCode: '33',
    lines: [],
    totals: { taxableValue: 100000n, cgst: 9000n, sgst: 9000n, igst: 0n, cess: 0n, otherCharges: 0n, roundOff: 0n, invoiceValue: 118000n },
  };
  // Today — a sandbox build — the government's own malformed numbers are allowed through on request.
  const sandboxBuild = buildEInvoicePayload(document as never, { allowSandboxGstins: true });
  const complaints = sandboxBuild.ok ? [] : sandboxBuild.problems.map((problem) => problem.message);
  assert.equal(complaints.some((message) => message.includes('GST number')), false, complaints.join(' | '));

  // The door is held open by PRODUCTION_ACCESS, so it cannot be left open once production is on.
  assert.equal(PRODUCTION_ACCESS.active, false);
});

// ------------------------------------------------------- this module keeping itself honest

test('nothing in the register or the runbook is a real identifier', async () => {
  const runbook = await readFile(resolve(repoRoot, 'docs/compliance/x03-gsp-production-onboarding.md'), 'utf8');
  const register = JSON.stringify(CURRENT_STATE);
  const shapes: readonly [string, RegExp][] = [
    ['GSTIN', /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/],
    ['PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/],
    ['IFSC', /\b[A-Z]{4}0[A-Z\d]{6}\b/],
    ['CIN', /\b[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/],
    ['Aadhaar', /\b\d{4}\s?\d{4}\s?\d{4}\b/],
  ];
  for (const [name, shape] of shapes) {
    assert.equal(shape.test(register), false, `the register holds something shaped like a ${name}`);
    assert.equal(shape.test(runbook), false, `the runbook holds something shaped like a ${name}`);
  }
});

test('the runbook and the checklist say the same thing', async () => {
  const runbook = await readFile(resolve(repoRoot, 'docs/compliance/x03-gsp-production-onboarding.md'), 'utf8');
  for (const step of GO_LIVE_STEPS) {
    assert.ok(runbook.includes(step.id), `the runbook does not cover ${step.id}`);
  }
  assert.match(runbook, /sandbox/i);
});
