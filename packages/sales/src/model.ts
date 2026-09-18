/**
 * Issue #9 [E09] — what a sales invoice is.
 *
 * States and transitions follow `docs/product/spec/states.json`, machine `sales_invoice`. A state
 * that is not in that file does not exist here; propose it there first.
 */
import type { BranchId, CompanyId, IsoDate, Money, PartyId, Quantity, UserId, VoucherId } from '@invoice/kernel';
import type { ComputedTaxLine, PriceBasis, TaxSplit, TaxTotals, Discount } from '@invoice/gst-calc';

export type InvoiceState = 'DRAFT' | 'PENDING_APPROVAL' | 'NEEDS_INFO' | 'FINAL' | 'CANCELLED';

/** A registered buyer or an ordinary consumer. It changes what must be printed, not the tax maths. */
export type CustomerType = 'B2B' | 'B2C';

export interface SalesInvoiceLineInput {
  readonly lineId: string;
  readonly itemId: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly priceBasis: PriceBasis;
  readonly discount?: Discount;
  /** Which godown the goods leave from. Passed through to inventory (#12). */
  readonly warehouseId?: string | null;
  readonly note?: string | null;
}

export interface DraftInvoiceInput {
  readonly partyId: PartyId;
  readonly customerType: CustomerType;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly documentDate: IsoDate;
  readonly dueDate?: IsoDate | null;
  readonly deliveryStateCode?: string | null;
  /** Only when a person has confirmed it. Otherwise the rule decides. */
  readonly placeOfSupplyStateCode?: string | null;
  readonly lines: readonly SalesInvoiceLineInput[];
  readonly freight?: Money;
  readonly otherCharges?: Money;
  readonly roundToWholeRupee?: boolean;
  readonly narration?: string | null;
}

/** What the calculator worked out, kept on the invoice so a final bill never recomputes. */
export interface InvoicePricing {
  readonly placeOfSupplyStateCode: string;
  readonly split: TaxSplit;
  readonly mayChargeGst: boolean;
  readonly lines: readonly ComputedTaxLine[];
  readonly totals: TaxTotals;
  readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** Rule ids and versions behind the tax treatment, so the bill can be explained later. */
  readonly decisions: readonly { ruleId: string | null; ruleVersion: string | null; topic: string }[];
}

/** Why the invoice cannot go forward. Shown all at once, never one at a time. */
export interface InvoiceProblem {
  readonly code: string;
  readonly lineId?: string;
  readonly message: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly messageId?: string;
}

export interface SalesInvoice {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly branchId: BranchId;
  readonly state: InvoiceState;
  /** Allocated only at FINAL, so drafts never consume a number. */
  readonly number: string | null;
  readonly financialYear: string | null;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate | null;
  readonly partyId: PartyId;
  readonly customerType: CustomerType;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly deliveryStateCode: string | null;
  readonly placeOfSupplyStateCode: string | null;
  readonly lines: readonly SalesInvoiceLineInput[];
  readonly freight: Money;
  readonly otherCharges: Money;
  readonly roundToWholeRupee: boolean;
  readonly narration: string | null;
  readonly pricing: InvoicePricing | null;
  readonly problems: readonly InvoiceProblem[];
  readonly voucherId: VoucherId | null;
  readonly cancellationVoucherId: VoucherId | null;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly finalisedBy: UserId | null;
  readonly finalisedAt: string | null;
  readonly cancelledBy: UserId | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly approvedBy: UserId | null;
  readonly approvedAt: string | null;
  readonly idempotencyKey: string;
  /** Bumped on every change, so two people editing one draft cannot overwrite each other. */
  readonly version: number;
}

export const SALES_PERMISSIONS = {
  draft: 'sales.draft.write',
  finalise: 'sales.finalise',
  approve: 'sales.approve',
  cancel: 'sales.cancel',
  overrideCreditLimit: 'sales.override_credit_limit',
} as const;

export const isEditable = (invoice: SalesInvoice): boolean =>
  invoice.state === 'DRAFT' || invoice.state === 'NEEDS_INFO';

export const isFinal = (invoice: SalesInvoice): boolean => invoice.state === 'FINAL';
