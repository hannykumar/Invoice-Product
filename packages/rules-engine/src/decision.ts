/** Issue #7 [E07] — what a decision looks like, and what it must always carry. */
import type { IsoDate } from '@invoice/kernel';
import type { FactSource, FactValue } from './facts.ts';
import type { Outcome, ReviewState, RuleKind } from './rule.ts';

export interface Evidence {
  readonly factId: string;
  readonly label: string;
  readonly value: string;
  readonly source: FactSource;
  readonly confidence?: number;
}

export interface MissingFact {
  readonly factId: string;
  readonly label: string;
  readonly whyNeeded: string;
}

/** A rule that was looked at and set aside, with the reason. This is what makes a trace useful. */
export interface ConsideredRule {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly used: boolean;
  readonly reason:
    | 'used'
    | 'not-effective-on-this-date'
    | 'different-state'
    | 'not-approved'
    | 'does-not-apply'
    | 'lower-priority'
    | 'less-specific'
    | 'different-topic';
}

export interface Decision {
  readonly topic: string;
  readonly outcome: Outcome;
  /** The date the decision is *about*, never the date it was computed. */
  readonly documentDate: IsoDate;

  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly ruleId: string | null;
  readonly ruleVersion: string | null;
  readonly ruleKind: RuleKind | null;
  readonly ruleReviewState: ReviewState | null;
  readonly effectiveFrom: IsoDate | null;
  /** Where the rule comes from, for a compliance answer. Never null on an APPROVED compliance rule. */
  readonly sourceRef: string | null;

  /** Everything the rule looked at, so the answer can be checked without rerunning it. */
  readonly evidence: readonly Evidence[];
  /** What we would need in order to answer. Non-empty means the outcome is CANNOT_DECIDE. */
  readonly missingFacts: readonly MissingFact[];
  readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** What the rule worked out, for the caller to act on. Empty when it decided nothing numeric. */
  readonly computed: Readonly<Record<string, string>>;

  /** Fingerprint of the facts, so a replay can prove it used the same input. */
  readonly factsFingerprint: string;
  /** Fingerprint of the whole decision, so tampering is detectable and replays are comparable. */
  readonly decisionFingerprint: string;
}

export interface Trace {
  readonly considered: readonly ConsideredRule[];
  /** Set when two rules were equally specific, equally prioritised and equally recent. */
  readonly unresolvedConflict?: readonly string[];
}

export interface DecisionWithTrace {
  readonly decision: Decision;
  readonly trace: Trace;
}

export const isBlocking = (d: Decision): boolean => d.outcome === 'BLOCK' || d.outcome === 'CANNOT_DECIDE';

/** True when the answer may be acted upon without a person confirming something first. */
export const isActionable = (d: Decision): boolean =>
  d.outcome !== 'CANNOT_DECIDE' && d.missingFacts.length === 0;

export const describeFactValue = (value: FactValue): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && 'minor' in value) {
    const negative = value.minor < 0n;
    const abs = negative ? -value.minor : value.minor;
    return `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
  }
  if (typeof value === 'object' && 'scaled' in value) {
    const whole = value.scaled / 1000000n;
    const frac = (value.scaled % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole}${frac === '' ? '' : `.${frac}`} ${value.unit}`;
  }
  return String(value);
};
