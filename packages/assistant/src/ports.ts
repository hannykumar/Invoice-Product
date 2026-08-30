/**
 * Issue #34 [E34] — the seams.
 *
 * Everything the assistant knows comes from a module that already owns it: reports (#35), the rules
 * engine (#7), the compliance-source register (#54), and whichever module can say why a particular
 * document is stuck. Nothing here computes a figure or decides a rule.
 *
 * Two of these are deliberately optional, and the assistant says so in the answer when they are
 * absent rather than filling the gap itself:
 *
 *  - `ComplianceCalendarPort` is GPT 3's issue #32, which has not landed. Without it, a question
 *    about what is due when is answered with "we cannot see your due dates here", not with a date.
 *  - `QuestionUnderstandingPort` is where a model may help read an unusual question. It may only
 *    name an intent this package already has; it can never supply a figure, a period or a company.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type { Intent } from './model.ts';

export interface UnderstandingSuggestion {
  /** Must be one of this package's own intents; anything else is ignored. */
  readonly intent: string;
  readonly confidence: number;
  /** Why the model thinks so, shown to the person when we act on it. */
  readonly because: string;
}

/**
 * An optional model that reads a question the lexicon could not place.
 *
 * It is given the question text and nothing else — no figures, no company data — so a question that
 * tries to talk the model into something has nothing to reach for.
 */
export interface QuestionUnderstandingPort {
  suggest(question: string, allowed: readonly Intent[]): Promise<UnderstandingSuggestion | null>;
}

/** One reason a document cannot go out, as the module that blocked it describes it. */
export interface BlockingReason {
  /** A stable code, e.g. "STOCK_SHORTFALL", "CREDIT_LIMIT", "MISSING_FACT", "RULE_BLOCK". */
  readonly code: string;
  readonly what: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** What would clear it, in words a shopkeeper can act on. */
  readonly nextStep: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** The screen or command that does it, when there is one. */
  readonly action: string | null;
  /**
   * A compliance topic to evaluate for this document, when the block is about a rule. The
   * assistant asks the rules engine itself rather than trusting a sentence handed to it.
   */
  readonly topic?: string;
  /** Facts for that topic, so the decision is about this document rather than in the abstract. */
  readonly facts?: Readonly<Record<string, string>>;
}

export interface BlockedDocument {
  readonly documentId: string;
  readonly number: string | null;
  readonly kind: string;
  readonly date: IsoDate;
  readonly partyName: string | null;
  readonly reasons: readonly BlockingReason[];
}

/** Whoever knows why a document is stuck. Sales (#9), inventory (#12) and credit control (#11). */
export interface BlockedDocumentPort {
  find(companyId: CompanyId, reference: string): Promise<BlockedDocument | null>;
}

/** GPT 3's issue #32. Absent until it lands, and the answer says so. */
export interface ComplianceCalendarPort {
  dueSoon(companyId: CompanyId, on: IsoDate): Promise<readonly {
    readonly what: string;
    readonly dueOn: IsoDate;
    readonly sourceRef: string | null;
  }[]>;
}

/**
 * Issue #6's exception queue, narrowed to what this needs.
 *
 * A question the assistant will not answer on its own — a figure that does not hold together, a
 * rule that cannot decide — becomes an item for a person rather than a shrug.
 */
export interface ExceptionQueuePort {
  raise(input: {
    readonly companyId: CompanyId;
    readonly summary: string;
    readonly evidence: readonly string[];
  }): Promise<{ readonly id: string }>;
}
