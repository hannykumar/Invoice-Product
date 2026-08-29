/**
 * Issue #48 [E48] — proving the gates have teeth.
 *
 * A green gate is worth exactly as much as the evidence that it can go red. Every invariant here is
 * handed a deliberately broken observation and **required** to fail; then the whole runner is
 * checked to fail closed when a check explodes, when it examines nothing, and when the system
 * itself cannot be inspected.
 *
 * The issue asks for defects to be injected across ledger, inventory, GST and idempotency. They are
 * injected below in that order, and each has a named test so a failure says which guarantee broke.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  approvedRulesCiteASource,
  everyVoucherBalances,
  finalRecordsAreImmutable,
  goldenDatasetStillMatches,
  observeEverything,
  renderReport,
  retriesAreIdempotent,
  runGates,
  stockNeverSilentlyNegative,
  taxPartsSumToTotal,
  trialBalanceIsLevel,
  uncertainModelOutputIsAskedAbout,
  type Observations,
} from '../src/index.ts';

const REAL = await observeEverything();

// ------------------------------------------------------------------ the gates pass on a good build

test('every gate passes against the product as it stands', () => {
  const report = runGates(REAL);
  assert.deepEqual(
    report.failures.map((failure) => failure.id),
    [],
    renderReport(report),
  );
  assert.equal(report.mayRelease, true);
});

test('every gate actually looked at something', () => {
  for (const result of runGates(REAL).results) {
    assert.ok(result.examined > 0, `${result.id} examined nothing, so it proves nothing`);
  }
});

// ------------------------------------------------------------------------------ injected defects

test('an unbalanced voucher is caught (ledger)', () => {
  const result = everyVoucherBalances([
    { id: 'v1', number: 'JV/1', state: 'FINAL', debits: 100_00n, credits: 90_00n },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.severity, 'CRITICAL');
  assert.match(result.detail, /do not balance/);
});

test('a draft that does not balance is not counted against the release (ledger)', () => {
  // Drafts are working documents; only what has been posted has to hold together.
  const result = everyVoucherBalances([
    { id: 'v1', number: 'JV/1', state: 'DRAFT', debits: 100_00n, credits: 0n },
    { id: 'v2', number: 'JV/2', state: 'FINAL', debits: 100_00n, credits: 100_00n },
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.examined, 1, 'only the posted entry counts');
});

test('books that are out by even one paisa are caught (ledger)', () => {
  const result = trialBalanceIsLevel(100_000_01n, 100_000_00n, 5);
  assert.equal(result.passed, false);
  assert.match(result.detail, /out by 1 paise/);
});

test('stock below zero with nobody having allowed it is caught (inventory)', () => {
  const result = stockNeverSilentlyNegative([
    { itemId: 'CRATE', warehouseId: 'shop', physical: -5_000_000n, overrideReason: null, overrideAllowedBy: null },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.detail, /nobody recorded as having allowed it/);
});

test('stock below zero with a reason and an authoriser is allowed (inventory)', () => {
  const result = stockNeverSilentlyNegative([
    { itemId: 'CRATE', warehouseId: 'shop', physical: -5_000_000n, overrideReason: 'On the van already.', overrideAllowedBy: 'priya' },
  ]);
  assert.equal(result.passed, true, 'the gate is about silence, not about negatives');
});

test('an override with a blank reason does not count as an explanation (inventory)', () => {
  const result = stockNeverSilentlyNegative([
    { itemId: 'CRATE', warehouseId: 'shop', physical: -1n, overrideReason: '   ', overrideAllowedBy: 'priya' },
  ]);
  assert.equal(result.passed, false);
});

test('a GST split that does not add up to the GST charged is caught (tax)', () => {
  const result = taxPartsSumToTotal([
    { documentNumber: 'INV/1', cgst: 150_00n, sgst: 150_00n, utgst: 0n, igst: 0n, cess: 0n, totalTax: 400_00n },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.detail, /its parts come to 30000/);
});

test('a retry that records a second document is caught (idempotency)', () => {
  const result = retriesAreIdempotent([
    { idempotencyKey: 'k1', firstResultId: 'v1', secondResultId: 'v2', documentsCreated: 2 },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.detail, /produced 2 records/);
});

test('a settled compliance rule with no source is caught (rules)', () => {
  const result = approvedRulesCiteASource([
    { ruleSetId: 'in.gst@1', ruleId: 'gst.made_up', kind: 'COMPLIANCE', reviewState: 'APPROVED', sourceRef: null, effectiveFrom: '2026-04-01' },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.detail, /names no source/);
});

test('a draft rule without a source is not held to the same bar (rules)', () => {
  // A DRAFT rule is openly unfinished; #54 is what stops it being approved without a source.
  const result = approvedRulesCiteASource([
    { ruleSetId: 'in.gst@1', ruleId: 'gst.draft', kind: 'COMPLIANCE', reviewState: 'DRAFT', sourceRef: null, effectiveFrom: '2026-04-01' },
    { ruleSetId: 'in.gst@1', ruleId: 'gst.real', kind: 'COMPLIANCE', reviewState: 'APPROVED', sourceRef: 'notification:1/2017', effectiveFrom: '2026-04-01' },
  ]);
  assert.equal(result.passed, true);
});

test('a finished record that could be changed after the fact is caught', () => {
  const result = finalRecordsAreImmutable([{ voucherId: 'v1', state: 'FINAL', editRefused: false }]);
  assert.equal(result.passed, false);
  assert.match(result.detail, /could be changed after the fact/);
});

test('a golden business that no longer produces its figures is caught', () => {
  const result = goldenDatasetStillMatches([
    { fixtureId: 'bakery-jaipur', mismatches: ['total GST: expected 300.00, got 250.00'] },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.detail, /no longer matches/);
});

test('a model guess taken as decided while unsure is caught (AI threshold)', () => {
  const result = uncertainModelOutputIsAskedAbout(
    [{ field: 'quantity', source: 'MODEL', confidence: 0.62, acceptedWithoutAsking: true }],
    0.9,
  );
  assert.equal(result.passed, false);
  assert.match(result.detail, /below the 0.9 the product requires/);
});

test('a confident reading is allowed through (AI threshold)', () => {
  const result = uncertainModelOutputIsAskedAbout(
    [{ field: 'quantity', source: 'MODEL', confidence: 0.98, acceptedWithoutAsking: true }],
    0.9,
  );
  assert.equal(result.passed, true);
});

test('the tax gate looks at lines, not documents, or it is checking a number against itself', () => {
  // A document's total tax is re-summed from its components, so comparing the two there compares a
  // number with itself. This was a real hole: a deliberate defect that dropped SGST from a line's
  // own total sailed through the gate until the observation moved down to line level.
  const perLine = REAL.tax;
  assert.ok(perLine.length > 0, 'there should be lines to look at');
  assert.ok(
    perLine.every((observation) => observation.documentNumber.includes(' line ')),
    'the tax observation must be per line; a per-document one cannot fail',
  );
});

// --------------------------------------------------------------------------------- failing closed

const withDefect = (change: Partial<Observations>): Observations => ({ ...REAL, ...change });

test('one broken invariant stops the whole release', () => {
  const report = runGates(withDefect({
    vouchers: [{ id: 'v1', number: 'JV/1', state: 'FINAL', debits: 1n, credits: 2n }],
  }));
  assert.equal(report.mayRelease, false);
  assert.ok(report.failures.some((failure) => failure.id === 'LEDGER_VOUCHERS_BALANCE'));
  assert.match(renderReport(report), /must not be released/);
});

test('a gate that examined nothing fails rather than passing quietly', () => {
  // An empty observation would otherwise sail through every "none of them are broken" check.
  const report = runGates(withDefect({ golden: [], tax: [], retries: [] }));
  assert.equal(report.mayRelease, false);
  for (const id of ['GOLDEN_DATASET_MATCHES', 'TAX_PARTS_SUM_TO_TOTAL', 'RETRY_IS_IDEMPOTENT']) {
    const result = report.failures.find((failure) => failure.id === id);
    assert.notEqual(result, undefined, `${id} should fail when it examined nothing`);
    assert.match(result?.detail ?? '', /nothing was actually examined/);
  }
});

test('a gate that throws while being checked counts against the release, not for it', () => {
  // The getter has to be defined on the object the runner reads, not spread into it, or it fires
  // while the fixture is being built instead of while the gate is being evaluated.
  const exploding = { ...REAL };
  Object.defineProperty(exploding, 'vouchers', {
    get(): never {
      throw new Error('the ledger could not be read');
    },
  });
  const report = runGates(exploding as Observations);
  assert.equal(report.mayRelease, false);
  const failure = report.failures.find((f) => f.id === 'LEDGER_VOUCHERS_BALANCE');
  assert.match(failure?.detail ?? '', /could not be completed/);
});

test('the report names the figure, not the function', () => {
  const report = runGates(withDefect({
    tax: [{ documentNumber: 'INV/GD/2026-27/00001', cgst: 1n, sgst: 1n, utgst: 0n, igst: 0n, cess: 0n, totalTax: 99n }],
  }));
  const rendered = renderReport(report);
  assert.match(rendered, /INV\/GD\/2026-27\/00001/, 'a person should be able to go and look at the bill');
  assert.match(rendered, /99 paise of GST, but its parts come to 2/);
});
