/**
 * Issue #51 [X03] — what has to be true before this product may act for a real taxpayer.
 *
 * The issue asks for production credentials, a signed agreement and a pilot customer. None of those
 * are things a repository can obtain: they need a company that exists, a person who can sign, and a
 * shopkeeper willing to be first. What a repository can do is make the list **checkable** — state
 * each condition once, say who can satisfy it and what breaks without it, and refuse to describe
 * the product as production-ready while any of them is outstanding.
 *
 * Two conditions on the list are different from the rest, and deliberately so: the fallback that
 * keeps a business invoicing when the provider is unreachable, and the customer's own authorisation
 * dance, are **software**, they exist, and `drills.ts` proves both every time the tests run. A
 * go-live checklist whose every line reads "waiting on a person" teaches nobody anything.
 */

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

export const bilingual = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

/** Who can actually satisfy a condition. The split is the honest part of this module. */
export type Answerable =
  /** A person with authority, money or a signature. A repository cannot move these. */
  | 'PERSON'
  /** The provider, once asked. */
  | 'PROVIDER'
  /** This repository, and therefore something the drills can prove. */
  | 'REPOSITORY';

export type StepState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  /** Satisfied, with `evidence` saying where to look. */
  | 'DONE'
  /** Deliberately not being pursued, with `evidence` naming the decision. Never a silent skip. */
  | 'ON_HOLD_BY_DECISION';

export interface GoLiveStep {
  readonly id: string;
  readonly label: Bilingual;
  /** Why production access should not be granted without it. */
  readonly why: string;
  readonly answerable: Answerable;
  /** The issues that cannot honestly close while this is outstanding. */
  readonly blocks: readonly string[];
}

export interface StepRecord {
  readonly id: string;
  readonly state: StepState;
  /** A pointer — a document path, an issue, a decision. Never a credential or an identifier. */
  readonly evidence: string | null;
  readonly note: string | null;
}

export type FindingLevel = 'BLOCKING' | 'WARNING' | 'INFORMATION';

export interface Finding {
  readonly level: FindingLevel;
  readonly code: string;
  readonly what: Bilingual;
  readonly whatToDo: Bilingual;
  readonly blocks: readonly string[];
}

/**
 * The state of production access, as this repository holds it.
 *
 * `environment` is what the product is wired to today. It is checked against
 * `PRODUCTION_ACCESS` in `packages/gst`, which is the switch the connector actually obeys, so this
 * register and the running code cannot disagree without a test failing.
 */
export interface ProductionRegister {
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  /** The provider whose sandbox we run against today, by name. No credential, ever. */
  readonly sandboxProvider: string | null;
  /** The provider a production agreement has been signed with, once there is one. */
  readonly contractedProvider: string | null;
  readonly steps: readonly StepRecord[];
  /** The standing decision that governs all of this, quoted rather than paraphrased. */
  readonly standingDecision: string;
}

export interface GoLiveReport {
  readonly asOf: string;
  /** Whether a production call may be made. False while anything blocking stands. */
  readonly productionAllowed: boolean;
  readonly register: ProductionRegister;
  readonly steps: readonly (GoLiveStep & StepRecord)[];
  readonly findings: readonly Finding[];
  readonly summary: Bilingual;
}

export interface DrillStep {
  readonly name: string;
  readonly passed: boolean;
  /** What was observed, in one sentence, so a filed report means something a year later. */
  readonly evidence: string;
}

export interface DrillReport {
  readonly drill: string;
  readonly ranAt: string;
  readonly passed: boolean;
  readonly steps: readonly DrillStep[];
}
