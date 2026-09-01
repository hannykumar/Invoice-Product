/**
 * Issue #50 [X02] — how a GSP is chosen, and what it takes to be allowed to choose one.
 *
 * The decision belongs to a person. It needs four written quotations, a sandbox login and a
 * conversation about what happens to a customer's data when we stop paying — and a repository can
 * obtain none of those. What a repository can do is make the decision **reproducible**: the
 * requirement is written down once and sent to everybody unchanged, the weights are stated rather
 * than felt, a provider's sandbox is judged by a checklist rather than by a demo call, and a
 * recommendation is refused while the facts behind it are missing.
 *
 * Three rules are absolute here, and each is enforced by code rather than described in a slide.
 *
 *   1. **No provider that wants the customer's GST portal password.** Disqualified outright — not
 *      scored low and outweighed by price. This product's authorised channel (#33) has nowhere to
 *      put a portal password, so a provider whose integration requires one is not a cheaper
 *      option; it is a different product we are not building.
 *   2. **Nothing is guessed.** A fact nobody has been told, in writing, by the provider is
 *      `UNKNOWN`, and a recommendation cannot be made while an essential one is unknown. The
 *      output then is a deferral naming exactly what to ask and of whom. "Never silently guess a
 *      missing fact" applies to our own commercial decisions as much as to a customer's books.
 *   3. **Two written proposals or no recommendation.** The issue's own acceptance criterion, made
 *      computable: a quotation that exists only as "they said it would be around ₹X on a call" is
 *      not a proposal, and the register below has no state that lets it become one.
 *
 * **No commercial term anywhere in this tool was supplied by a provider.** The provider names come
 * from the issue itself. Every figure is `UNKNOWN` until somebody replaces it with what a named
 * person sent, in writing, on a date.
 */

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/**
 * How sure we are, and why.
 *
 * `CONFIRMED` means a provider told us in writing and `source` says where that writing is.
 * `PUBLIC_INFORMATION` means somebody read it on their own site or documentation — useful for
 * shortlisting, never enough to sign. Anything else is `UNKNOWN`, and the scoring refuses to
 * pretend otherwise.
 */
export type Confidence = 'CONFIRMED' | 'PUBLIC_INFORMATION' | 'UNKNOWN';

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

// ---------------------------------------------------------------------------- what we need done

/**
 * One thing a provider must be able to do.
 *
 * `usedBy` is the operation this product already sends through #8's connector, which is what makes
 * the checklist a requirement rather than a wish list: a provider missing a capability with a
 * `usedBy` breaks a feature that exists and has tests. A capability with `usedBy: null` is one the
 * product does not call yet and would like to.
 */
export interface Capability {
  readonly id: string;
  readonly label: Bilingual;
  /** The product operation that needs it, or null when nothing calls it yet. */
  readonly usedBy: string | null;
  /** Which issue's feature stops working without it. */
  readonly neededBy: string;
  /** Critical capabilities cannot be traded away. A provider missing one is not viable. */
  readonly critical: boolean;
  readonly why: string;
}

// ---------------------------------------------------------------------------- what we weigh

export type CriterionId =
  | 'endpoint_coverage'
  | 'sandbox_access'
  | 'cost'
  | 'data_storage'
  | 'support_and_sla'
  | 'portability_and_exit'
  | 'startup_terms'
  | 'callbacks';

export interface Criterion {
  readonly id: CriterionId;
  readonly label: Bilingual;
  /** Relative importance, written down so the recommendation can be argued with. */
  readonly weight: number;
  /** A criterion nobody can answer makes the comparison a guess, so it blocks a verdict. */
  readonly essential: boolean;
  readonly why: string;
}

// ---------------------------------------------------------------------------- what it costs

/**
 * A GSP quotation, in the shape they actually quote in.
 *
 * Every field is paise. The three per-document fees are separate because providers price them
 * separately and a business's mix decides which one dominates: a shop that raises fifty e-way bills
 * a month and files two returns is a completely different customer from a wholesaler with two
 * thousand IRNs.
 */
export interface CostShape {
  readonly monthlyPlatformFeePaise: bigint;
  readonly perGstinPerMonthPaise: bigint;
  readonly perIrnPaise: bigint;
  readonly perEwayBillPaise: bigint;
  readonly perReturnFilingPaise: bigint;
  readonly perGstr2bFetchPaise: bigint;
  /** What they charge whether or not anything is used. The number that hurts at ten customers. */
  readonly monthlyMinimumPaise: bigint;
  readonly oneOffOnboardingPaise: bigint;
}

// ---------------------------------------------------------------------------- the paper trail

/**
 * Where each provider has got to.
 *
 * `REQUEST_SENT` is not evidence of anything and neither is a phone call. Only `QUOTATION_RECEIVED`
 * counts towards the two the acceptance criterion demands, and only with a document reference
 * somebody can open.
 */
export type ProposalState =
  | 'NOT_APPROACHED'
  | 'REQUEST_SENT'
  | 'QUOTATION_RECEIVED'
  | 'SANDBOX_GRANTED'
  | 'DECLINED_BY_PROVIDER'
  | 'WITHDRAWN_BY_US';

export interface ProposalRecord {
  readonly candidateId: string;
  readonly state: ProposalState;
  readonly requestedOn: string | null;
  readonly receivedOn: string | null;
  /** Where the written quotation lives. A quotation nobody can open is not written. */
  readonly documentRef: string | null;
  /** Sandbox credentials are never stored here — only whether access was granted, and when. */
  readonly sandboxGrantedOn: string | null;
  readonly note: string | null;
}

/** A written quotation with a document behind it. The only thing that counts as a proposal. */
export const isWrittenProposal = (record: ProposalRecord): boolean =>
  (record.state === 'QUOTATION_RECEIVED' || record.state === 'SANDBOX_GRANTED') &&
  record.documentRef !== null &&
  record.receivedOn !== null;

// ---------------------------------------------------------------------------- the candidates

/**
 * How a provider expects us to authenticate for a customer's GST number.
 *
 * `PORTAL_PASSWORD` is the disqualifier. Some integrations still ask the software to hold the
 * taxpayer's own portal login; ours cannot, by construction (#33), and would not if it could.
 */
export type AuthModel = 'API_USER_WITH_OTP' | 'PORTAL_PASSWORD' | 'DIRECT_IRP_ONLY' | 'NONE';

export const requiresPortalPassword = (model: AuthModel): boolean => model === 'PORTAL_PASSWORD';

export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly authModel: AuthModel;
  readonly summary: Bilingual;
  /** Which capabilities they say they have. Absent means nobody has asked yet. */
  readonly capabilities: Readonly<Record<string, Assessment<boolean>>>;
  readonly assessments: Readonly<Partial<Record<CriterionId, Assessment<number>>>>;
  readonly cost: Assessment<CostShape>;
  /** Who has to be asked, and what, before this can be scored. */
  readonly openQuestions: readonly string[];
}

export type Verdict = 'RECOMMENDED' | 'FALLBACK' | 'VIABLE' | 'DISQUALIFIED' | 'CANNOT_SAY_YET';

export interface CandidateScore {
  readonly candidate: Candidate;
  readonly verdict: Verdict;
  /** Out of 100, over the criteria that are actually known. Null when a verdict is impossible. */
  readonly score: number | null;
  readonly known: readonly CriterionId[];
  readonly missing: readonly CriterionId[];
  /** Critical capabilities this provider has not shown. Any at all makes it non-viable. */
  readonly missingCritical: readonly string[];
  readonly reason: Bilingual;
}

export interface Recommendation {
  readonly asOf: string;
  readonly scores: readonly CandidateScore[];
  /** The provider to build on. Null while the evidence does not support naming one. */
  readonly primary: CandidateScore | null;
  /** The one to move to if the primary fails us. A single-provider plan is not a plan. */
  readonly fallback: CandidateScore | null;
  readonly writtenProposals: number;
  readonly deferral: { readonly why: Bilingual; readonly toAsk: readonly string[] } | null;
  readonly summary: Bilingual;
}
