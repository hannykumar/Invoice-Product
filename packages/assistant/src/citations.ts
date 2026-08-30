/**
 * Issue #34 [E34] — the machinery that keeps an answer honest.
 *
 * Two acceptance criteria of this issue are not really about wording, they are about what the code
 * is *able* to produce:
 *
 *  - "Numbers reconcile to canonical reports." So a number can only enter an answer through
 *    `citeAmount`, which takes a report and one of that report's own `Figure`s, checks that the
 *    figure still folds to its own records, and carries the report's snapshot id out with it. There
 *    is no path from an arithmetic expression in this package to a figure in an answer.
 *  - "No unsupported legal certainty." So a sentence claiming what someone must do is checked by
 *    `safeSentence`, which throws unless an approved rule resting on a legal source is standing
 *    behind it. A test drives every branch of it, exactly as issue #19 does for its warnings.
 *
 * Both throw rather than return a flag. A wrong number that reaches a business owner is worse than
 * a crash in a test.
 */
import { reconciles, type Figure, type Report, type ReportHeader } from '@invoice/reports';
import type { Bilingual, CitedAmount, Certainty } from './model.ts';
import { formatAmount } from './model.ts';

export class UnsupportedClaimError extends Error {
  readonly phrase: string;

  constructor(message: string, phrase: string) {
    super(message);
    this.name = 'UnsupportedClaimError';
    this.phrase = phrase;
  }
}

export class UncheckableFigureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncheckableFigureError';
  }
}

/**
 * Lifts one figure out of a report into an answer.
 *
 * The report header comes along because a figure without its period and its snapshot is a number
 * with no way to check it, and this assistant's whole claim is that its numbers can be checked.
 */
export const citeAmount = (header: ReportHeader, what: Bilingual, figure: Figure): CitedAmount => {
  if (!reconciles(figure)) {
    throw new UncheckableFigureError(
      `A figure from ${header.reportId} does not add up to the records behind it, so it must not be quoted in an answer.`,
    );
  }
  return {
    amount: figure.amount,
    formatted: formatAmount(figure.amount),
    what,
    reportId: header.reportId,
    snapshotId: header.snapshotId,
    from: header.filter.from,
    to: header.filter.to,
    drillDown: figure.contributors,
  };
};

/** The same, straight from a report, which is how callers usually have it. */
export const citeFrom = <TBody>(report: Report<TBody>, what: Bilingual, figure: Figure): CitedAmount =>
  citeAmount(report.header, what, figure);

/**
 * Phrases that assert an obligation or a certainty.
 *
 * These are the words that turn an explanation into advice. They are allowed only when an approved
 * rule resting on a legal source is behind the sentence — and even then the answer carries the
 * disclaimer, because the product explains rules rather than advising on them.
 */
const CERTAINTY_PHRASES: readonly RegExp[] = [
  /\byou (?:are|will be) (?:legally )?(?:required|obliged|liable)\b/i,
  /\byou must\b/i,
  /\byou have to\b/i,
  /\bit is (?:compulsory|mandatory|illegal|unlawful)\b/i,
  /\bguaranteed?\b/i,
  /\bdefinitely\b/i,
  /\bthere is no (?:doubt|risk)\b/i,
  /\bwill not be (?:penalised|penalized|fined)\b/i,
  /\bno penalty\b/i,
  /\bsafe to (?:ignore|skip)\b/i,
  /\baapko .*(?:karna hi hoga|zaroori hai)\b/i,
  /\bkanoonan zaroori\b/i,
  /\bkoi penalty nahin\b/i,
];

/** Phrases that speak for the tax authority or a court, which nothing in this product may do. */
const IMPERSONATION_PHRASES: readonly RegExp[] = [
  /\bthe (?:department|officer|court) will\b/i,
  /\bcbic (?:says|confirms|has confirmed)\b/i,
  /\bthe government (?:says|confirms|guarantees)\b/i,
];

export interface ClaimSupport {
  /** True only when an APPROVED rule, resting on a legal source, decided the matter. */
  readonly backedByApprovedRule: boolean;
  readonly certainty: Certainty;
}

/**
 * Checks one sentence before it goes into an answer.
 *
 * Returns the sentence so it reads as a wrapper at every call site — you cannot forget to use the
 * result, because the result is the sentence.
 */
export const safeSentence = (sentence: Bilingual, support: ClaimSupport): Bilingual => {
  for (const language of ['en-IN', 'hi-IN'] as const) {
    const text = sentence[language];
    for (const phrase of IMPERSONATION_PHRASES) {
      const found = phrase.exec(text);
      if (found !== null) {
        throw new UnsupportedClaimError(
          `An answer may not speak for the tax authority or a court: "${found[0]}".`,
          found[0],
        );
      }
    }
    if (support.backedByApprovedRule && support.certainty === 'THE_RULE_SAYS') continue;
    for (const phrase of CERTAINTY_PHRASES) {
      const found = phrase.exec(text);
      if (found !== null) {
        throw new UnsupportedClaimError(
          `"${found[0]}" states an obligation, and no approved rule with a legal source is behind this answer.`,
          found[0],
        );
      }
    }
  }
  return sentence;
};

/** A sentence about the business's own figures. Nothing legal is being claimed, so nothing is gated. */
export const plainSentence = (en: string, hi: string): Bilingual =>
  safeSentence({ 'en-IN': en, 'hi-IN': hi }, { backedByApprovedRule: false, certainty: 'WE_CANNOT_SAY' });
