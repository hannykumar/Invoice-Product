/**
 * Issue #7 [E07] acceptance criteria, enforced automatically.
 *
 *  - "The same facts and rule version produce the same result"
 *  - "Past transactions can be replayed under the rules effective at that date"
 *  - "Every compliance decision shows evidence and missing facts"
 *
 * plus the required boundary-date, threshold and conflicting-rule tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, fromDecimalString, isoDate, rupees, toDecimalString } from '@invoice/kernel';
import { FactSet } from '../src/facts.ts';
import { RulesEngine } from '../src/engine.ts';
import { RuleRegistry, validateRuleSet, type RuleSet } from '../src/registry.ts';
import { shippedRegistry, GST_RULE_SET, GST_RULE_SET_V2, GST_RULE_SET_APPROVED, POLICY_RULE_SET, GST_PLACEHOLDER_THRESHOLDS } from '../src/rulesets/index.ts';
import { toExceptionDraft } from '../src/exceptions.ts';
import type { Rule } from '../src/rule.ts';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';

const devEngine = (ruleSetId: string): RulesEngine =>
  new RulesEngine({ registry: shippedRegistry(), ruleSetId, mode: 'development' });
const prodEngine = (ruleSetId: string): RulesEngine =>
  new RulesEngine({ registry: shippedRegistry(), ruleSetId, mode: 'production' });

const transportFacts = (valueRupees: number) =>
  FactSet.of({
    'consignment.value': rupees(valueRupees),
    'movement.type': 'INTER_STATE',
    'movement.mode': 'ROAD',
  });

test('the same facts and rule-set version produce an identical decision, every time', () => {
  const engine = devEngine('in.gst');
  const facts = transportFacts(60000);
  const first = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-05-12') });
  const second = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-05-12') });
  assert.deepEqual(second.decision, first.decision);
  assert.equal(second.decision.decisionFingerprint, first.decision.decisionFingerprint);
});

test('the order facts were supplied in cannot change the answer', () => {
  const engine = devEngine('in.gst');
  const a = new FactSet({
    'consignment.value': { value: rupees(60000), source: 'USER' },
    'movement.type': { value: 'INTER_STATE', source: 'USER' },
    'movement.mode': { value: 'ROAD', source: 'USER' },
  });
  const b = new FactSet({
    'movement.mode': { value: 'ROAD', source: 'USER' },
    'consignment.value': { value: rupees(60000), source: 'USER' },
    'movement.type': { value: 'INTER_STATE', source: 'USER' },
  });
  const one = engine.evaluate({ topic: 'gst.eway.applicability', facts: a, documentDate: isoDate('2026-05-12') });
  const two = engine.evaluate({ topic: 'gst.eway.applicability', facts: b, documentDate: isoDate('2026-05-12') });
  assert.equal(two.decision.decisionFingerprint, one.decision.decisionFingerprint);
  assert.equal(two.decision.factsFingerprint, one.decision.factsFingerprint);
});

test('a threshold is decided at the boundary, not near it', () => {
  const engine = devEngine('in.gst');
  const threshold = GST_PLACEHOLDER_THRESHOLDS.ewbAllIndiaV1;
  const at = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: FactSet.of({ 'consignment.value': threshold, 'movement.type': 'INTER_STATE', 'movement.mode': 'ROAD' }),
    documentDate: isoDate('2026-05-12'),
  });
  assert.equal(at.decision.outcome, 'REQUIRED', 'exactly at the limit counts as reaching it');

  const justUnder = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: FactSet.of({
      'consignment.value': { currency: 'INR', minor: threshold.minor - 1n },
      'movement.type': 'INTER_STATE',
      'movement.mode': 'ROAD',
    }),
    documentDate: isoDate('2026-05-12'),
  });
  assert.equal(justUnder.decision.outcome, 'NOT_REQUIRED', 'one paisa under the limit is under the limit');
});

test('the rule in force on the document date is the one that applies, not the newest', () => {
  const engine = devEngine('in.gst');
  const facts = transportFacts(60000);

  const june = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-06-30') });
  assert.equal(june.decision.outcome, 'REQUIRED');
  assert.equal(june.decision.ruleVersion, '2026.04.01');
  assert.equal(june.decision.computed.thresholdApplied, '50000.00');

  const july = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-07-01') });
  assert.equal(july.decision.outcome, 'NOT_REQUIRED', 'the same ₹60,000 falls under the later limit');
  assert.equal(july.decision.ruleVersion, '2026.07.01');
  assert.equal(july.decision.computed.thresholdApplied, '75000.00');
});

test('a past decision replays exactly, even after the rule has been superseded', () => {
  const engine = devEngine('in.gst');
  const facts = transportFacts(60000);
  const madeInJune = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-06-30') }).decision;

  // Months later, under a newer rule, the June decision must still reproduce.
  const replayed = engine.replay(madeInJune, facts);
  assert.equal(replayed.matches, true);
  assert.equal(replayed.decision.outcome, 'REQUIRED');
  assert.equal(replayed.decision.decisionFingerprint, madeInJune.decisionFingerprint);
});

test('a replay reports a mismatch when a released rule set has been edited', () => {
  const engine = devEngine('in.gst');
  const facts = transportFacts(60000);
  const original = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-05-12') }).decision;

  // Someone edits a published rule set in place instead of publishing a new version.
  const tamper = (set: RuleSet): RuleSet => ({
    ...set,
    rules: set.rules.map((r) =>
      r.id === 'gst.eway.applicability' && r.version === '2026.04.01'
        ? ({ ...r, evaluate: () => ({ outcome: 'NOT_REQUIRED' as const, usedFacts: [], explanationValues: { value: '0.00', threshold: '0.00', verdict: 'not needed' } }) } as Rule)
        : r,
    ),
  });
  const tamperedEngine = new RulesEngine({
    registry: new RuleRegistry()
      .register(POLICY_RULE_SET)
      .register(tamper(GST_RULE_SET))
      .register(tamper(GST_RULE_SET_V2))
      .register(tamper(GST_RULE_SET_APPROVED)),
    ruleSetId: 'in.gst',
    mode: 'development',
  });
  const replayed = tamperedEngine.replay(original, facts);
  assert.equal(replayed.matches, false, 'editing a released rule set must be detectable');
});

test('a state-specific rule beats an all-India rule inside that state', () => {
  const engine = devEngine('in.gst');
  const facts = transportFacts(60000);

  const allIndia = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-05-12') });
  assert.equal(allIndia.decision.outcome, 'REQUIRED');

  const inDelhi = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts,
    documentDate: isoDate('2026-05-12'),
    stateCode: '07',
  });
  assert.equal(inDelhi.decision.ruleVersion, '2026.04.01-DL');
  assert.equal(inDelhi.decision.outcome, 'NOT_REQUIRED', '₹60,000 is under the state-specific limit');
  assert.ok(
    inDelhi.trace.considered.some((c) => c.reason === 'less-specific'),
    'the trace must say the all-India rule was set aside for being less specific',
  );
});

test('two rules that tie are never broken arbitrarily; a person decides', () => {
  const base = GST_RULE_SET.rules.find((r) => r.id === 'gst.tax_split') as Rule;
  const twin: Rule = { ...base, id: 'gst.tax_split.alternative', version: '2026.04.01' };
  const conflicting: RuleSet = { ...GST_RULE_SET, version: '2026.04.02-conflict', rules: [base, twin] };
  const engine = new RulesEngine({
    registry: new RuleRegistry().register(conflicting),
    ruleSetId: 'in.gst',
    mode: 'development',
  });

  const result = engine.evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of({ 'supply.supplierStateCode': '07', 'supply.placeOfSupplyStateCode': '07' }),
    documentDate: isoDate('2026-05-12'),
    ruleSetVersion: '2026.04.02-conflict',
  });

  assert.equal(result.decision.outcome, 'CANNOT_DECIDE');
  assert.deepEqual(result.trace.unresolvedConflict, ['gst.tax_split.alternative@2026.04.01', 'gst.tax_split@2026.04.01']);
  assert.match(result.decision.explanation['en-IN'], /disagree/);
});

test('a missing fact stops the decision and says what is needed, in the user’s words', () => {
  const engine = devEngine('in.gst');
  const result = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: FactSet.of({ 'movement.type': 'INTER_STATE', 'movement.mode': 'ROAD' }),
    documentDate: isoDate('2026-05-12'),
  });

  assert.equal(result.decision.outcome, 'CANNOT_DECIDE');
  assert.deepEqual(
    result.decision.missingFacts.map((m) => m.factId),
    ['consignment.value'],
  );
  assert.equal(result.decision.missingFacts[0]?.label, 'Value of the goods being moved');
  assert.match(result.decision.missingFacts[0]?.whyNeeded ?? '', /decides whether a permit is needed/);
  assert.match(result.decision.explanation['en-IN'], /We still need: Value of the goods being moved/);
  assert.ok(result.decision.evidence.length > 0, 'what we already knew must still be shown');
});

test('every decision carries the evidence it used, with where each fact came from', () => {
  const engine = devEngine('in.gst');
  const facts = new FactSet({
    'consignment.value': { value: rupees(60000), source: 'DOCUMENT' },
    'movement.type': { value: 'INTER_STATE', source: 'DERIVED' },
    'movement.mode': { value: 'ROAD', source: 'MODEL', confidence: 0.62 },
  });
  const { decision } = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts,
    documentDate: isoDate('2026-05-12'),
  });

  assert.deepEqual(decision.evidence.map((e) => e.factId), ['consignment.value', 'movement.type', 'movement.mode']);
  assert.equal(decision.evidence[0]?.value, '60000.00');
  assert.equal(decision.evidence[0]?.source, 'DOCUMENT');
  assert.equal(decision.evidence[2]?.source, 'MODEL');
  assert.equal(decision.evidence[2]?.confidence, 0.62);
  assert.equal(decision.sourceRef, 'pending:#54/e-way-bill-applicability');
  assert.equal(decision.ruleKind, 'COMPLIANCE');
  assert.equal(decision.effectiveFrom, '2026-04-01');
});

test('in production, an unreviewed compliance rule decides nothing', () => {
  const engine = prodEngine('in.gst');
  const result = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: transportFacts(60000),
    documentDate: isoDate('2026-05-12'),
  });
  assert.equal(result.decision.outcome, 'CANNOT_DECIDE');
  assert.equal(result.decision.ruleId, null);
  assert.ok(result.trace.considered.every((c) => !c.used), 'no rule may be used');
  assert.ok(
    result.trace.considered.some((c) => c.reason === 'not-approved'),
    'the trace must say the rule was set aside for having no reviewed source',
  );
  assert.match(result.decision.explanation['en-IN'], /we will not put a figure on this/);
});

test('in production, an approved policy rule decides normally', () => {
  const engine = prodEngine('in.policy');
  const { decision } = engine.evaluate({
    topic: 'invoice.rounding',
    facts: FactSet.of({ 'invoice.totalBeforeRounding': fromDecimalString('1179.99') }),
    documentDate: isoDate('2026-04-10'),
  });
  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.computed.roundedTotal, '1180.00');
  assert.equal(decision.computed.roundOffAmount, '0.01');
  assert.equal(decision.ruleReviewState, 'APPROVED');
  assert.equal(decision.sourceRef, 'policy:invoice-rounding-v1');
});

test('a topic with no rule at all is refused, not approximated', () => {
  const engine = devEngine('in.gst');
  const { decision } = engine.evaluate({
    topic: 'gst.export.zero_rating',
    facts: FactSet.of({ 'supply.type': 'GOODS' }),
    documentDate: isoDate('2026-05-12'),
  });
  assert.equal(decision.outcome, 'CANNOT_DECIDE');
  assert.equal(decision.ruleId, null);
});

test('a rule can refuse a case it does not cover, rather than answering wrongly', () => {
  const engine = devEngine('in.gst');
  // A service with no recorded customer state: the approved services rule needs it, and refuses.
  const { decision } = engine.evaluate({
    topic: 'gst.place_of_supply',
    facts: FactSet.of({ 'supply.type': 'SERVICES', 'supply.recipientRegistered': true }),
    documentDate: isoDate('2026-05-12'),
  });
  assert.equal(decision.outcome, 'CANNOT_DECIDE');
  assert.deepEqual(decision.missingFacts.map((m) => m.factId), ['supply.recipientStateCode']);
});

test('the worked examples come out right (golden cases)', () => {
  const gst = devEngine('in.gst');
  const policy = devEngine('in.policy');

  // Worked example 3: Delhi seller, Delhi buyer, two separate GST amounts.
  const intra = gst.evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of({
      'supply.supplierStateCode': '07',
      'supply.placeOfSupplyStateCode': '07',
      'supply.placeOfSupplyStateName': 'Delhi',
    }),
    documentDate: isoDate('2026-04-10'),
  });
  assert.equal(intra.decision.computed.split, 'CGST_SGST');
  assert.match(intra.decision.explanation['en-IN'], /two separate GST amounts apply/);

  // Worked example 2: Maharashtra supplier, Delhi place of supply, one combined GST.
  const inter = gst.evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of({ 'supply.supplierStateCode': '27', 'supply.placeOfSupplyStateCode': '07' }),
    documentDate: isoDate('2026-04-06'),
  });
  assert.equal(inter.decision.computed.split, 'IGST');

  // Worked example 4: 30 available, 70 needed, 40 missing.
  const stock = policy.evaluate({
    topic: 'stock.availability',
    facts: FactSet.of({ 'stock.availableScaled': 30, 'stock.requiredScaled': 70, 'stock.unit': 'boxes' }),
    documentDate: isoDate('2026-04-12'),
  });
  assert.equal(stock.decision.outcome, 'BLOCK');
  assert.equal(stock.decision.computed.shortfall, '40');
  assert.match(stock.decision.explanation['en-IN'], /so 40 boxes are missing/);

  // The credit-limit example from issue #11's description.
  const credit = policy.evaluate({
    topic: 'sales.credit_limit',
    facts: FactSet.of({
      'party.creditLimit': rupees(100000),
      'party.outstanding': rupees(50000),
      'party.pendingValue': rupees(0),
      'sale.value': rupees(60000),
    }),
    documentDate: isoDate('2026-04-15'),
  });
  assert.equal(credit.decision.outcome, 'WARN');
  assert.equal(credit.decision.computed.excess, '10000.00');
  assert.equal(credit.decision.computed.overLimit, 'true');
});

test('a decision that cannot be made becomes one piece of work for a person, not two', () => {
  const engine = devEngine('in.gst');
  const { decision } = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: FactSet.of({ 'movement.type': 'INTER_STATE', 'movement.mode': 'ROAD' }),
    documentDate: isoDate('2026-05-12'),
  });
  const source = { kind: 'sales_invoice', id: 'si-44' };
  const draft = toExceptionDraft(decision, source);
  assert.ok(draft !== null);
  assert.equal(draft.kind, 'RULE_CANNOT_DECIDE');
  assert.equal(draft.needs[0]?.factId, 'consignment.value');
  assert.deepEqual(toExceptionDraft(decision, source), draft, 'the same decision produces the same key');

  const decided = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: transportFacts(60000),
    documentDate: isoDate('2026-05-12'),
  }).decision;
  assert.equal(toExceptionDraft(decided, source), null, 'a decision that was made never queues an exception');
});

test('simulation changes nothing and answers the same as a real evaluation', () => {
  const engine = devEngine('in.gst');
  const facts = transportFacts(60000);
  const real = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-05-12') });
  const whatIf = engine.simulate({
    topic: 'gst.eway.applicability',
    facts: FactSet.of({ 'consignment.value': rupees(40000), 'movement.type': 'INTER_STATE', 'movement.mode': 'ROAD' }),
    documentDate: isoDate('2026-05-12'),
  });
  assert.equal(whatIf.decision.outcome, 'NOT_REQUIRED');
  const again = engine.evaluate({ topic: 'gst.eway.applicability', facts, documentDate: isoDate('2026-05-12') });
  assert.equal(again.decision.decisionFingerprint, real.decision.decisionFingerprint, 'simulating must leave nothing behind');
});

test('a rule set that is not well formed is refused before anyone can decide with it', () => {
  const good = GST_RULE_SET.rules[0] as Rule;

  const approvedWithoutSource: RuleSet = {
    ...GST_RULE_SET,
    version: 'bad-1',
    rules: [{ ...good, reviewState: 'APPROVED', sourceRef: null }],
  };
  assert.throws(() => validateRuleSet(approvedWithoutSource), (e: unknown) =>
    e instanceof DomainError && e.code === 'RULES_APPROVED_WITHOUT_SOURCE');

  const unknownFact: RuleSet = { ...GST_RULE_SET, version: 'bad-2', rules: [{ ...good, requires: ['no.such.fact'] }] };
  assert.throws(() => validateRuleSet(unknownFact), (e: unknown) =>
    e instanceof DomainError && e.code === 'RULES_UNKNOWN_FACT');

  const mismatchedExplanation: RuleSet = {
    ...GST_RULE_SET,
    version: 'bad-3',
    rules: [{ ...good, explanation: { 'en-IN': 'Goods go to {deliveryState}.', 'hi-IN': 'Maal ja raha hai.' } }],
  };
  assert.throws(() => validateRuleSet(mismatchedExplanation), (e: unknown) =>
    e instanceof DomainError && e.code === 'RULES_EXPLANATION_MISMATCH');

  const duplicated: RuleSet = { ...GST_RULE_SET, version: 'bad-4', rules: [good, good] };
  assert.throws(() => validateRuleSet(duplicated), (e: unknown) =>
    e instanceof DomainError && e.code === 'RULES_DUPLICATE_RULE');

  const backwards: RuleSet = {
    ...GST_RULE_SET,
    version: 'bad-5',
    rules: [{ ...good, effectiveFrom: isoDate('2026-06-01'), effectiveTo: isoDate('2026-05-01') }],
  };
  assert.throws(() => validateRuleSet(backwards), (e: unknown) =>
    e instanceof DomainError && e.code === 'RULES_BAD_EFFECTIVE_RANGE');
});

test('a decision made under a rule set that is no longer registered cannot be silently re-answered', () => {
  const engine = devEngine('in.gst');
  const decision = engine.evaluate({
    topic: 'gst.eway.applicability',
    facts: transportFacts(60000),
    documentDate: isoDate('2026-05-12'),
  }).decision;
  const emptyRegistry = new RulesEngine({ registry: new RuleRegistry(), ruleSetId: 'in.gst', mode: 'development' });
  assert.throws(() => emptyRegistry.replay(decision, transportFacts(60000)), (e: unknown) =>
    e instanceof DomainError && e.code === 'RULES_SET_NOT_FOUND');
});

test('every explanation a rule can produce is understandable without accounting training', () => {
  const engine = devEngine('in.gst');
  const policy = devEngine('in.policy');
  const rendered = [
    engine.evaluate({ topic: 'gst.eway.applicability', facts: transportFacts(60000), documentDate: isoDate('2026-05-12') }),
    engine.evaluate({
      topic: 'gst.tax_split',
      facts: FactSet.of({ 'supply.supplierStateCode': '07', 'supply.placeOfSupplyStateCode': '06' }),
      documentDate: isoDate('2026-05-12'),
    }),
    engine.evaluate({
      topic: 'gst.place_of_supply',
      facts: FactSet.of({ 'supply.type': 'GOODS', 'supply.deliveryStateCode': '06' }),
      documentDate: isoDate('2026-05-12'),
    }),
    policy.evaluate({
      topic: 'invoice.rounding',
      facts: FactSet.of({ 'invoice.totalBeforeRounding': fromDecimalString('1179.99') }),
      documentDate: isoDate('2026-04-10'),
    }),
    policy.evaluate({
      topic: 'stock.availability',
      facts: FactSet.of({ 'stock.availableScaled': 30, 'stock.requiredScaled': 70, 'stock.unit': 'boxes' }),
      documentDate: isoDate('2026-04-12'),
    }),
  ];
  const problems: string[] = [];
  for (const r of rendered) {
    for (const locale of ['en-IN', 'hi-IN'] as const) {
      for (const issue of lintUserFacingText(r.decision.explanation[locale], { locale, allow: ['gst'] })) {
        problems.push(`${r.decision.ruleId} (${locale}): ${issue.rule} — ${issue.detail}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('a rule is a pure function: it cannot reach anything but its facts', () => {
  for (const set of [GST_RULE_SET, POLICY_RULE_SET]) {
    for (const rule of set.rules) {
      assert.equal(rule.evaluate.constructor.name, 'Function', `${rule.id} must be synchronous`);
      assert.equal(rule.evaluate.length, 1, `${rule.id} must receive facts and nothing else`);
    }
  }
  // Calling a rule twice with the same facts gives the same object, with no accumulated state.
  const rule = POLICY_RULE_SET.rules.find((r) => r.id === 'invoice.rounding') as Rule;
  const facts = FactSet.of({ 'invoice.totalBeforeRounding': fromDecimalString('1179.99') });
  assert.deepEqual(rule.evaluate(facts), rule.evaluate(facts));
  assert.equal(toDecimalString(fromDecimalString('1179.99')), '1179.99', 'the facts themselves were not mutated');
});
