/**
 * Issue #7 [E07] — versioned rule sets.
 *
 * A rule set is immutable and versioned. Changing a rule means publishing a new rule-set version,
 * never editing a released one, because a decision made last April must still be reproducible
 * exactly as it was made.
 */
import { invalid, notFound, type IsoDate } from '@invoice/kernel';
import { defaultRegister, type ComplianceRegister } from '@invoice/compliance-register';
import type { FactDefinition } from './facts.ts';
import type { Rule } from './rule.ts';

export interface RuleSet {
  readonly id: string;
  /** Immutable once published, e.g. "2026.04.01". */
  readonly version: string;
  readonly publishedOn: IsoDate;
  readonly facts: readonly FactDefinition[];
  readonly rules: readonly Rule[];
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;
const placeholdersIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);

/**
 * Checks a rule set before anyone can decide anything with it.
 *
 * These are refusals to load, not warnings. A rule set that reaches the engine has already been
 * proved to be well formed, so no decision path has to defend against a malformed rule.
 */
export const validateRuleSet = (set: RuleSet, register: ComplianceRegister | null = defaultRegister()): void => {
  const seen = new Set<string>();
  const factIds = new Set(set.facts.map((f) => f.id));

  for (const rule of set.rules) {
    const key = `${rule.id}@${rule.version}`;
    if (seen.has(key)) throw invalid('RULES_DUPLICATE_RULE', `${key} appears twice in rule set ${set.id}.`);
    seen.add(key);

    if (rule.kind === 'COMPLIANCE' && rule.reviewState === 'APPROVED') {
      if ((rule.sourceRef ?? '') === '') {
        throw invalid(
          'RULES_APPROVED_WITHOUT_SOURCE',
          `${key} claims to state the law but names no official source. Approve it in the compliance-source register (issue #54) first.`,
        );
      }
      // The register is the gate, not this file. A rule that says APPROVED but that the register
      // will not vouch for never reaches an engine.
      if (register !== null) {
        const verdict = register.mayApprove(rule.id, rule.version, set.publishedOn);
        if (!verdict.approved) {
          throw invalid(
            'RULES_REGISTER_WILL_NOT_APPROVE',
            `${key} is marked APPROVED but the compliance-source register refuses it: ${verdict.reasons.join(' ')}`,
          );
        }
      }
    }

    for (const factId of rule.requires) {
      if (!factIds.has(factId)) {
        throw invalid('RULES_UNKNOWN_FACT', `${key} requires "${factId}", which the rule set does not define.`);
      }
    }

    if (rule.effectiveTo !== null && rule.effectiveTo < rule.effectiveFrom) {
      throw invalid('RULES_BAD_EFFECTIVE_RANGE', `${key} stops applying before it starts.`);
    }

    const en = placeholdersIn(rule.explanation['en-IN']).sort();
    const hi = placeholdersIn(rule.explanation['hi-IN']).sort();
    if (en.join(',') !== hi.join(',')) {
      throw invalid(
        'RULES_EXPLANATION_MISMATCH',
        `${key} explains itself differently in each language: ${en.join(',')} versus ${hi.join(',')}.`,
      );
    }
  }
};

export class RuleRegistry {
  readonly #sets = new Map<string, RuleSet>();

  register(set: RuleSet, complianceRegister: ComplianceRegister | null = defaultRegister()): this {
    validateRuleSet(set, complianceRegister);
    const key = `${set.id}@${set.version}`;
    if (this.#sets.has(key)) throw invalid('RULES_DUPLICATE_RULE_SET', `Rule set ${key} is already registered.`);
    this.#sets.set(key, Object.freeze(set));
    return this;
  }

  get(id: string, version: string): RuleSet {
    const set = this.#sets.get(`${id}@${version}`);
    if (set === undefined) {
      throw notFound('RULES_SET_NOT_FOUND', `Rule set ${id}@${version} is not registered. A past decision cannot be replayed without it.`);
    }
    return set;
  }

  /** The newest version of a rule set that had been published by `asOf`. */
  latest(id: string, asOf?: IsoDate): RuleSet {
    const candidates = [...this.#sets.values()]
      .filter((s) => s.id === id && (asOf === undefined || s.publishedOn <= asOf))
      .sort((a, b) => (a.publishedOn === b.publishedOn ? a.version.localeCompare(b.version) : a.publishedOn.localeCompare(b.publishedOn)));
    const chosen = candidates.at(-1);
    if (chosen === undefined) {
      throw notFound('RULES_SET_NOT_FOUND', `No version of rule set ${id} had been published${asOf === undefined ? '' : ` by ${asOf}`}.`);
    }
    return chosen;
  }

  versions(id: string): string[] {
    return [...this.#sets.values()].filter((s) => s.id === id).map((s) => s.version).sort();
  }
}
