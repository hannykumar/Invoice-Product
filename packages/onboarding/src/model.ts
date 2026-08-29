/**
 * Issue #36 [E36] — what setting up a business looks like.
 *
 * The person doing this has never used accounting software and is doing it on a phone, probably
 * between customers. Two things follow, and they shape everything here:
 *
 *  1. **They will stop halfway.** Every answer is saved the moment it is given, and resuming
 *     returns them to exactly where they were. Losing a shopkeeper's forty minutes of typing is
 *     not a bug to fix later; it is the thing that makes them stop using the product.
 *  2. **They should never be asked something the product can work out**, and never told something
 *     the product does not actually know. A default that looks like a fact is worse than a blank.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';

export type StepId =
  | 'business'
  | 'tax_profile'
  | 'branding'
  | 'items'
  | 'rates'
  | 'opening_balances'
  | 'ready';

export const STEP_ORDER: readonly StepId[] = [
  'business',
  'tax_profile',
  'branding',
  'items',
  'rates',
  'opening_balances',
  'ready',
];

/** Mirrors the six user-facing state groups from issue #46, not a private vocabulary. */
export type StepState = 'NOT_STARTED' | 'IN_PROGRESS' | 'NEEDS_ATTENTION' | 'DONE' | 'SKIPPED';

export type BusinessType = 'RETAIL' | 'WHOLESALE' | 'BAKERY' | 'SERVICES' | 'TRANSPORT' | 'MANUFACTURING';

export type Registration = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';

export interface StepProblem {
  readonly code: string;
  readonly message: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly field?: string;
}

export interface StepStatus {
  readonly state: StepState;
  readonly problems: readonly StepProblem[];
  readonly completedAt: string | null;
}

export interface BusinessAnswers {
  readonly legalName?: string;
  readonly tradeName?: string;
  readonly businessType?: BusinessType;
  readonly stateCode?: string;
  readonly addressLines?: readonly string[];
  readonly phone?: string;
}

export interface TaxProfileAnswers {
  readonly registration?: Registration;
  readonly gstin?: string | null;
  /** Monthly or quarterly. Recorded, never inferred from turnover. */
  readonly filingFrequency?: 'MONTHLY' | 'QUARTERLY';
  readonly booksStartDate?: IsoDate;
}

export interface BrandingAnswers {
  readonly templateId?: string;
  readonly logoDataUri?: string | null;
  readonly invoicePrefix?: string;
  readonly branchCode?: string;
}

export interface OnboardingItem {
  readonly itemId: string;
  readonly name: string;
  readonly kind: 'GOODS' | 'SERVICES';
  readonly baseUnit: string;
  readonly hsnOrSac: string | null;
  readonly openingQuantity?: string;
  readonly openingValue?: Money;
}

export interface DeclaredRateAnswer {
  readonly code: string;
  readonly kind: 'GOODS' | 'SERVICES';
  readonly ratePercentTimes100: bigint;
  /** Where the business says the figure comes from. Required — see issue #54, option C. */
  readonly basis: string;
}

export interface OpeningBalanceEntry {
  /**
   * The account this goes to. Omitted when `party` is given, because a customer's or supplier's
   * account is opened during setup rather than chosen from a list they have never seen.
   */
  readonly accountCode?: string;
  readonly label: string;
  readonly debit: Money;
  readonly credit: Money;
  /** "Hotel Rajmahal owes me ₹4,500" — the account is created from this when setup finishes. */
  readonly party?: { readonly partyId: string; readonly name: string; readonly kind: 'CUSTOMER' | 'SUPPLIER' };
}

export interface OnboardingAnswers {
  readonly business: BusinessAnswers;
  readonly taxProfile: TaxProfileAnswers;
  readonly branding: BrandingAnswers;
  readonly items: readonly OnboardingItem[];
  readonly rates: readonly DeclaredRateAnswer[];
  readonly openingBalances: readonly OpeningBalanceEntry[];
  /**
   * Set only when a person has looked at a difference in the opening balances and said to record
   * it. It is never set by the product, because the difference is real money nobody has explained.
   */
  readonly openingDifferenceAccepted?: { readonly reason: string; readonly acceptedBy: UserId } | null;
}

export interface OnboardingSession {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly state: 'IN_PROGRESS' | 'COMPLETED';
  readonly steps: Readonly<Record<StepId, StepStatus>>;
  readonly answers: OnboardingAnswers;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the opening balances have been posted, so they can never be posted twice. */
  readonly openingVoucherId: string | null;
  readonly version: number;
}

export const emptyAnswers = (): OnboardingAnswers => ({
  business: {},
  taxProfile: {},
  branding: {},
  items: [],
  rates: [],
  openingBalances: [],
  openingDifferenceAccepted: null,
});

export const emptySteps = (): Record<StepId, StepStatus> => {
  const fresh: StepStatus = { state: 'NOT_STARTED', problems: [], completedAt: null };
  const steps = {} as Record<StepId, StepStatus>;
  for (const id of STEP_ORDER) steps[id] = fresh;
  return steps;
};

export const ONBOARDING_PERMISSIONS = {
  run: 'onboarding.run',
  finish: 'onboarding.finish',
} as const;
