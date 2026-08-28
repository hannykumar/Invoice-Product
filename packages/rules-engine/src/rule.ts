/**
 * Issue #7 [E07] — what a rule is.
 *
 * A rule is a **pure, synchronous function**. It takes facts and returns an outcome. It cannot
 * read a database, call a service, or ask a model, and the type system says so: `evaluate` is not
 * `async` and receives nothing but facts. This is the mechanism behind the product rule that an
 * LLM never determines a legal outcome — there is no seam for one to be plugged into.
 */
import type { IsoDate } from '@invoice/kernel';
import type { FactSet } from './facts.ts';

/**
 * What a rule concluded.
 *
 * `CANNOT_DECIDE` is a first-class, expected result, not an error. It is what the product returns
 * instead of guessing, and it is what opens an exception item.
 */
export type Outcome = 'ALLOW' | 'BLOCK' | 'WARN' | 'REQUIRED' | 'NOT_REQUIRED' | 'CANNOT_DECIDE';

export interface Jurisdiction {
  readonly country: 'IN';
  /** Two-digit GST state code. Absent means the rule applies across India. */
  readonly stateCode?: string;
}

/**
 * How confident we are that this rule reflects the law or policy it claims to.
 *
 * The engine refuses to use anything but `APPROVED` in production mode. A rule with no reviewed
 * source cannot produce a compliance answer, however plausible it looks.
 */
export type ReviewState = 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'WITHDRAWN';

/** Whether a rule states the law, or states a choice this business or this product made. */
export type RuleKind = 'COMPLIANCE' | 'POLICY';

export interface RuleOutcome {
  readonly outcome: Outcome;
  /** Fact ids the rule actually looked at, in the order it looked at them. */
  readonly usedFacts: readonly string[];
  /** Values a person needs to see to understand the answer, keyed for the explanation template. */
  readonly explanationValues: Readonly<Record<string, string>>;
  /**
   * Values the rule worked out, for the caller to act on: the place of supply it settled on, the
   * tax split it chose, the round-off it computed. Strings, so a decision serialises and
   * fingerprints without losing precision.
   */
  readonly computed?: Readonly<Record<string, string>>;
  /** Fact ids the rule needed and did not get. Non-empty implies CANNOT_DECIDE. */
  readonly missingFacts?: readonly string[];
}

export interface Rule {
  /** Stable across versions, e.g. "gst.eway.applicability". */
  readonly id: string;
  /** This rule's own version, e.g. "2026.04.01". Recorded on every decision. */
  readonly version: string;
  readonly topic: string;
  readonly kind: RuleKind;
  readonly jurisdiction: Jurisdiction;
  readonly effectiveFrom: IsoDate;
  /** Inclusive last day this rule applies. `null` means still in force. */
  readonly effectiveTo: IsoDate | null;
  /** Higher wins when two equally specific rules both apply. */
  readonly priority: number;
  readonly requires: readonly string[];
  /**
   * Identifier in the compliance-source register (issue #54). A `COMPLIANCE` rule cannot be
   * APPROVED without one, and the registry refuses to load it if it is missing.
   */
  readonly sourceRef: string | null;
  readonly reviewState: ReviewState;
  /** Placeholders are filled from `RuleOutcome.explanationValues`. */
  readonly explanation: {
    readonly 'en-IN': string;
    readonly 'hi-IN': string;
  };
  /** Pure. Same facts in, same outcome out, for ever. */
  readonly evaluate: (facts: FactSet) => RuleOutcome;
}

export const isEffectiveOn = (rule: Rule, date: IsoDate): boolean =>
  rule.effectiveFrom <= date && (rule.effectiveTo === null || date <= rule.effectiveTo);

/** A state-specific rule is more specific than an all-India one and wins over it. */
export const specificity = (rule: Rule): number => (rule.jurisdiction.stateCode === undefined ? 0 : 1);

export const appliesInState = (rule: Rule, stateCode: string | undefined): boolean =>
  rule.jurisdiction.stateCode === undefined || rule.jurisdiction.stateCode === stateCode;

/** Convenience for rules that simply need every required fact present. */
export const missing = (facts: FactSet, required: readonly string[]): string[] =>
  required.filter((id) => !facts.has(id));
