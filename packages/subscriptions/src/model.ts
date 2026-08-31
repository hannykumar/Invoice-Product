/**
 * Issue #42 [E42] — paying for the product, without the product becoming less careful.
 *
 * Three rules carry everything here:
 *
 *  1. **A plan may withhold convenience. It may never withhold correctness.** Every compliance
 *     warning, the balance and negative-stock checks, the audit trail and getting your own data out
 *     are allowed in every plan and every state, including an expired one. `definePlan()` throws if
 *     a plan tries to limit one, so it is a property of the catalogue rather than a rule somebody
 *     has to remember.
 *  2. **Nothing is ever deleted.** An unpaid plan ends in `READ_ONLY`: writing stops; reading,
 *     exporting and every essential capability continue. There is no delete path in this module.
 *  3. **What was counted is on the record.** Every usage event carries an idempotency key, so a
 *     retry is counted once and a duplicate is not counted at all.
 */
import type { IsoDate, Money } from '@invoice/kernel';

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/** What can be counted. Limits differ by these, never by whether the product tells the truth. */
export type MeterId = 'invoices' | 'companies' | 'storage_mb' | 'ai_requests' | 'external_api_calls';

export const METERS: readonly MeterId[] = ['invoices', 'companies', 'storage_mb', 'ai_requests', 'external_api_calls'];

/** Named without a period, so a sentence can add "this month" once rather than twice. */
export const METER_LABELS: Readonly<Record<MeterId, Bilingual>> = {
  invoices: { 'en-IN': 'bills', 'hi-IN': 'bill' },
  companies: { 'en-IN': 'businesses', 'hi-IN': 'business' },
  storage_mb: { 'en-IN': 'megabytes of documents', 'hi-IN': 'document ki jagah (MB)' },
  ai_requests: { 'en-IN': 'questions to the assistant', 'hi-IN': 'assistant se sawaal' },
  external_api_calls: { 'en-IN': 'government and bank calls', 'hi-IN': 'sarkar aur bank ko call' },
};

/**
 * The things a plan is not allowed to take away.
 *
 * A smaller business is not a business that deserves to be told less about its own risk. Every
 * entry here is a warning, a correctness check, or the ability to leave with your own data — and
 * `definePlan` refuses to build a plan that limits one.
 */
export const ESSENTIAL_CAPABILITIES = [
  'gst.compliance_warning',
  'einvoice.applicability_warning',
  'supplier.risk_warning',
  'stock.negative_warning',
  'ledger.balance_check',
  'credit.overdue_warning',
  'audit.read',
  'data.export',
  'reports.view.dues',
] as const;

export type EssentialCapability = (typeof ESSENTIAL_CAPABILITIES)[number];

export const isEssential = (capability: string): capability is EssentialCapability =>
  (ESSENTIAL_CAPABILITIES as readonly string[]).includes(capability);

/** How a capability behaves under a plan: reading is never gated, writing is. */
export type CapabilityKind = 'READ' | 'WRITE';

export interface Capability {
  readonly name: string;
  readonly kind: CapabilityKind;
  /** The meter this capability spends, if any. */
  readonly meter: MeterId | null;
  readonly label: Bilingual;
}

export interface PlanLimit {
  readonly meter: MeterId;
  /** Per calendar month. `null` means no limit. */
  readonly perMonth: bigint | null;
}

export interface Plan {
  readonly id: string;
  readonly name: Bilingual;
  readonly description: Bilingual;
  readonly effectiveFrom: IsoDate;
  readonly monthlyPrice: Money;
  readonly trialDays: number;
  /** How long an unpaid subscription keeps working before it becomes read-only. */
  readonly graceDays: number;
  readonly limits: readonly PlanLimit[];
}

export type SubscriptionState = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'GRACE' | 'READ_ONLY' | 'CANCELLED';

export interface Subscription {
  readonly id: string;
  readonly companyId: string;
  readonly planId: string;
  readonly startedOn: IsoDate;
  readonly trialEndsOn: IsoDate;
  /** Paid up to and including this date. Null while still in trial and never paid. */
  readonly paidThrough: IsoDate | null;
  readonly cancelledOn: IsoDate | null;
  readonly cancellationReason: string | null;
  /** Every plan this company has been on, kept for ever. A downgrade is not an erasure. */
  readonly history: readonly { readonly planId: string; readonly from: IsoDate; readonly reason: string }[];
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface UsageEvent {
  readonly id: string;
  readonly companyId: string;
  readonly meter: MeterId;
  readonly quantity: bigint;
  readonly period: string;
  readonly idempotencyKey: string;
  readonly at: string;
  readonly by: string;
  /** What was being done. Never a payload, never a figure from the books. */
  readonly note: string;
}

export interface UsageTotal {
  readonly meter: MeterId;
  readonly period: string;
  readonly used: bigint;
  readonly limit: bigint | null;
  readonly remaining: bigint | null;
  readonly label: Bilingual;
}

export type EntitlementOutcome = 'ALLOWED' | 'BLOCKED_READ_ONLY' | 'BLOCKED_LIMIT';

export interface Entitlement {
  readonly capability: string;
  readonly outcome: EntitlementOutcome;
  readonly state: SubscriptionState;
  readonly essential: boolean;
  readonly meter: MeterId | null;
  readonly used: bigint | null;
  readonly limit: bigint | null;
  readonly reason: Bilingual;
}

export type ServiceInvoiceState = 'DRAFT' | 'ISSUED' | 'PAID' | 'FAILED';

export interface ServiceInvoice {
  readonly id: string;
  readonly companyId: string;
  readonly planId: string;
  readonly period: string;
  readonly net: Money;
  readonly gst: Money;
  readonly total: Money;
  readonly state: ServiceInvoiceState;
  readonly issuedOn: IsoDate;
  readonly dueOn: IsoDate;
  readonly paidOn: IsoDate | null;
  readonly providerReference: string | null;
  readonly failureReason: string | null;
}

export const SUBSCRIPTION_PERMISSIONS = {
  view: 'subscription.view',
  manage: 'subscription.manage',
} as const;

/** GST on our own service. In basis points, like every other rate in this product. */
export const SERVICE_GST_BASIS_POINTS = 1800n;

export const periodOf = (date: IsoDate): string => date.slice(0, 7);
