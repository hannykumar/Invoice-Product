/**
 * Issue #52 [X04] — how the product gets bank transactions, and how that decision is made.
 *
 * The decision itself belongs to a person: it needs quotations, contract terms and a conversation
 * with each provider, and none of those are things a repository can obtain. What a repository can
 * do is make the decision **reproducible** — the same facts always produce the same recommendation,
 * the weights are written down rather than felt, and a route that cannot be taken is disqualified
 * by a rule rather than by whoever is in the room.
 *
 * Two rules are absolute here, and both are enforced rather than described:
 *
 *  1. **No credential scraping.** A route that asks a shopkeeper for their netbanking password,
 *     PIN or OTP is disqualified outright — not scored low, disqualified. It is the issue's own
 *     acceptance criterion and it is not a trade-off against price or coverage.
 *  2. **Nothing is guessed.** A criterion nobody has confirmed with the provider stays `UNKNOWN`,
 *     and a recommendation cannot be made while an essential one is unknown. The output in that
 *     case is a deferral naming exactly what must be asked and of whom.
 */

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/**
 * How a route actually reaches the money.
 *
 * `ACCOUNT_AGGREGATOR` is India's consent framework: an RBI-licensed NBFC-AA sits between the bank
 * and us, the customer grants a consent artefact naming purpose, duration and frequency, and can
 * revoke it. We would be a financial information *user*, never the aggregator — becoming an
 * NBFC-AA is an explicit non-goal of this issue.
 */
export type AccessModel =
  | 'ACCOUNT_AGGREGATOR'
  | 'DIRECT_BANK_API'
  | 'PARTNER_AGGREGATOR_API'
  | 'STATEMENT_UPLOAD'
  | 'CREDENTIAL_SHARING';

/** A route that works by holding the customer's own banking credentials. Never acceptable. */
export const isCredentialScraping = (model: AccessModel): boolean => model === 'CREDENTIAL_SHARING';

export type Confidence = 'CONFIRMED' | 'PUBLIC_INFORMATION' | 'UNKNOWN';

/**
 * One fact about one candidate.
 *
 * `confidence` is the honest part. `PUBLIC_INFORMATION` means somebody read it on the provider's
 * own site; `CONFIRMED` means the provider said it to us, in writing, and `source` says where.
 * Anything else is `UNKNOWN` and the scoring refuses to pretend otherwise.
 */
export interface Assessment<T> {
  readonly value: T | null;
  readonly confidence: Confidence;
  readonly source: string | null;
  readonly asOf: string | null;
  readonly note: string | null;
}

export const unknown = <T>(note?: string): Assessment<T> => ({
  value: null, confidence: 'UNKNOWN', source: null, asOf: null, note: note ?? null,
});

export const known = <T>(value: T, confidence: Exclude<Confidence, 'UNKNOWN'>, source: string, asOf: string, note?: string): Assessment<T> => ({
  value, confidence, source, asOf, note: note ?? null,
});

export type CriterionId =
  | 'access_model'
  | 'bank_coverage'
  | 'consent_and_revocation'
  | 'history_depth'
  | 'data_freshness'
  | 'accounting_use_permitted'
  | 'sandbox_availability'
  | 'startup_eligibility'
  | 'cost';

export interface Criterion {
  readonly id: CriterionId;
  readonly label: Bilingual;
  /** Relative importance. Written down so the recommendation can be argued with. */
  readonly weight: number;
  /** A criterion nobody can answer makes the whole comparison a guess, so it blocks a verdict. */
  readonly essential: boolean;
  readonly why: string;
}

export interface CostShape {
  /** What the provider charges before a single business connects. */
  readonly monthlyPlatformFeePaise: bigint;
  /** Per connected business, per month. */
  readonly perConnectionPaise: bigint;
  /** Per completed fetch of transactions. */
  readonly perSyncPaise: bigint;
  /** Anything one-off: onboarding, integration, certification. */
  readonly oneOffPaise: bigint;
}

export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly accessModel: AccessModel;
  readonly summary: Bilingual;
  readonly assessments: Readonly<Partial<Record<CriterionId, Assessment<number>>>>;
  readonly cost: Assessment<CostShape>;
  /** Who has to be asked, and what, before this can be scored. */
  readonly openQuestions: readonly string[];
}

export type Verdict = 'RECOMMENDED' | 'VIABLE' | 'DISQUALIFIED' | 'CANNOT_SAY_YET';

export interface CandidateScore {
  readonly candidate: Candidate;
  readonly verdict: Verdict;
  /** Out of 100, over the criteria that are actually known. Null when a verdict is impossible. */
  readonly score: number | null;
  readonly known: readonly CriterionId[];
  readonly missing: readonly CriterionId[];
  readonly reason: Bilingual;
}

export interface Recommendation {
  readonly asOf: string;
  readonly scores: readonly CandidateScore[];
  readonly chosen: CandidateScore | null;
  /** Set when no choice can honestly be made yet: what to ask, and of whom. */
  readonly deferral: {
    readonly why: Bilingual;
    readonly toAsk: readonly string[];
  } | null;
  readonly summary: Bilingual;
}
