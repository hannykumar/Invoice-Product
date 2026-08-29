/**
 * Issue #54 [X06] — the rules that the compliance-source register vouches for.
 *
 * Each test name here appears in `packages/compliance-register/src/rule-links.ts`, so the trace
 * from a decision to its source to its test is mechanical rather than a research exercise. A test
 * in the register that does not exist here fails the register's own audit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate } from '@invoice/kernel';
import { defaultRegister } from '@invoice/compliance-register';
import { FactSet } from '../src/facts.ts';
import { RulesEngine } from '../src/engine.ts';
import { shippedRegistry } from '../src/rulesets/index.ts';

/** Production refuses anything the register has not approved. That is the point of these tests. */
const production = (): RulesEngine =>
  new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' });

const APRIL = isoDate('2026-04-10');

test('goods that move take the place of supply where the movement ends', () => {
  const { decision } = production().evaluate({
    topic: 'gst.place_of_supply',
    facts: FactSet.of({ 'supply.type': 'GOODS', 'supply.deliveryStateCode': '06' }, 'MASTER_DATA'),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.computed.placeOfSupplyStateCode, '06');
  assert.equal(decision.ruleReviewState, 'APPROVED');
  assert.equal(decision.sourceRef, 'igst-act-2017-s10-1-a');
  assert.equal(decision.computed.basis, 'IGST Act section 10(1)(a)');
});

test('a case the source does not cover is refused, not approximated', () => {
  const { decision } = production().evaluate({
    topic: 'gst.place_of_supply',
    facts: FactSet.of(
      { 'supply.type': 'GOODS', 'supply.deliveryStateCode': '06', 'supply.involvesMovement': false },
      'USER',
    ),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'CANNOT_DECIDE', 'goods that do not move follow a clause we have not added');
});

test('services to a registered person take that person’s location', () => {
  const { decision } = production().evaluate({
    topic: 'gst.place_of_supply',
    facts: FactSet.of(
      { 'supply.type': 'SERVICES', 'supply.recipientRegistered': true, 'supply.recipientStateCode': '27' },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.computed.placeOfSupplyStateCode, '27');
  assert.equal(decision.sourceRef, 'igst-act-2017-s12-2');
  assert.match(decision.explanation['en-IN'], /a customer registered for GST/);
});

test('services to an unregistered person need a recorded address', () => {
  const withAddress = production().evaluate({
    topic: 'gst.place_of_supply',
    facts: FactSet.of(
      { 'supply.type': 'SERVICES', 'supply.recipientRegistered': false, 'supply.recipientStateCode': '29' },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  }).decision;
  assert.equal(withAddress.outcome, 'ALLOW');
  assert.equal(withAddress.computed.placeOfSupplyStateCode, '29');

  const without = production().evaluate({
    topic: 'gst.place_of_supply',
    facts: FactSet.of({ 'supply.type': 'SERVICES', 'supply.recipientRegistered': false }, 'MASTER_DATA'),
    documentDate: APRIL,
  }).decision;
  assert.equal(without.outcome, 'CANNOT_DECIDE');
  assert.deepEqual(without.missingFacts.map((m) => m.factId), ['supply.recipientStateCode']);
});

test('same state means two taxes, different states mean one', () => {
  const intra = production().evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of(
      {
        'supply.supplierStateCode': '29',
        'supply.placeOfSupplyStateCode': '29',
        'supply.placeOfSupplyStateName': 'Karnataka',
      },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  }).decision;
  assert.equal(intra.outcome, 'ALLOW');
  assert.equal(intra.computed.split, 'CGST_SGST');
  assert.equal(intra.computed.movement, 'INTRA_STATE');
  assert.equal(intra.computed.basis, 'IGST Act section 8');
  assert.equal(intra.ruleReviewState, 'APPROVED');

  const inter = production().evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of(
      {
        'supply.supplierStateCode': '27',
        'supply.placeOfSupplyStateCode': '29',
        'supply.placeOfSupplyStateName': 'Karnataka',
      },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  }).decision;
  assert.equal(inter.computed.split, 'IGST');
  assert.equal(inter.computed.movement, 'INTER_STATE');
  assert.equal(inter.computed.basis, 'IGST Act section 7');
});

test('a union territory in the UTGST Act carries union territory tax', () => {
  const { decision } = production().evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of(
      {
        'supply.supplierStateCode': '04',
        'supply.placeOfSupplyStateCode': '04',
        'supply.placeOfSupplyStateName': 'Chandigarh',
      },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  });
  assert.equal(decision.computed.split, 'CGST_UTGST');
  assert.equal(decision.computed.basis, 'IGST Act section 8 with UTGST Act section 7');
});

test('Delhi is a union territory but carries State tax', () => {
  // The master-data table marks Delhi `union: true`. The UTGST Act's extent clause does not name
  // it, so State tax applies. Reading the flag instead would mis-tax a very large number of bills.
  const { decision } = production().evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of(
      {
        'supply.supplierStateCode': '07',
        'supply.placeOfSupplyStateCode': '07',
        'supply.placeOfSupplyStateName': 'Delhi',
      },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  });
  assert.equal(decision.computed.split, 'CGST_SGST');
  assert.equal(decision.computed.basis, 'IGST Act section 8');
});

test('Ladakh is refused rather than guessed', () => {
  const { decision } = production().evaluate({
    topic: 'gst.tax_split',
    facts: FactSet.of(
      {
        'supply.supplierStateCode': '38',
        'supply.placeOfSupplyStateCode': '38',
        'supply.placeOfSupplyStateName': 'Ladakh',
      },
      'MASTER_DATA',
    ),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'CANNOT_DECIDE');
  const entry = defaultRegister().decisions().find((d) => d.id === 'dl-ladakh-utgst');
  assert.ok(entry !== undefined, 'the refusal must be explained in the decision log');
  assert.match(entry.whatWouldResolveIt, /amended by the Finance Act 2020/);
});

test('a business on the composition scheme charges no tax', () => {
  const { decision } = production().evaluate({
    topic: 'gst.composition.charging',
    facts: FactSet.of({ 'supply.supplierRegistration': 'COMPOSITION' }, 'MASTER_DATA'),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'BLOCK');
  assert.equal(decision.computed.mayChargeGst, 'false');
  assert.equal(decision.sourceRef, 'cgst-act-2017-s10-4');
  assert.equal(decision.ruleReviewState, 'APPROVED');
  assert.match(decision.explanation['en-IN'], /GST cannot be charged/);
});

test('an ordinary registered business charges tax normally', () => {
  const { decision } = production().evaluate({
    topic: 'gst.composition.charging',
    facts: FactSet.of({ 'supply.supplierRegistration': 'REGULAR' }, 'MASTER_DATA'),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.computed.mayChargeGst, 'true');
});

test('the e-way rule is still refused in production, because its numbers have no source', () => {
  const { decision } = production().evaluate({
    topic: 'gst.eway.applicability',
    facts: FactSet.of({ 'consignment.value': { currency: 'INR', minor: 10000000n }, 'movement.type': 'INTER_STATE', 'movement.mode': 'ROAD' }),
    documentDate: APRIL,
  });
  assert.equal(decision.outcome, 'CANNOT_DECIDE');
  assert.equal(decision.ruleId, null);
});

test('a rule marked APPROVED that the register will not vouch for cannot be loaded at all', async () => {
  const { RuleRegistry } = await import('../src/registry.ts');
  const { GST_RULE_SET_APPROVED } = await import('../src/rulesets/gst-approved.ts');
  const forged = {
    ...GST_RULE_SET_APPROVED,
    version: 'forged',
    rules: GST_RULE_SET_APPROVED.rules.map((r) =>
      r.id === 'gst.eway.applicability' && r.version === '2026.04.01'
        ? { ...r, reviewState: 'APPROVED' as const, sourceRef: 'pending:#54/e-way-bill-applicability' }
        : r,
    ),
  };
  assert.throws(
    () => new RuleRegistry().register(forged),
    (e: unknown) => e instanceof Error && /register refuses it/.test(e.message),
  );
});
