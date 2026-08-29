/**
 * Issue #43 [E43] — the dataset checks itself, and then checks the product.
 *
 * Three things are being proved here:
 *
 *  1. **Schema validation** — a fixture that is malformed is rejected where it is read.
 *  2. **Cross-module replay** — every example business, run through the real ledger, sales,
 *     inventory, GST and receivables modules, produces exactly the figures the file states.
 *  3. **Mutation** — that the comparison actually bites. A golden dataset whose checks pass on
 *     tampered figures is worse than no dataset, because it looks like assurance.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  compareRefusalReasons,
  compareToExpected,
  describeMismatches,
  loadAllFixtures,
  loadFixture,
  replay,
  validateFixture,
  type GoldenFixture,
} from '../src/index.ts';

const FIXTURES = loadAllFixtures();

test('there is an example of each kind of business the product is for', () => {
  const kinds = FIXTURES.map(({ fixture }) => fixture.company.kind).sort();
  assert.deepEqual(kinds, ['BAKERY', 'SERVICES', 'TRANSPORT', 'WHOLESALER']);
});

test('every fixture on disk is valid, and every id is unique', () => {
  assert.ok(FIXTURES.length >= 4, 'the dataset should not shrink silently');
  const ids = new Set<string>();
  for (const { name, fixture } of FIXTURES) {
    assert.deepEqual(validateFixture(fixture), [], `${name} should be valid`);
    assert.equal(ids.has(fixture.id), false, `${fixture.id} is used twice`);
    ids.add(fixture.id);
    assert.ok(fixture.describes.length > 40, `${name} must explain itself to a reviewer`);
  }
});

test('every expected tax figure names the rule and source behind it', () => {
  for (const { name, fixture } of FIXTURES) {
    const provenance = fixture.expected.tax.provenance;
    assert.ok(provenance.ruleId.length > 0, `${name} tax has no rule id`);
    assert.ok(provenance.sourceRef.length > 0, `${name} tax has no source`);
    assert.ok(
      provenance.note.length > 60,
      `${name} must say what a reviewer has to check before changing this figure`,
    );
  }
});

// ---------------------------------------------------------------------------- cross-module replay

for (const { name, fixture } of FIXTURES) {
  test(`${fixture.id}: replaying it through the real modules gives exactly the golden figures`, async () => {
    const actual = await replay(fixture);
    const mismatches = [...compareToExpected(fixture.expected, actual), ...compareRefusalReasons(fixture, actual)];
    assert.deepEqual(mismatches, [], describeMismatches(fixture, mismatches));
  });
}

test('a replay is deterministic: the same file twice gives the same figures', async () => {
  const fixture = loadFixture('wholesaler.json');
  const first = await replay(fixture);
  const second = await replay(fixture);
  assert.deepEqual(second, first, 'a fixture that drifts between runs cannot be a golden one');
});

test('the books of every example balance, whatever happened in it', async () => {
  for (const { fixture } of FIXTURES) {
    const actual = await replay(fixture);
    assert.equal(actual.trialBalanceBalanced, true, `${fixture.id} does not balance`);
    assert.equal(actual.totalDebits, actual.totalCredits, `${fixture.id} has uneven sides`);
  }
});

// --------------------------------------------------------------------------------------- mutation

const clone = (fixture: GoldenFixture): GoldenFixture => JSON.parse(JSON.stringify(fixture)) as GoldenFixture;

/** Runs the real comparison against a tampered expectation and demands that it complains. */
const mustCatch = async (what: string, tamper: (fixture: GoldenFixture) => void): Promise<void> => {
  const fixture = clone(loadFixture('bakery.json'));
  const actual = await replay(fixture);
  tamper(fixture);
  const mismatches = [...compareToExpected(fixture.expected, actual), ...compareRefusalReasons(fixture, actual)];
  assert.ok(mismatches.length > 0, `a wrong ${what} slipped through the golden comparison`);
};

test('a wrong ledger balance is caught', async () => {
  await mustCatch('ledger balance', (fixture) => {
    (fixture.expected.accounts as unknown as { balance: string }[])[0]!.balance = '9999.00';
  });
});

test('a wrong tax figure is caught', async () => {
  await mustCatch('central GST amount', (fixture) => {
    (fixture.expected.tax as { cgst: string }).cgst = '151.00';
  });
});

test('a wrong total is caught, even when both sides are changed together', async () => {
  await mustCatch('trial balance total', (fixture) => {
    (fixture.expected as { totalDebits: string }).totalDebits = '12601.00';
    (fixture.expected as { totalCredits: string }).totalCredits = '12601.00';
  });
});

test('a wrong stock figure is caught', async () => {
  await mustCatch('stock count', (fixture) => {
    (fixture.expected.stock as unknown as { physical: string }[])[0]!.physical = '21';
  });
});

test('an expected refusal that did not happen is caught', async () => {
  await mustCatch('refusal', (fixture) => {
    (fixture.expected as unknown as { refusals: string[] }).refusals = ['SALES_NEEDS_INFO'];
  });
});

test('a refusal that happened for a different reason than the fixture claims is caught', async () => {
  const fixture = clone(loadFixture('wholesaler.json'));
  const actual = await replay(fixture);

  // The oversale really is refused, and the code really does match — but the *reason* is changed.
  // Pinning only the code would let this through, which is why the reason is pinned too.
  for (const event of fixture.events) {
    if (event.kind === 'sale_refused') {
      (event as { expectedMessageContains: string }).expectedMessageContains = 'the customer has no credit left';
    }
  }
  const mismatches = compareRefusalReasons(fixture, actual);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0]?.what ?? '', /refused for the wrong reason/);
});

test('the schema refuses a fixture whose expected books do not balance', () => {
  const fixture = clone(loadFixture('bakery.json')) as unknown as { expected: { totalCredits: string } };
  fixture.expected.totalCredits = '1.00';
  const problems = validateFixture(fixture);
  assert.ok(problems.some((p) => p.path === 'expected.totalCredits'));
});

test('the schema refuses money written as a number, because that is a float', () => {
  const fixture = clone(loadFixture('bakery.json')) as unknown as { expected: { tax: { cgst: unknown } } };
  fixture.expected.tax.cgst = 150.5;
  const problems = validateFixture(fixture);
  assert.ok(problems.some((p) => p.path === 'expected.tax.cgst'));
});

test('the schema refuses a tax figure with no rule behind it', () => {
  const fixture = clone(loadFixture('bakery.json')) as unknown as { expected: { tax: { provenance: unknown } } };
  fixture.expected.tax.provenance = { ruleId: '', ruleVersion: '', sourceRef: '', effectiveFrom: '', note: '' };
  const problems = validateFixture(fixture);
  assert.ok(problems.some((p) => p.path.startsWith('expected.tax.provenance')));
});

test('the schema refuses tax parts that do not add up to the total', () => {
  const fixture = clone(loadFixture('bakery.json')) as unknown as { expected: { tax: { total: string } } };
  fixture.expected.tax.total = '400.00';
  const problems = validateFixture(fixture);
  assert.ok(problems.some((p) => p.path === 'expected.tax.total'));
});

test('the schema refuses a refusal that does not pin its reason', () => {
  const fixture = clone(loadFixture('wholesaler.json')) as unknown as { events: Record<string, unknown>[] };
  const refused = fixture.events.find((event) => event.kind === 'sale_refused') as Record<string, unknown>;
  refused.expectedMessageContains = '';
  const problems = validateFixture(fixture);
  assert.ok(problems.some((p) => p.path.endsWith('.expectedMessageContains')));
});
