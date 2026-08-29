/**
 * Issue #11 [E11] — what a quote is made of.
 *
 * Everything here is a *suggestion or a verdict*, never a change. A price is offered with the
 * evidence behind it; a credit decision is stated with the figures it was reached from. Nothing in
 * this package writes anything, so a person can always look at the reasoning before agreeing to it.
 */
import type { IsoDate, Money, PartyId } from '@invoice/kernel';

export interface Bilingual {
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

/**
 * Where a suggested price came from. Shown next to the figure, always: a number a shopkeeper
 * cannot trace is a number they have to take on faith.
 */
export type PriceSource = 'LAST_AGREED' | 'PRICE_LIST' | 'NONE';

export interface PriceEvidence {
  /** The bill this customer was last charged on, when the source is their own history. */
  readonly documentNumber?: string;
  readonly on?: IsoDate;
  /** The list the rate was read from, when the source is a price list. */
  readonly priceListName?: string;
  /** Set when a slab rate applied, e.g. "10 or more". */
  readonly appliesFromQuantity?: string;
}

export interface PriceSuggestion {
  readonly itemId: string;
  readonly unit: string;
  /** `null` when nothing is on record. The field stays empty rather than being filled with a guess. */
  readonly amount: Money | null;
  readonly source: PriceSource;
  readonly evidence: PriceEvidence;
  /** The date the price was resolved as of, which is the document's own date. */
  readonly asOf: IsoDate;
  readonly sentence: Bilingual;
}

export type DiscountOutcome = 'ALLOW' | 'NEEDS_APPROVAL';

export interface DiscountDecision {
  /** Basis points off the suggested or entered price, so 1250 is 12.5%. */
  readonly requestedBasisPoints: number;
  readonly allowedWithoutApprovalBasisPoints: number;
  readonly outcome: DiscountOutcome;
  readonly amountOff: Money;
  readonly sentence: Bilingual;
}

/**
 * A margin warning, never a block. Selling below cost is sometimes exactly what a business means
 * to do — clearing old stock, holding a customer — and the software does not get a vote.
 */
export interface MarginWarning {
  readonly unitCost: Money;
  readonly sellingPrice: Money;
  readonly shortfallPerUnit: Money;
  readonly shortfallOnLine: Money;
  readonly sentence: Bilingual;
}

export interface LineTerms {
  readonly lineId: string;
  readonly itemId: string;
  readonly price: PriceSuggestion;
  readonly discount: DiscountDecision | null;
  /** Absent when the item's cost is not known — no cost, no claim about margin. */
  readonly margin: MarginWarning | null;
}

export type CreditOutcome = 'ALLOW' | 'WARN' | 'BLOCK';

export interface CreditDecision {
  readonly partyId: PartyId;
  readonly outcome: CreditOutcome;
  /** `null` when the business has not set one. Unknown is not the same as zero. */
  readonly limit: Money | null;
  /** Bills already issued and not yet settled. */
  readonly outstanding: Money;
  /** Bills started and not yet issued, this one aside. Left out, two tills double-spend a limit. */
  readonly pending: Money;
  readonly saleValue: Money;
  readonly exposure: Money;
  /** How far past the limit, or zero. */
  readonly excess: Money;
  readonly oldestDaysOverdue: number;
  /** The rule that decided over-limit, so the verdict can be explained and versioned. */
  readonly ruleId: string | null;
  readonly ruleVersion: string | null;
  readonly sentence: Bilingual;
  readonly why: Bilingual;
}

export type QuoteOutcome = 'ALLOW' | 'NEEDS_APPROVAL' | 'BLOCK';

export interface TradeTermsQuote {
  readonly lines: readonly LineTerms[];
  readonly credit: CreditDecision;
  readonly outcome: QuoteOutcome;
  /** What a person is told, worst first. */
  readonly reasons: readonly Bilingual[];
  /** Set when an authorised person allowed it anyway, with their reason. */
  readonly override: { readonly reason: string; readonly by: string } | null;
}

export const TRADE_TERMS_PERMISSIONS = {
  overrideCreditLimit: 'sales.override_credit_limit',
  approveDiscount: 'sales.approve_discount',
} as const;

const SEVERITY: Record<QuoteOutcome, number> = { ALLOW: 0, NEEDS_APPROVAL: 1, BLOCK: 2 };

/** The quote is only as good as its worst part. */
export const worstOf = (outcomes: readonly QuoteOutcome[]): QuoteOutcome =>
  outcomes.reduce<QuoteOutcome>((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst), 'ALLOW');

export const creditToQuoteOutcome = (outcome: CreditOutcome, warnNeedsApproval: boolean): QuoteOutcome => {
  if (outcome === 'BLOCK') return 'BLOCK';
  if (outcome === 'WARN') return warnNeedsApproval ? 'NEEDS_APPROVAL' : 'ALLOW';
  return 'ALLOW';
};
