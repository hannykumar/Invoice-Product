/**
 * Issue #59 [E59] — where a GST rate comes from when the bill does not say, and what happens when
 * the bill says something the register disagrees with.
 *
 * Two situations, one register. A supplier's bill is photographed and the tax column is smudged, so
 * the product has to offer a rate. Or the bill states 18% on cement, and the register says 28%, so
 * the product has to say so rather than bill at the smudge.
 *
 * Four rules run through this whole module, and each is enforced by the types rather than promised
 * in a comment.
 *
 *   1. **A rate is never produced by a model.** A model may read a line and propose *what the goods
 *      are* — an HSN code, or a match to an item already in the master list. It may not propose the
 *      percentage, and `ProposedClassification` below has nowhere to put one. The percentage always
 *      comes from the register, and the register comes from #54.
 *   2. **Nothing is applied without a person saying so.** A suggestion is a suggestion. It carries
 *      its citation, its effective date and the reason it was chosen, and it changes nothing until
 *      somebody approves it.
 *   3. **The document's own date decides.** A bill from March is answered with the rate that was in
 *      force in March, not with today's. This is not a nicety: a back-dated bill priced at today's
 *      rate is a wrong return.
 *   4. **Ambiguity is a question, never a choice.** No entry, three entries that disagree, an HSN
 *      nobody has confirmed — all of them stop and ask. The one thing this module must never do is
 *      pick the first plausible number and move on.
 */
import type { BasisPoints, Id, IsoDate, Paise } from '../../masters/src/types.ts';

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/** What the register was matched on. An item default is more specific and wins. */
export type RateBasis = 'ITEM_DEFAULT' | 'HSN_DEFAULT';

/**
 * Where a rate came from, in enough detail to defend it years later.
 *
 * Every one of these fields is on the first acceptance criterion. A suggestion that cannot name its
 * notification, its effective date and what it was matched on is not a suggestion this module is
 * allowed to make.
 */
export interface RateCitation {
  /** The notification, in the register's own words: "Notification 1/2017-CTR, Schedule III". */
  readonly source: string;
  /** When this entry took effect. The reason a March bill gets March's rate. */
  readonly effectiveFrom: IsoDate;
  /** The register row, so the exact entry can be produced on demand. */
  readonly registerEntryId: Id;
}

/** What was matched, so the reason can be written in words rather than in identifiers. */
export type RateSubject =
  | { readonly kind: 'ITEM'; readonly itemId: Id; readonly itemName: string | null; readonly hsnSac: string | null }
  | { readonly kind: 'HSN'; readonly hsnSac: string; readonly describedAs: string | null };

/**
 * A rate the register holds, with everything needed to explain it.
 *
 * Cess and reverse charge travel with the rate rather than being fetched separately, because a
 * suggestion that mentions 28% and omits the cess is a suggestion that under-bills.
 */
export interface RegisterRate {
  readonly gstRateBasisPoints: BasisPoints;
  readonly cessRateBasisPoints?: BasisPoints;
  readonly cessPerUnitPaise?: Paise;
  readonly reverseCharge: boolean;
  readonly basis: RateBasis;
  readonly subject: RateSubject;
  readonly citation: RateCitation;
}

/**
 * A rate offered to a person, with the sentence they will read.
 *
 * `reason` is the whole product here. "18%" is not useful; "18% because this is HSN 72142090, TMT
 * Steel Bar, per Notification 1/2017-CTR Schedule III entry 224" is something a shopkeeper can agree
 * or disagree with, which is the only way approval means anything.
 */
export interface RateSuggestion {
  readonly rate: RegisterRate;
  /** The date the rate was looked up as of: the document's own date, always. */
  readonly asOf: IsoDate;
  readonly reason: Bilingual;
  /** The question the screen puts to the user, ending in something they can say yes to. */
  readonly question: Bilingual;
  /**
   * Set when the classification behind this suggestion came from a model rather than from a
   * person or the master list. The rate never does; the *match* may, and then it must be shown
   * and confirmed before any figure depends on it.
   */
  readonly restingOn?: ProposedClassification;
}

/**
 * What a model is allowed to propose: what the goods are. Never what the tax is.
 *
 * There is deliberately no rate, no percentage and no amount on this type. That is the enforcement
 * of the second acceptance criterion — not a rule somebody has to remember, but a shape that has
 * nowhere to put the forbidden thing.
 */
export interface ProposedClassification {
  /** The HSN or SAC the model read or inferred. */
  readonly hsnSac?: string;
  /** An item in the master list the model thinks this line is. */
  readonly itemId?: Id;
  /** Always `MODEL`. Present so a screen can mark it without inferring. */
  readonly proposedBy: 'MODEL';
  /** Which model, so a bad run can be traced. */
  readonly modelReference: string;
  /** The model's own confidence, 0 to 1. Shown; never used to decide anything. */
  readonly confidence: number;
  /** The line text it read. What the user checks the proposal against. */
  readonly fromText: string;
  /** Who confirmed it, once somebody has. Absent means it is still a proposal. */
  readonly confirmedBy?: Id;
  readonly confirmedAt?: string;
}

/** Why the register could not answer, each one a different thing to ask a person. */
export type RateUnknownReason =
  /** Nothing in the register matches this item or this code. */
  | 'NO_ENTRY'
  /** The line has no HSN and its item is not in the master list, so there is nothing to match on. */
  | 'NOTHING_TO_MATCH_ON'
  /** More than one entry matches and they do not agree. The register itself needs fixing. */
  | 'CONFLICTING_ENTRIES'
  /** A model proposed the classification and nobody has confirmed it yet. */
  | 'CLASSIFICATION_UNCONFIRMED';

/**
 * The answer to "what rate should this line use".
 *
 * Three outcomes and no fourth. There is no "best guess" branch, which is the point: a caller
 * cannot accidentally treat an unanswerable line as answered, because there is no shape for it.
 */
export type RateAdvice =
  | { readonly kind: 'SUGGESTED'; readonly suggestion: RateSuggestion }
  | {
      readonly kind: 'ASK';
      readonly reason: RateUnknownReason;
      /** Every entry that could have applied, when there is more than one. Shown, never picked. */
      readonly candidates: readonly RegisterRate[];
      readonly question: Bilingual;
      /** What a person would have to do to make this answerable. */
      readonly whatWouldHelp: Bilingual;
      /** Present when the block is an unconfirmed model proposal, so a screen can offer it. */
      readonly awaitingConfirmationOf?: ProposedClassification;
    };

// ---------------------------------------------------------------- checking what the bill says

export type CrossCheckVerdict =
  /** The bill and the register say the same thing. */
  | 'AGREES'
  /** They disagree. One of them is wrong, and this module does not decide which. */
  | 'DISAGREES'
  /** The register has nothing to check against. Silence is not agreement. */
  | 'NOT_IN_REGISTER'
  /** The register disagrees with itself about this code, so it cannot be used as a check. */
  | 'REGISTER_CONFLICTED';

/**
 * The result of holding a printed rate up against the register.
 *
 * `DISAGREES` deliberately does not say which side is right. The bill may be wrong, or the
 * business's own register may be out of date, and a product that assumes the register wins will
 * quietly "correct" a supplier who was right. It says both figures and asks.
 */
export interface RateCrossCheck {
  readonly verdict: CrossCheckVerdict;
  readonly asOf: IsoDate;
  /** What the document charged, in basis points. 18% is 1800. */
  readonly documentSaysBasisPoints: BasisPoints;
  /** What the register holds, where it holds anything. */
  readonly registerSays: RegisterRate | null;
  /** Every matching entry, for the conflicted case. */
  readonly candidates: readonly RegisterRate[];
  readonly message: Bilingual;
  /** Raised on `DISAGREES` and on `REGISTER_CONFLICTED`. Null when there is nothing to report. */
  readonly finding: RateFinding | null;
}

export type RateFindingCode =
  | 'GST_RATE_DISAGREES_WITH_REGISTER'
  | 'GST_RATE_REGISTER_CONFLICTED'
  | 'GST_RATE_NOT_IN_REGISTER';

/**
 * A finding in the shape the purchase-invoice validation (#16) already uses.
 *
 * Same severities, same idea of a field path, so a rate finding sits in the same list as a
 * mismatched total and needs no separate screen.
 */
export interface RateFinding {
  readonly code: RateFindingCode;
  readonly severity: 'MATERIAL' | 'SIGNIFICANT' | 'MINOR';
  /** The line this is about, e.g. "lines[2].gstRateBasisPoints". */
  readonly field: string;
  readonly message: Bilingual;
  readonly documentSays: string;
  readonly registerSays: string | null;
}

// ---------------------------------------------------------------- approving and remembering

export interface ApproveSuggestionCommand {
  /** Retrying with the same key writes one default, not two. */
  readonly idempotencyKey: string;
  /** The item the approved rate is remembered against. Approval always learns at item level. */
  readonly itemId: Id;
  readonly rate: RegisterRate;
  /**
   * The date the learned default takes effect: the approval date, not the document date.
   *
   * A person approving a rate today is saying what is true from today. Back-dating their approval
   * to the bill's date would silently restate every earlier bill for that item.
   */
  readonly approvedOn: IsoDate;
  /** Required when the suggestion rested on a model's classification. */
  readonly confirmedClassification?: ProposedClassification;
}

export interface ApprovedRate {
  readonly itemId: Id;
  readonly gstRateBasisPoints: BasisPoints;
  readonly effectiveFrom: IsoDate;
  /** What is written into the register as the source, including who approved and from where. */
  readonly source: string;
  readonly learned: boolean;
  readonly message: Bilingual;
}
