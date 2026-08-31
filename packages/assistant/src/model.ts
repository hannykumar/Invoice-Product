/**
 * Issue #34 [E34] — what an answer is.
 *
 * The assistant answers questions about a business's own books. It is the part of the product where
 * it would be easiest to be quietly wrong, so the shape of an answer is built to make that hard:
 *
 *  - **A number in an answer is never computed here.** It is lifted out of a canonical report from
 *    issue #35, and it carries that report's snapshot id, its period and the records it was folded
 *    from. `citeAmount` is the only way to make one, so an answer physically cannot contain a
 *    figure that no report will agree with.
 *  - **A compliance statement is never phrased here.** It comes from a decision of the rules engine
 *    (#7) whose rule names a source in the compliance register (#54), and it carries the source, the
 *    provision, the effective date and how certain the answer actually is.
 *  - **What the asker may not see is said out loud.** A report the actor lacks permission for is
 *    not silently dropped: the answer says which part is missing and why, so nobody reads a partial
 *    figure as a whole one.
 *  - **Not knowing is an answer.** `CANNOT_ANSWER` and `NEEDS_A_PERSON` are ordinary outcomes with
 *    their own wording, never a guess dressed as a fact.
 */
import { formatDate, formatINR, type IsoDate, type Money } from '@invoice/kernel';
import type { Contribution, ReportId } from '@invoice/reports';

export interface Bilingual {
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

/** The questions this assistant knows how to answer. Anything else is refused by name. */
export type Intent =
  | 'MONEY_OWED_TO_ME'
  | 'MONEY_I_OWE'
  | 'SALES_IN_PERIOD'
  | 'PURCHASES_IN_PERIOD'
  | 'PROFIT_IN_PERIOD'
  | 'WHAT_I_OWN'
  | 'STOCK_POSITION'
  | 'GST_IN_PERIOD'
  | 'NEEDS_ATTENTION'
  | 'WHY_BLOCKED'
  | 'COMPLIANCE_QUESTION'
  | 'UNSUPPORTED';

export const ANSWERABLE_INTENTS: readonly Intent[] = [
  'MONEY_OWED_TO_ME',
  'MONEY_I_OWE',
  'SALES_IN_PERIOD',
  'PURCHASES_IN_PERIOD',
  'PROFIT_IN_PERIOD',
  'WHAT_I_OWN',
  'STOCK_POSITION',
  'GST_IN_PERIOD',
  'NEEDS_ATTENTION',
  'WHY_BLOCKED',
  'COMPLIANCE_QUESTION',
];

export type AnswerState =
  /** Answered in full from data the asker is allowed to see. */
  | 'ANSWERED'
  /** Answered as far as permissions or recorded data allow, and it says which part is missing. */
  | 'PARTLY_ANSWERED'
  /** The question is one we support but we do not have what it takes to answer it. */
  | 'CANNOT_ANSWER'
  /** The asker may not see what the answer would need. */
  | 'NEEDS_PERMISSION'
  /** The question is outside what this assistant answers from the books. */
  | 'NOT_MY_QUESTION'
  /** Answering would need a judgement nobody here should make on their own. */
  | 'NEEDS_A_PERSON';

/**
 * A number in an answer.
 *
 * Everything needed to check it comes with it: which report it is from, which asking of that report
 * (`snapshotId`), what period, and every record behind the total. An owner who does not believe the
 * figure can open the same report and land on the same number.
 */
export interface CitedAmount {
  readonly amount: Money;
  /** Indian digit grouping with the rupee sign, ready to read out. */
  readonly formatted: string;
  readonly what: Bilingual;
  readonly reportId: ReportId;
  readonly snapshotId: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** The records the total was folded from — the drill-down, carried, not summarised. */
  readonly drillDown: readonly Contribution[];
}

/** How certain an answer about a rule can honestly be. There is no fourth, more confident, level. */
export type Certainty =
  /** An approved rule, resting on a legal source, decided this. */
  | 'THE_RULE_SAYS'
  /** We have a rule but something it needs is missing, or it is not settled enough to rely on. */
  | 'THE_RULE_IS_UNCLEAR'
  /** We have no approved rule for this. Nothing is asserted. */
  | 'WE_CANNOT_SAY';

/** A statement about a rule, with the document it comes from. Built only by `citeCompliance`. */
export interface ComplianceCitation {
  readonly topic: string;
  readonly certainty: Certainty;
  readonly outcome: string;
  readonly explanation: Bilingual;
  /** The date the answer is about — never the date it was asked. */
  readonly asOfDate: IsoDate;
  readonly ruleId: string | null;
  readonly ruleVersion: string | null;
  readonly effectiveFrom: IsoDate | null;
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly publisher: string;
    readonly provision: string;
    readonly url: string;
    readonly quotedText: string;
    readonly authority: string;
    readonly effectiveFrom: IsoDate;
  } | null;
  /** What we would need before this could be answered properly. */
  readonly missing: readonly { readonly label: string; readonly whyNeeded: string }[];
}

export interface NextStep {
  readonly label: Bilingual;
  /** A screen or command the app can take the person to, when there is one. */
  readonly action: string | null;
}

export interface Answer {
  readonly id: string;
  /** Exactly what was asked, kept as evidence. It is data, never an instruction. */
  readonly question: string;
  readonly intent: Intent;
  readonly state: AnswerState;
  readonly askedAt: string;
  /** The answer itself, in sentences a shopkeeper reads without help. */
  readonly sentences: readonly Bilingual[];
  readonly amounts: readonly CitedAmount[];
  readonly compliance: readonly ComplianceCitation[];
  /** The period the answer is about, and how it was worked out from the words. */
  readonly period: { readonly from: IsoDate; readonly to: IsoDate; readonly described: Bilingual } | null;
  /** Anything taken as given. An assumption is stated, never buried. */
  readonly assumptions: readonly Bilingual[];
  /** Which reports the figures came from, so two answers can be compared. */
  readonly sourcesUsed: readonly { readonly reportId: ReportId; readonly snapshotId: string }[];
  /** Parts of the answer the asker is not allowed to see, named rather than silently dropped. */
  readonly withheld: readonly Bilingual[];
  readonly nextSteps: readonly NextStep[];
  /** Set when the question was put into the exception queue for a person to deal with. */
  readonly exceptionId: string | null;
  readonly disclaimer: Bilingual;
}

export const ASSISTANT_PERMISSIONS = {
  ask: 'assistant.ask',
} as const;

/** Said on every answer that touches a rule. The product explains rules; it is not an advisor. */
export const RULE_DISCLAIMER: Bilingual = {
  'en-IN':
    'This is what the rule we have on record says, with the notification it comes from. It is not legal advice, and your accountant may know something about your business that we do not.',
  'hi-IN':
    'Yeh wahi hai jo hamare paas darj niyam kehta hai, us notification ke saath jahan se aaya hai. Yeh kanooni salah nahin hai, aur aapke accountant ko aapke business ki koi baat pata ho sakti hai jo humein nahin.',
};

export const FIGURE_DISCLAIMER: Bilingual = {
  'en-IN': 'Every figure here is taken from your own books, and you can open the same report to check it.',
  'hi-IN': 'Yahan har aankda aapki apni books se liya gaya hai, aur aap wahi report kholkar use jaanch sakte hain.',
};

/** How a period is said back to the person, so they can see what we took their words to mean. */
export const describePeriod = (from: IsoDate, to: IsoDate): Bilingual => ({
  'en-IN': `${formatDate(from)} to ${formatDate(to)}`,
  'hi-IN': `${formatDate(from)} se ${formatDate(to)} tak`,
});

export const formatAmount = (amount: Money): string => formatINR(amount);
