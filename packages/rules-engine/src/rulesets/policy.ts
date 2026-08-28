/**
 * Issue #7 [E07] — `in.policy`, the rules that state a choice rather than the law.
 *
 * These are APPROVED because we are their source: rounding to the nearest rupee, checking a credit
 * limit before a sale, and refusing to sell stock that is not there are decisions this product
 * and the business make, not statutes. Their `sourceRef` points at our own documented policy.
 *
 * Compliance rules are a different rule set (`in.gst`) and are DRAFT until issue #54 records an
 * authoritative source for each one.
 */
import { fromDecimalString, isoDate, roundToWholeUnits, subtract, toDecimalString, type Money } from '@invoice/kernel';
import type { FactSet } from '../facts.ts';
import type { Rule, RuleOutcome } from '../rule.ts';
import type { RuleSet } from '../registry.ts';
import { MONEY_POLICY_FACTS, STOCK_FACTS } from './facts.ts';

const asMoney = (facts: FactSet, id: string): Money => facts.value(id) as Money;
const asNumber = (facts: FactSet, id: string): number => Number(facts.value(id));

const roundingRule: Rule = {
  id: 'invoice.rounding',
  version: '2026.04.01',
  topic: 'invoice.rounding',
  kind: 'POLICY',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  priority: 100,
  requires: ['invoice.totalBeforeRounding'],
  sourceRef: 'policy:invoice-rounding-v1',
  reviewState: 'APPROVED',
  explanation: {
    'en-IN': 'The bill came to {before}, so {difference} was {direction} to make it {rounded}.',
    'hi-IN': 'Bill {before} bana, isliye {difference} {direction} karke {rounded} kiya gaya.',
  },
  evaluate: (facts): RuleOutcome => {
    const before = asMoney(facts, 'invoice.totalBeforeRounding');
    const rounded = roundToWholeUnits(before);
    const difference = subtract(rounded, before);
    const magnitude = difference.minor < 0n ? { ...difference, minor: -difference.minor } : difference;
    return {
      outcome: 'ALLOW',
      usedFacts: ['invoice.totalBeforeRounding'],
      explanationValues: {
        before: toDecimalString(before),
        rounded: toDecimalString(rounded),
        difference: toDecimalString(magnitude),
        direction: difference.minor >= 0n ? 'added' : 'taken off',
      },
      computed: {
        roundedTotal: toDecimalString(rounded),
        roundOffAmount: toDecimalString(difference),
      },
    };
  },
};

const creditLimitRule: Rule = {
  id: 'sales.credit_limit',
  version: '2026.04.01',
  topic: 'sales.credit_limit',
  kind: 'POLICY',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  priority: 100,
  requires: ['party.creditLimit', 'party.outstanding', 'party.pendingValue', 'sale.value'],
  sourceRef: 'policy:credit-limit-v1',
  reviewState: 'APPROVED',
  explanation: {
    'en-IN': 'This customer may owe up to {limit}. They already owe {outstanding}, {pending} is on unfinished bills, and this bill is {sale}, which comes to {total}.',
    'hi-IN': 'Is customer par {limit} tak baaki ho sakta hai. Pehle se {outstanding} baaki hai, {pending} adhoore bill ka hai, aur yeh bill {sale} ka hai, kul {total}.',
  },
  evaluate: (facts): RuleOutcome => {
    const limit = asMoney(facts, 'party.creditLimit');
    const outstanding = asMoney(facts, 'party.outstanding');
    const pending = asMoney(facts, 'party.pendingValue');
    const sale = asMoney(facts, 'sale.value');
    const total = { currency: limit.currency, minor: outstanding.minor + pending.minor + sale.minor };
    const excess = { currency: limit.currency, minor: total.minor - limit.minor };
    const over = excess.minor > 0n;
    return {
      outcome: over ? 'WARN' : 'ALLOW',
      usedFacts: ['party.creditLimit', 'party.outstanding', 'party.pendingValue', 'sale.value'],
      explanationValues: {
        limit: toDecimalString(limit),
        outstanding: toDecimalString(outstanding),
        pending: toDecimalString(pending),
        sale: toDecimalString(sale),
        total: toDecimalString(total),
      },
      computed: {
        totalExposure: toDecimalString(total),
        excess: toDecimalString(over ? excess : fromDecimalString('0.00')),
        overLimit: String(over),
      },
    };
  },
};

const negativeStockRule: Rule = {
  id: 'stock.negative',
  version: '2026.04.01',
  topic: 'stock.availability',
  kind: 'POLICY',
  jurisdiction: { country: 'IN' },
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  priority: 100,
  requires: ['stock.availableScaled', 'stock.requiredScaled', 'stock.unit'],
  sourceRef: 'policy:negative-stock-v1',
  reviewState: 'APPROVED',
  explanation: {
    'en-IN': 'You can sell {available} {unit}. This bill needs {required} {unit}{shortfallClause}.',
    'hi-IN': 'Aap {available} {unit} bech sakte hain. Is bill ko {required} {unit} chahiye{shortfallClause}.',
  },
  evaluate: (facts): RuleOutcome => {
    const available = asNumber(facts, 'stock.availableScaled');
    const required = asNumber(facts, 'stock.requiredScaled');
    const unit = String(facts.value('stock.unit'));
    const short = required > available;
    const shortfall = short ? required - available : 0;
    return {
      outcome: short ? 'BLOCK' : 'ALLOW',
      usedFacts: ['stock.availableScaled', 'stock.requiredScaled', 'stock.unit'],
      explanationValues: {
        available: String(available),
        required: String(required),
        unit,
        shortfallClause: short ? `, so ${shortfall} ${unit} are missing` : '',
      },
      computed: { shortfall: String(shortfall), unit },
    };
  },
};

export const POLICY_RULE_SET: RuleSet = {
  id: 'in.policy',
  version: '2026.04.01',
  publishedOn: isoDate('2026-04-01'),
  facts: [...MONEY_POLICY_FACTS, ...STOCK_FACTS],
  rules: [roundingRule, creditLimitRule, negativeStockRule],
};
