/**
 * Issue #54 [X06] — what an official source is, and what it is not.
 *
 * A compliance rule may not be APPROVED until an entry here says where it comes from. The point of
 * the register is that "we are fairly sure" is not a source, and a consultant's blog is not law.
 */
import type { IsoDate } from '@invoice/kernel';

/**
 * How much weight a document carries.
 *
 * Only `STATUTE`, `RULE`, `NOTIFICATION` and `ORDER` are law. `CIRCULAR` and `OFFICIAL_FAQ` are
 * the administration's own reading of it — useful, binding on officers, but not the statute.
 * `COMMENTARY` exists so that a helpful secondary source can be *recorded* while being
 * structurally incapable of approving a rule.
 */
export type Authority = 'STATUTE' | 'RULE' | 'NOTIFICATION' | 'ORDER' | 'CIRCULAR' | 'OFFICIAL_FAQ' | 'COMMENTARY';

/** Authority classes that may support an APPROVED compliance rule. */
export const LEGAL_AUTHORITIES: readonly Authority[] = ['STATUTE', 'RULE', 'NOTIFICATION', 'ORDER'];

/** Authority classes that may support a rule only alongside a legal source. */
export const SUPPORTING_AUTHORITIES: readonly Authority[] = ['CIRCULAR', 'OFFICIAL_FAQ'];

/**
 * Whether we actually read the document, and how.
 *
 * `FIRST_HAND` means the text below was retrieved from the publisher's own domain and quoted.
 * `SECOND_HAND` means we have the substance from an official summary or index but could not
 * retrieve the primary text — those may be recorded but never approve a rule.
 */
export type Verification = 'FIRST_HAND' | 'SECOND_HAND' | 'UNVERIFIED';

export type SourceState = 'ACTIVE' | 'SUPERSEDED' | 'WITHDRAWN' | 'NEEDS_REVIEW';

export interface ComplianceSource {
  /** Stable, referenced by rules as `sourceRef`. */
  readonly id: string;
  readonly title: string;
  readonly authority: Authority;
  /** The body that issued it, e.g. "Parliament of India", "CBIC". */
  readonly publisher: string;
  /** The publisher's own domain. A source hosted anywhere else cannot be a legal authority. */
  readonly url: string;
  /** The precise provision this entry is about, e.g. "Section 10(1)(a)". */
  readonly provision: string;
  /** The words the rule actually relies on. Kept short: a citation, not a reproduction. */
  readonly quotedText: string;
  /** From when the provision applies. */
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  /** When we last read it. Staleness is measured from here. */
  readonly retrievedOn: IsoDate;
  readonly verification: Verification;
  readonly state: SourceState;
  /** Set when this source has been replaced; points at the entry that replaced it. */
  readonly supersededBy: string | null;
  /** Who checked it, and when. A source with no reviewer cannot approve a rule. */
  readonly reviewedBy: string | null;
  readonly reviewedOn: IsoDate | null;
  /** When this entry must be looked at again. */
  readonly reviewDue: IsoDate;
  readonly notes: string | null;
}

/** Links one rule to the sources it stands on, and to the tests that prove it behaves. */
export interface RuleSourceLink {
  readonly ruleId: string;
  readonly ruleVersion: string;
  /** At least one must be a legal authority for the rule to be APPROVED. */
  readonly sourceIds: readonly string[];
  /** Test names that exercise this rule. Makes "trace a decision to its test" mechanical. */
  readonly tests: readonly string[];
}

/**
 * Something a person decided, that the sources alone do not settle: an interpretation, or a
 * scenario we have deliberately chosen not to support yet.
 */
export interface DecisionLogEntry {
  readonly id: string;
  readonly question: string;
  readonly decision: string;
  readonly rationale: string;
  readonly kind: 'INTERPRETATION' | 'UNSUPPORTED_SCENARIO' | 'DEFERRED';
  readonly decidedBy: string;
  readonly decidedOn: IsoDate;
  readonly affectedRules: readonly string[];
  readonly sourceIds: readonly string[];
  /** What would let us settle this properly. */
  readonly whatWouldResolveIt: string;
}

/** A piece of work the register has generated for a person. */
export interface ReviewTask {
  readonly kind: 'STALE_SOURCE' | 'SUPERSEDED_SOURCE' | 'WITHDRAWN_SOURCE' | 'UNREVIEWED_SOURCE' | 'RULE_WITHOUT_LEGAL_SOURCE' | 'RULE_WITHOUT_TESTS' | 'BROKEN_LINK';
  readonly subject: string;
  readonly summary: string;
  readonly severity: 'BLOCKING' | 'ACTION_REQUIRED' | 'INFORMATIONAL';
}
