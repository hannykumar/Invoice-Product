/**
 * Issue #53 [X05] — what it takes to be allowed to read a lorry's registration record, and what we
 * are allowed to read once we are.
 *
 * A registering authority does not sell vehicle data. It grants a named company, for a stated
 * purpose, permission to read named fields — and it can withdraw that permission. So this is not a
 * procurement exercise with a price at the end of it; it is an application, and the application is
 * mostly an argument about necessity: every field asked for has to be one the product cannot do its
 * job without.
 *
 * Nothing here can submit the application. That needs a company that exists (#49), a signatory, a
 * board resolution and a security questionnaire answered by a person. What can be done here is to
 * make the application **honest and checkable**:
 *
 *   1. **The field list is derived, not written.** What we ask the authority for is the allow-list
 *      #29 already enforces in code. If the two ever drift, the tests fail — because the difference
 *      between them is either a field we take without permission or a permission we do not use.
 *   2. **Necessity is proved from the source, not asserted in a slide.** A field is justified when
 *      a deterministic rule in #28 actually reads it. A field no rule reads has to earn its place
 *      some other way, in writing, in this repository — and exactly one field does.
 *   3. **Nothing is approved until somebody says so, on paper, on a date.** There is no state in
 *      the tracker that lets "they seemed positive on the call" become approval, and no way to
 *      record an approved field the application never asked for.
 *
 * **No commercial term, reference number or approval in this package came from a provider.** Every
 * one of them is `UNKNOWN` until a named person replaces it with what arrived in writing.
 */

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/**
 * How sure we are of a fact about a provider, and why.
 *
 * `CONFIRMED` means it arrived in writing and `source` says where that writing is filed.
 * `PUBLIC_INFORMATION` means somebody read it in the provider's own published documentation — good
 * enough to shortlist, never good enough to rely on. Everything else is `UNKNOWN`, and the review
 * refuses to average an unknown into a verdict.
 */
export type Confidence = 'CONFIRMED' | 'PUBLIC_INFORMATION' | 'UNKNOWN';

export interface Assessment<T> {
  readonly value: T | null;
  readonly confidence: Confidence;
  /** Where the writing is filed. Never the document itself, never a credential. */
  readonly source: string | null;
  readonly asOf: string | null;
  readonly note: string | null;
}

export const unknown = <T>(note?: string): Assessment<T> => ({
  value: null, confidence: 'UNKNOWN', source: null, asOf: null, note: note ?? null,
});

export const known = <T>(
  value: T,
  confidence: Exclude<Confidence, 'UNKNOWN'>,
  source: string,
  asOf: string,
  note?: string,
): Assessment<T> => ({ value, confidence, source, asOf, note: note ?? null });

export const isKnown = <T>(assessment: Assessment<T>): boolean =>
  assessment.value !== null && assessment.confidence !== 'UNKNOWN';

// ------------------------------------------------------------------ what we ask for, and why

/**
 * Where a requested field ends up.
 *
 * `MASKED` is the honest description of what #29 does to the owner's name at the boundary: the full
 * name never enters this product's storage in any form, so the application should not claim we hold
 * it, and should not claim we discard it either.
 */
export type FieldStorage = 'AS_GIVEN' | 'MASKED';

/**
 * One field on the application, with the reason a person at the authority would have to accept.
 *
 * `decidesRules` is the load-bearing part. It names the checks in #28 that read this field, and the
 * necessity review verifies that claim against the rule source rather than believing it. A field
 * with an empty list is not automatically wrong — but it has to say, in `humanUseOnly`, what a
 * person does with it that no rule does, or the review rejects the application.
 */
export interface FieldRequest {
  readonly field: string;
  /** The field in words a shopkeeper can read. Taken from #29's own consent wording. */
  readonly plainName: string;
  /**
   * True for the one field that travels to the authority rather than coming back from it.
   *
   * The registration number is the question, not part of the answer, so no rule "reads" it off a
   * record and the necessity review must not expect one to. Without it there is nothing to ask.
   */
  readonly isRequestKey: boolean;
  /** The suitability question this field answers. This is the necessity argument, in one sentence. */
  readonly why: string;
  /** The checks in #28 that read it. Verified against the rule source by the necessity review. */
  readonly decidesRules: readonly string[];
  /** True when the field says something about a person rather than about a vehicle. */
  readonly personalData: boolean;
  readonly storedAs: FieldStorage;
  /**
   * Why a person needs it when no rule does. Required for, and only for, a field with no rules.
   *
   * A field that neither a rule reads nor a person can be said to need is a field we are asking for
   * because it was in the provider's response, which is the exact failure this issue exists to
   * prevent.
   */
  readonly humanUseOnly: string | null;
}

/**
 * A field the provider holds and we deliberately do not ask for.
 *
 * Writing these down is what makes minimisation reviewable. "We only asked for what we needed" is
 * unfalsifiable; "we did not ask for the chassis number, the engine number or the owner's address,
 * and here is a test that fails if any of them ever reaches storage" is not.
 */
export interface DeclinedField {
  /** The provider's own key for it, so the test can look for it in a real response. */
  readonly providerKey: string;
  readonly describedAs: string;
  readonly why: string;
}

// ------------------------------------------------------------------ the necessity review

export type NecessityVerdict =
  /** A deterministic rule reads it. The strongest justification there is. */
  | 'DECIDES_A_RULE'
  /** It is the number we send. Necessary by construction: there is no lookup without it. */
  | 'IS_THE_QUESTION'
  /** No rule reads it, and the application says in writing what a person does with it instead. */
  | 'SHOWN_TO_A_PERSON'
  /** No rule reads it and nobody has said why we want it. The application must drop it. */
  | 'UNJUSTIFIED'
  /** The application does not ask for it, but the product's code reads it. Worse than unjustified. */
  | 'TAKEN_WITHOUT_ASKING';

export interface NecessityFinding {
  readonly field: string;
  readonly verdict: NecessityVerdict;
  /** The rules found in the source that read this field. Evidence, not a claim. */
  readonly readBy: readonly string[];
  readonly note: string;
}

export interface NecessityReview {
  readonly asOf: string;
  readonly findings: readonly NecessityFinding[];
  /** True when no field is `UNJUSTIFIED` or `TAKEN_WITHOUT_ASKING`. */
  readonly passed: boolean;
  readonly summary: Bilingual;
}

// ------------------------------------------------------------------ the application itself

/**
 * Where the application has got to.
 *
 * `PREPARED` means the dossier is complete and the company documents exist; it is not a claim that
 * anything was sent. `SUBMITTED` requires a date and a reference the authority gave us. There is no
 * state between `SUBMITTED` and a written answer, on purpose: a provider being encouraging on a
 * call has nowhere to be recorded, so it cannot quietly become progress.
 */
export type ApplicationState =
  | 'NOT_STARTED'
  | 'PREPARED'
  | 'SUBMITTED'
  | 'CLARIFICATION_REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'WITHDRAWN_BY_US';

/** What the authority granted, in its own terms. Only ever filled in from a written approval. */
export interface Approval {
  /** The authority's reference for the approval. Their side of the audit trail. */
  readonly reference: string;
  readonly approvedOn: string;
  /** The fields they actually granted, which may be fewer than the fields we asked for. */
  readonly approvedFields: readonly string[];
  /** The restrictions they attached, in their words, each one a sentence somebody can act on. */
  readonly restrictions: readonly string[];
  /** When the permission has to be renewed, where it expires. */
  readonly reviewBy: string | null;
  /** Where the approval letter is filed. Never its contents. */
  readonly documentRef: string;
}

export interface ApplicationRecord {
  readonly providerId: string;
  readonly state: ApplicationState;
  readonly preparedOn: string | null;
  readonly submittedOn: string | null;
  /** The authority's acknowledgement reference for the submission, not for the approval. */
  readonly acknowledgementRef: string | null;
  /** What they came back and asked for, while the answer is outstanding. */
  readonly outstandingQuestions: readonly string[];
  readonly approval: Approval | null;
  readonly rejectedReason: string | null;
  readonly note: string | null;
}

/**
 * Whether a record is coherent, in the sense that a state carries the evidence its name implies.
 *
 * This exists because the tempting mistake with a tracker is to move the flag and mean to fill in
 * the reference later. Then the register says "approved" and nobody can say by whom, for which
 * fields, or subject to what — which is the same as not being approved, only more dangerous.
 */
export const applicationProblems = (record: ApplicationRecord): readonly string[] => {
  const problems: string[] = [];
  const { state } = record;

  if (state !== 'NOT_STARTED' && record.preparedOn === null) {
    problems.push(`${record.providerId}: the application has moved past "not started" without a date it was prepared.`);
  }
  if ((state === 'SUBMITTED' || state === 'CLARIFICATION_REQUESTED' || state === 'APPROVED' || state === 'REJECTED')
    && record.submittedOn === null) {
    problems.push(`${record.providerId}: recorded as ${state} with no date it was submitted.`);
  }
  if ((state === 'SUBMITTED' || state === 'CLARIFICATION_REQUESTED') && record.acknowledgementRef === null) {
    problems.push(`${record.providerId}: submitted with no acknowledgement reference, so there is nothing to chase them with.`);
  }
  if (state === 'CLARIFICATION_REQUESTED' && record.outstandingQuestions.length === 0) {
    problems.push(`${record.providerId}: they have asked for something and nobody wrote down what.`);
  }
  if (state === 'APPROVED') {
    if (record.approval === null) {
      problems.push(`${record.providerId}: approved with no approval on file, which is not approval.`);
    } else {
      if (record.approval.approvedFields.length === 0) {
        problems.push(`${record.providerId}: approved without saying which fields were granted.`);
      }
      if (record.approval.documentRef.trim() === '') {
        problems.push(`${record.providerId}: approved with no letter anybody can open.`);
      }
    }
  }
  if (state !== 'APPROVED' && record.approval !== null) {
    problems.push(`${record.providerId}: an approval is on file but the state does not say approved.`);
  }
  if (state === 'REJECTED' && record.rejectedReason === null) {
    problems.push(`${record.providerId}: rejected without recording why, so nobody knows whether to reapply.`);
  }
  return Object.freeze(problems);
};

/** The one thing every lookup this product makes is for. Held as data so a second use is a change. */
export const DECLARED_PURPOSE = 'TRANSPORT_SUITABILITY' as const;
