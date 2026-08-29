/**
 * Issue #7 [E07] — `in.gst`, the compliance rules.
 *
 * **Every rule here is `DRAFT` and every `sourceRef` is a placeholder.** That is deliberate. A
 * compliance rule may not be `APPROVED` until issue #54 records the notification or circular it
 * comes from, its jurisdiction, its effective date and its reviewer. The engine in `production`
 * mode refuses a rule that is not `APPROVED`, so on a real business every topic below currently
 * answers `CANNOT_DECIDE` with an explanation — which is the correct behaviour, not a gap.
 *
 * The thresholds below are **placeholders chosen to exercise the arithmetic and the boundary
 * tests**. They are not a statement of Indian law and no module may copy a number out of this
 * file. When #54 supplies the sources, the values and the review state change together, in a new
 * rule-set version, and every decision made under the old version still replays exactly.
 */
import { compare, isoDate, toDecimalString, type Money } from '@invoice/kernel';
import type { FactSet } from '../facts.ts';
import type { Rule, RuleOutcome } from '../rule.ts';
import type { RuleSet } from '../registry.ts';
import { SUPPLY_FACTS, SUPPLIER_REGISTRATION_FACT, TRANSPORT_FACTS } from './facts.ts';

/** PLACEHOLDER value pending an official source under issue #54. */
const PLACEHOLDER_EWB_THRESHOLD: Money = { currency: 'INR', minor: 5000000n }; // ₹50,000.00
/** PLACEHOLDER value for the second version, so boundary and replay behaviour can be proved. */
const PLACEHOLDER_EWB_THRESHOLD_V2: Money = { currency: 'INR', minor: 7500000n }; // ₹75,000.00
/** PLACEHOLDER value for a state-specific override, so specificity can be proved. */
const PLACEHOLDER_EWB_THRESHOLD_DELHI: Money = { currency: 'INR', minor: 10000000n }; // ₹1,00,000.00

const asMoney = (facts: FactSet, id: string): Money => facts.value(id) as Money;

export const placeOfSupplyGoods: Rule = {
  id: 'gst.place_of_supply.goods',
  version: '2026.04.01',
  topic: 'gst.place_of_supply',
  kind: 'COMPLIANCE',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  priority: 100,
  requires: ['supply.type', 'supply.deliveryStateCode'],
  sourceRef: 'pending:#54/place-of-supply-goods',
  reviewState: 'DRAFT',
  explanation: {
    'en-IN': 'The goods are delivered to state {deliveryState}, so this sale counts in state {placeOfSupply}.',
    'hi-IN': 'Maal rajya {deliveryState} mein ja raha hai, isliye yeh bikri rajya {placeOfSupply} ki maani jayegi.',
  },
  evaluate: (facts): RuleOutcome => {
    if (facts.value('supply.type') !== 'GOODS') {
      // Services follow different rules, which this rule set does not cover yet.
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: ['supply.type'],
        explanationValues: {},
        missingFacts: ['supply.placeOfSupplyStateCode'],
      };
    }
    const delivery = String(facts.value('supply.deliveryStateCode'));
    return {
      outcome: 'ALLOW',
      usedFacts: ['supply.type', 'supply.deliveryStateCode'],
      explanationValues: { deliveryState: delivery, placeOfSupply: delivery },
      computed: { placeOfSupplyStateCode: delivery },
    };
  },
};

export const taxSplit: Rule = {
  id: 'gst.tax_split',
  version: '2026.04.01',
  topic: 'gst.tax_split',
  kind: 'COMPLIANCE',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  priority: 100,
  requires: ['supply.supplierStateCode', 'supply.placeOfSupplyStateCode'],
  sourceRef: 'pending:#54/intra-versus-inter-state',
  reviewState: 'DRAFT',
  explanation: {
    'en-IN': 'You are in state {supplierState} and this sale counts in state {placeOfSupply}, so {splitPlain}.',
    'hi-IN': 'Aap rajya {supplierState} mein hain aur yeh bikri rajya {placeOfSupply} ki hai, isliye {splitPlain}.',
  },
  evaluate: (facts): RuleOutcome => {
    const supplier = String(facts.value('supply.supplierStateCode'));
    const place = String(facts.value('supply.placeOfSupplyStateCode'));
    const intra = supplier === place;
    return {
      outcome: 'ALLOW',
      usedFacts: ['supply.supplierStateCode', 'supply.placeOfSupplyStateCode'],
      explanationValues: {
        supplierState: supplier,
        placeOfSupply: place,
        splitPlain: intra ? 'two separate GST amounts apply' : 'one combined GST applies',
      },
      computed: { split: intra ? 'CGST_SGST' : 'IGST', movement: intra ? 'INTRA_STATE' : 'INTER_STATE' },
    };
  },
};

const ewayFor = (
  version: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  threshold: Money,
  stateCode?: string,
): Rule => ({
  id: 'gst.eway.applicability',
  version,
  topic: 'gst.eway.applicability',
  kind: 'COMPLIANCE',
  jurisdiction: stateCode === undefined ? { country: 'IN' } : { country: 'IN', stateCode },
  effectiveFrom: isoDate(effectiveFrom),
  effectiveTo: effectiveTo === null ? null : isoDate(effectiveTo),
  priority: 100,
  requires: ['consignment.value', 'movement.type', 'movement.mode'],
  sourceRef: 'pending:#54/e-way-bill-applicability',
  reviewState: 'DRAFT',
  explanation: {
    'en-IN': 'The goods are worth {value} and the limit for this kind of movement is {threshold}, so a permit is {verdict}.',
    'hi-IN': 'Maal ki keemat {value} hai aur is tarah ke movement ki seema {threshold} hai, isliye permit {verdict}.',
  },
  evaluate: (facts): RuleOutcome => {
    const value = asMoney(facts, 'consignment.value');
    const overThreshold = compare(value, threshold) >= 0;
    return {
      outcome: overThreshold ? 'REQUIRED' : 'NOT_REQUIRED',
      usedFacts: ['consignment.value', 'movement.type', 'movement.mode'],
      explanationValues: {
        value: toDecimalString(value),
        threshold: toDecimalString(threshold),
        verdict: overThreshold ? 'needed' : 'not needed',
      },
      computed: { thresholdApplied: toDecimalString(threshold), overThreshold: String(overThreshold) },
    };
  },
});

/**
 * Three e-way rules, which together exercise every selection path the engine has:
 * a first version, a second that takes over on a later date, and a state-specific override that
 * beats both inside one state.
 */
export const ewayV1 = ewayFor('2026.04.01', '2026-04-01', '2026-06-30', PLACEHOLDER_EWB_THRESHOLD);
export const ewayV2 = ewayFor('2026.07.01', '2026-07-01', null, PLACEHOLDER_EWB_THRESHOLD_V2);
export const ewayDelhi = ewayFor('2026.04.01-DL', '2026-04-01', null, PLACEHOLDER_EWB_THRESHOLD_DELHI, '07');

export const GST_RULE_SET: RuleSet = {
  id: 'in.gst',
  version: '2026.04.01',
  publishedOn: isoDate('2026-04-01'),
  facts: [...SUPPLY_FACTS, ...TRANSPORT_FACTS],
  rules: [placeOfSupplyGoods, taxSplit, ewayV1, ewayV2, ewayDelhi],
};

/**
 * PLACEHOLDER list of union territories whose supplies carry UTGST rather than SGST, pending an
 * official source under issue #54. Like every value in this file it is a fixture, not a statement
 * of law, and it lives in a DRAFT rule that production mode refuses.
 */
const PLACEHOLDER_UTGST_STATE_CODES: ReadonlySet<string> = new Set(['04', '26', '31', '35', '38']);

/**
 * The second published version of the split rule. It answers the same question as
 * `2026.04.01` and additionally distinguishes a union territory, which the first version could
 * not. Published as a **new rule-set version** rather than an edit, so every decision made under
 * the first version still replays exactly.
 */
export const taxSplitWithUnionTerritories: Rule = {
  ...taxSplit,
  version: '2026.05.01',
  requires: ['supply.supplierStateCode', 'supply.placeOfSupplyStateCode'],
  explanation: {
    'en-IN': 'You are in state {supplierState} and this sale counts in state {placeOfSupply}, so {splitPlain}.',
    'hi-IN': 'Aap rajya {supplierState} mein hain aur yeh bikri rajya {placeOfSupply} ki hai, isliye {splitPlain}.',
  },
  evaluate: (facts): RuleOutcome => {
    const supplier = String(facts.value('supply.supplierStateCode'));
    const place = String(facts.value('supply.placeOfSupplyStateCode'));
    const intra = supplier === place;
    const unionTerritory = intra && PLACEHOLDER_UTGST_STATE_CODES.has(place);
    return {
      outcome: 'ALLOW',
      usedFacts: ['supply.supplierStateCode', 'supply.placeOfSupplyStateCode'],
      explanationValues: {
        supplierState: supplier,
        placeOfSupply: place,
        splitPlain: intra ? 'two separate GST amounts apply' : 'one combined GST applies',
      },
      computed: {
        split: intra ? (unionTerritory ? 'CGST_UTGST' : 'CGST_SGST') : 'IGST',
        movement: intra ? 'INTRA_STATE' : 'INTER_STATE',
      },
    };
  },
};

/**
 * Whether a business on the composition scheme may charge GST on its bill.
 *
 * DRAFT and placeholder like everything else here. It exists so the calculator asks a rule rather
 * than hard-coding the answer, which is the whole point of issue #7.
 */
export const compositionCharging: Rule = {
  id: 'gst.composition.charging',
  version: '2026.05.01',
  topic: 'gst.composition.charging',
  kind: 'COMPLIANCE',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  priority: 100,
  requires: ['supply.supplierRegistration'],
  sourceRef: 'pending:#54/composition-scheme-invoicing',
  reviewState: 'DRAFT',
  explanation: {
    'en-IN': 'Your business is registered as {registration}, so GST {verdict} be charged on this bill.',
    'hi-IN': 'Aapka business {registration} ke roop mein registered hai, isliye is bill par GST {verdict}.',
  },
  evaluate: (facts): RuleOutcome => {
    const registration = String(facts.value('supply.supplierRegistration'));
    const mayCharge = registration === 'REGULAR';
    return {
      outcome: mayCharge ? 'ALLOW' : 'BLOCK',
      usedFacts: ['supply.supplierRegistration'],
      explanationValues: { registration, verdict: mayCharge ? 'can' : 'cannot' },
      computed: { mayChargeGst: String(mayCharge) },
    };
  },
};

/**
 * `in.gst@2026.05.01` — adds union-territory handling and the composition question. The April
 * version stays registered so past decisions replay under the rules they actually used.
 */
export const GST_RULE_SET_V2: RuleSet = {
  id: 'in.gst',
  version: '2026.05.01',
  publishedOn: isoDate('2026-05-01'),
  facts: [...SUPPLY_FACTS, ...TRANSPORT_FACTS, SUPPLIER_REGISTRATION_FACT],
  rules: [placeOfSupplyGoods, taxSplitWithUnionTerritories, compositionCharging, ewayV1, ewayV2, ewayDelhi],
};

export const GST_PLACEHOLDER_THRESHOLDS = {
  ewbAllIndiaV1: PLACEHOLDER_EWB_THRESHOLD,
  ewbAllIndiaV2: PLACEHOLDER_EWB_THRESHOLD_V2,
  ewbDelhi: PLACEHOLDER_EWB_THRESHOLD_DELHI,
} as const;
