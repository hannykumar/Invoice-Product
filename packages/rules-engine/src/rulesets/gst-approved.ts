/**
 * Issue #54 [X06] — `in.gst@2026.08.29`, the first rule set whose compliance rules are APPROVED.
 *
 * Every rule here cites a provision that was retrieved from the publisher's own site and quoted in
 * `packages/compliance-register/src/sources.ts`. `validateRuleSet` refuses to load an APPROVED
 * compliance rule that the register does not vouch for, so the citation is a gate rather than a
 * comment.
 *
 * What is deliberately still refused, and why, is in the decision log:
 *   - Ladakh, because the amended UTGST extent clause could not be read first-hand;
 *   - every place-of-supply clause except goods-in-movement and the general services rule;
 *   - e-way applicability and every GST rate, because their numbers have no source yet.
 *
 * Refusing produces `CANNOT_DECIDE` and an exception item. It never produces a plausible number.
 */
import { isoDate } from '@invoice/kernel';
import { UTGST_PENDING_VERIFICATION_NAMES, UTGST_TERRITORY_NAMES } from '@invoice/compliance-register';
import { SUPPLY_FACTS, SUPPLIER_REGISTRATION_FACT, TRANSPORT_FACTS, PLACE_OF_SUPPLY_FACTS } from './facts.ts';
import type { Rule, RuleOutcome } from '../rule.ts';
import type { RuleSet } from '../registry.ts';
import { compositionCharging, ewayDelhi, ewayV1, ewayV2 } from './gst.ts';

const APPROVED_VERSION = '2026.08.29';

const utgstNames = new Set(UTGST_TERRITORY_NAMES);
const pendingNames = new Set(UTGST_PENDING_VERIFICATION_NAMES);

/**
 * IGST Act section 10(1)(a): where a supply involves movement, the place of supply is where the
 * movement ends for delivery to the recipient.
 */
export const placeOfSupplyGoodsApproved: Rule = {
  id: 'gst.place_of_supply.goods',
  version: APPROVED_VERSION,
  topic: 'gst.place_of_supply',
  kind: 'COMPLIANCE',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2017-07-01'),
  effectiveTo: null,
  priority: 200,
  requires: ['supply.type', 'supply.deliveryStateCode'],
  sourceRef: 'igst-act-2017-s10-1-a',
  reviewState: 'APPROVED',
  appliesWhen: (facts) => facts.value('supply.type') === 'GOODS',
  explanation: {
    'en-IN': 'The goods finish their journey in state {deliveryState}. A sale counts where the goods end up, so this one counts in state {placeOfSupply}.',
    'hi-IN': 'Maal ka safar rajya {deliveryState} mein khatam hota hai. Bikri wahin ki maani jaati hai, isliye yeh rajya {placeOfSupply} ki hai.',
  },
  evaluate: (facts): RuleOutcome => {
    if (facts.value('supply.type') !== 'GOODS') {
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: ['supply.type'],
        explanationValues: {},
        missingFacts: ['supply.placeOfSupplyStateCode'],
      };
    }
    // The source covers goods that move. A caller that knows the goods are not moving says so,
    // and we refuse rather than answering from a clause we have not implemented.
    if (facts.has('supply.involvesMovement') && facts.value('supply.involvesMovement') !== true) {
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: ['supply.type', 'supply.involvesMovement'],
        explanationValues: {},
        missingFacts: ['supply.placeOfSupplyStateCode'],
      };
    }
    const delivery = String(facts.value('supply.deliveryStateCode'));
    return {
      outcome: 'ALLOW',
      usedFacts: ['supply.type', 'supply.deliveryStateCode'],
      explanationValues: { deliveryState: delivery, placeOfSupply: delivery },
      computed: { placeOfSupplyStateCode: delivery, basis: 'IGST Act section 10(1)(a)' },
    };
  },
};

/**
 * IGST Act section 12(2): services to a registered person are supplied at that person's location;
 * to anyone else, at the recipient's recorded address.
 */
export const placeOfSupplyServicesApproved: Rule = {
  id: 'gst.place_of_supply.services',
  version: APPROVED_VERSION,
  topic: 'gst.place_of_supply',
  kind: 'COMPLIANCE',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2017-07-01'),
  effectiveTo: null,
  priority: 200,
  requires: ['supply.type', 'supply.recipientRegistered'],
  sourceRef: 'igst-act-2017-s12-2',
  reviewState: 'APPROVED',
  appliesWhen: (facts) => facts.value('supply.type') === 'SERVICES',
  explanation: {
    'en-IN': 'This is a service for {recipientKind}, so it counts where the customer is, which is state {placeOfSupply}.',
    'hi-IN': 'Yeh {recipientKind} ke liye service hai, isliye yeh wahin maani jaati hai jahan customer hai, yaani rajya {placeOfSupply}.',
  },
  evaluate: (facts): RuleOutcome => {
    if (facts.value('supply.type') !== 'SERVICES') {
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: ['supply.type'],
        explanationValues: {},
        missingFacts: ['supply.placeOfSupplyStateCode'],
      };
    }
    const registered = facts.value('supply.recipientRegistered') === true;
    // Both limbs of the sub-section need the customer's state: their location if registered, the
    // address we hold if not. Without it there is nothing to answer with.
    if (!facts.has('supply.recipientStateCode')) {
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: ['supply.type', 'supply.recipientRegistered'],
        explanationValues: {},
        missingFacts: ['supply.recipientStateCode'],
      };
    }
    const state = String(facts.value('supply.recipientStateCode'));
    return {
      outcome: 'ALLOW',
      usedFacts: ['supply.type', 'supply.recipientRegistered', 'supply.recipientStateCode'],
      explanationValues: {
        placeOfSupply: state,
        recipientKind: registered ? 'a customer registered for GST' : 'a customer who is not registered for GST',
      },
      computed: { placeOfSupplyStateCode: state, basis: 'IGST Act section 12(2)' },
    };
  },
};

/**
 * IGST Act sections 7 and 8 decide inter-State against intra-State. UTGST Act section 7 decides,
 * for an intra-State supply, whether the State half is State tax or union territory tax.
 *
 * The union-territory question is answered from the UTGST Act's own extent clause, not from a
 * general "is a union territory" flag — Delhi and Puducherry are union territories that the Act
 * does not extend to, and reading the flag instead would charge the wrong tax on ordinary Delhi
 * bills. See decision log `dl-delhi-puducherry-state-tax`.
 */
export const taxSplitApproved: Rule = {
  id: 'gst.tax_split',
  version: APPROVED_VERSION,
  topic: 'gst.tax_split',
  kind: 'COMPLIANCE',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2017-07-01'),
  effectiveTo: null,
  priority: 200,
  requires: ['supply.supplierStateCode', 'supply.placeOfSupplyStateCode'],
  sourceRef: 'igst-act-2017-s8',
  reviewState: 'APPROVED',
  explanation: {
    'en-IN': 'You are in state {supplierState} and this sale counts in state {placeOfSupply}, so {splitPlain}.',
    'hi-IN': 'Aap rajya {supplierState} mein hain aur yeh bikri rajya {placeOfSupply} ki hai, isliye {splitPlain}.',
  },
  evaluate: (facts): RuleOutcome => {
    const supplier = String(facts.value('supply.supplierStateCode'));
    const place = String(facts.value('supply.placeOfSupplyStateCode'));
    const used = ['supply.supplierStateCode', 'supply.placeOfSupplyStateCode'];

    if (supplier !== place) {
      return {
        outcome: 'ALLOW',
        usedFacts: used,
        explanationValues: {
          supplierState: supplier,
          placeOfSupply: place,
          splitPlain: 'one combined GST applies',
        },
        computed: { split: 'IGST', movement: 'INTER_STATE', basis: 'IGST Act section 7' },
      };
    }

    // Same state or union territory. Which half goes with the central tax depends on whether the
    // UTGST Act extends to this place.
    const name = facts.has('supply.placeOfSupplyStateName')
      ? String(facts.value('supply.placeOfSupplyStateName'))
      : null;

    if (name === null) {
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: used,
        explanationValues: {},
        missingFacts: ['supply.placeOfSupplyStateName'],
      };
    }
    if (pendingNames.has(name)) {
      // We know the enacted extent clause does not name this territory and that it was added
      // later, but we have not read the amended text. Refusing is the only honest answer.
      return {
        outcome: 'CANNOT_DECIDE',
        usedFacts: [...used, 'supply.placeOfSupplyStateName'],
        explanationValues: {},
        missingFacts: ['supply.placeOfSupplyStateName'],
      };
    }

    const unionTerritory = utgstNames.has(name);
    return {
      outcome: 'ALLOW',
      usedFacts: [...used, 'supply.placeOfSupplyStateName'],
      explanationValues: {
        supplierState: supplier,
        placeOfSupply: place,
        splitPlain: 'two separate GST amounts apply',
      },
      computed: {
        split: unionTerritory ? 'CGST_UTGST' : 'CGST_SGST',
        movement: 'INTRA_STATE',
        basis: unionTerritory ? 'IGST Act section 8 with UTGST Act section 7' : 'IGST Act section 8',
      },
    };
  },
};

/**
 * The rule set a production engine uses.
 *
 * Place of supply and the tax split are APPROVED. E-way applicability and the composition question
 * are carried over unchanged and remain DRAFT, so production still refuses them — that is not an
 * oversight, it is the register saying their numbers have no source.
 */
export const GST_RULE_SET_APPROVED: RuleSet = {
  id: 'in.gst',
  version: APPROVED_VERSION,
  publishedOn: isoDate('2026-08-29'),
  facts: [...SUPPLY_FACTS, SUPPLIER_REGISTRATION_FACT, ...PLACE_OF_SUPPLY_FACTS, ...TRANSPORT_FACTS],
  rules: [
    placeOfSupplyGoodsApproved,
    placeOfSupplyServicesApproved,
    taxSplitApproved,
    compositionCharging,
    ewayV1,
    ewayV2,
    ewayDelhi,
  ],
};
