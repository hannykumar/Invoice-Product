/**
 * Issue #141 — what a delivery challan is.
 *
 * A delivery challan is the paper that travels with goods when no tax invoice goes with them. GST
 * allows it only for the movements CGST Rule 55 names, and says exactly what it must carry. The law
 * decides this file; nothing here is a design preference.
 *
 * What Rule 55 requires, and where each requirement lives:
 *
 *  - **When a challan may be used** — Rule 55(1)(a) to (d), Rule 55(4), and section 31(7) for goods
 *    sent on approval. Each is a `ChallanReason` below, with the rule that permits it.
 *  - **What it must carry** — Rule 55(1)(i) to (ix). The value of the goods (taxable value) is on
 *    every challan. The tax rate and tax amount are on it **only when the goods are moving as a
 *    sale to the consignee** (clause vii), so job work and the business's own movements carry the
 *    value and no tax. Place of supply is required for a movement between states (clause viii).
 *  - **Its number** — a consecutive serial of at most sixteen characters, unique in the financial
 *    year, in a series of its own. See `challan-numbering.ts`.
 *  - **Its copies** — three, marked for the consignee, the transporter and the consigner
 *    (Rule 55(2)). The printing module draws them.
 *  - **The e-way bill** — a challan used in place of an invoice is declared on an e-way bill like
 *    one (Rule 55(3)), so a challan can carry the e-way bill number.
 *  - **The invoice that follows** — where the goods were moving as a sale, the tax invoice is issued
 *    after delivery (Rule 55(4)) and is linked back to the challan here.
 */
import type { BranchId, CompanyId, IsoDate, Money, PartyId, Quantity, UserId } from '@invoice/kernel';
import type { TaxSplit } from '@invoice/gst-calc';

/**
 * `ISSUED` — numbered and printed, the goods may move on it.
 * `INVOICED` — the tax invoice that followed has been linked to it. Nothing more happens to it.
 * `CANCELLED` — the goods never moved on it. The number stays used, so the series has no gap.
 */
export type ChallanState = 'ISSUED' | 'INVOICED' | 'CANCELLED';

export type ChallanReason =
  | 'SUPPLY_INVOICE_TO_FOLLOW'
  | 'LIQUID_GAS'
  | 'SUPPLY_ON_APPROVAL'
  | 'JOB_WORK'
  | 'OWN_USE'
  | 'EXHIBITION_OR_FAIRS'
  | 'OTHER_NOT_A_SUPPLY';

/**
 * The reason for movement, as the e-way bill portal names it (its "sub-supply type").
 *
 * Written out here with the same spelling as `MovementReason` in `packages/transport`, so the
 * e-way bill takes the challan's own answer rather than a person choosing it a second time.
 */
export type ChallanMovementReason = 'SUPPLY' | 'JOB_WORK' | 'FOR_OWN_USE' | 'EXHIBITION_OR_FAIRS' | 'OTHERS';

export interface ChallanReasonRule {
  readonly reason: ChallanReason;
  readonly label: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** The provision that allows goods to move on a challan for this reason. */
  readonly legalBasis: string;
  /**
   * Rule 55(1)(vii): the tax rate and tax amount are printed only when the transportation is for
   * supply to the consignee.
   */
  readonly showsTax: boolean;
  /** A tax invoice is expected to follow, and may be linked back to this challan. */
  readonly invoiceFollows: boolean;
  /** Rule 55(1)(v): the quantity is marked provisional where the exact quantity is not known. */
  readonly quantityProvisional: boolean;
  readonly movementReason: ChallanMovementReason;
  /** The business must say in its own words why the goods are moving. */
  readonly needsNote: boolean;
}

const rule = (
  reason: ChallanReason,
  en: string,
  hi: string,
  legalBasis: string,
  flags: { showsTax: boolean; invoiceFollows: boolean; quantityProvisional?: boolean; needsNote?: boolean },
  movementReason: ChallanMovementReason,
): ChallanReasonRule => ({
  reason,
  label: { 'en-IN': en, 'hi-IN': hi },
  legalBasis,
  showsTax: flags.showsTax,
  invoiceFollows: flags.invoiceFollows,
  quantityProvisional: flags.quantityProvisional ?? false,
  needsNote: flags.needsNote ?? false,
  movementReason,
});

/**
 * Every reason a challan may be issued for. A reason that is not here is not one GST allows.
 *
 * Goods sent on approval are treated as moving for supply to the consignee, so the tax that will
 * apply is printed. That is the reading that cannot leave a required particular off the paper:
 * printing the tax on an approval challan is harmless, and leaving it off where it was required is
 * not.
 */
export const CHALLAN_REASONS: readonly ChallanReasonRule[] = [
  rule(
    'SUPPLY_INVOICE_TO_FOLLOW',
    'Sale — tax invoice to follow after delivery',
    'Bikri — tax invoice delivery ke baad',
    'CGST Rule 55(4)',
    { showsTax: true, invoiceFollows: true },
    'SUPPLY',
  ),
  rule(
    'LIQUID_GAS',
    'Liquid gas — quantity not known at dispatch',
    'Liquid gas — bhejte samay matra pata nahin',
    'CGST Rule 55(1)(a)',
    { showsTax: true, invoiceFollows: true, quantityProvisional: true },
    'SUPPLY',
  ),
  rule(
    'SUPPLY_ON_APPROVAL',
    'Sent on approval',
    'Pasand aane par bikri (approval)',
    'CGST Act section 31(7)',
    { showsTax: true, invoiceFollows: true },
    'SUPPLY',
  ),
  rule('JOB_WORK', 'Job work', 'Job work', 'CGST Rule 55(1)(b)', { showsTax: false, invoiceFollows: false }, 'JOB_WORK'),
  rule('OWN_USE', 'Own use — not a sale', 'Apne istemal ke liye — bikri nahin', 'CGST Rule 55(1)(c)', { showsTax: false, invoiceFollows: false }, 'FOR_OWN_USE'),
  rule(
    'EXHIBITION_OR_FAIRS',
    'Exhibition or fair — not a sale',
    'Pradarshani ya mela — bikri nahin',
    'CGST Rule 55(1)(c)',
    { showsTax: false, invoiceFollows: false },
    'EXHIBITION_OR_FAIRS',
  ),
  rule(
    'OTHER_NOT_A_SUPPLY',
    'Other movement — not a sale',
    'Anya — bikri nahin',
    'CGST Rule 55(1)(c)',
    { showsTax: false, invoiceFollows: false, needsNote: true },
    'OTHERS',
  ),
];

export const challanReason = (reason: ChallanReason): ChallanReasonRule => {
  const found = CHALLAN_REASONS.find((r) => r.reason === reason);
  if (found === undefined) throw new Error(`"${reason}" is not a reason GST allows goods to move on a challan.`);
  return found;
};

export const isChallanReason = (value: string): value is ChallanReason => CHALLAN_REASONS.some((r) => r.reason === value);

export interface ChallanLineInput {
  readonly lineId: string;
  readonly itemId: string;
  readonly quantity: Quantity;
  /** The value of one unit. Taxable value is quantity times this. */
  readonly unitPrice: Money;
  readonly warehouseId?: string | null;
}

export interface ChallanInput {
  readonly partyId: PartyId;
  readonly reason: ChallanReason;
  /** Required for `OTHER_NOT_A_SUPPLY`; optional otherwise. Printed with the reason. */
  readonly reasonNote?: string | null;
  readonly documentDate: IsoDate;
  /** Where the goods physically go, when that is not the consignee's own state. */
  readonly deliveryStateCode?: string | null;
  readonly lines: readonly ChallanLineInput[];
  readonly narration?: string | null;
}

/** One line as it was worked out when the challan was issued. Never recomputed afterwards. */
export interface ChallanLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly hsnOrSac: string;
  readonly quantity: Quantity;
  readonly quantityProvisional: boolean;
  readonly unitPrice: Money;
  readonly taxableValue: Money;
  /** `null` when the challan carries no tax (Rule 55(1)(vii)), or the line has no rate. */
  readonly ratePercentTimes100: bigint | null;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  /** True when the goods are nil-rated or exempt, which the e-way bill leaves out of its value. */
  readonly exemptSupply: boolean;
  readonly warehouseId: string | null;
}

export interface ChallanTotals {
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly totalTax: Money;
}

/** The e-way bill the goods move under (Rule 55(3)). Typed by a person or taken from the portal. */
export interface ChallanEwayBill {
  readonly number: string;
  readonly date: IsoDate | null;
  readonly transporter: string | null;
  readonly vehicleNumber: string | null;
  readonly source: 'PORTAL' | 'TYPED';
  readonly recordedBy: UserId;
  readonly recordedAt: string;
}

/** The tax invoice raised after delivery (Rule 55(4)). */
export interface ChallanInvoiceLink {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  readonly linkedBy: UserId;
  readonly linkedAt: string;
  /** Anything about the invoice that does not match the goods on the challan, in plain words. */
  readonly differences: readonly string[];
}

export interface DeliveryChallan {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly branchId: BranchId;
  readonly state: ChallanState;
  readonly number: string;
  readonly financialYear: string;
  readonly documentDate: IsoDate;
  readonly partyId: PartyId;
  readonly reason: ChallanReason;
  readonly reasonNote: string | null;
  readonly deliveryStateCode: string | null;
  /** The consigner's state and the destination state, kept so the page can say what crossed a border. */
  readonly fromStateCode: string;
  readonly toStateCode: string | null;
  readonly interState: boolean;
  /**
   * Printed on a sale challan, and on any challan whose goods cross a state border (Rule
   * 55(1)(viii)). `null` only for a movement inside one state that is not a sale.
   */
  readonly placeOfSupplyStateCode: string | null;
  readonly showsTax: boolean;
  readonly split: TaxSplit | null;
  readonly lines: readonly ChallanLine[];
  readonly totals: ChallanTotals;
  /** Set when a rate came from the business rather than a checked notification. */
  readonly declaredRateNotice: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
  readonly narration: string | null;
  readonly ewayBill: ChallanEwayBill | null;
  readonly invoice: ChallanInvoiceLink | null;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly cancelledBy: UserId | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly idempotencyKey: string;
  readonly version: number;
}

export const CHALLAN_PERMISSIONS = {
  issue: 'challan.issue',
  cancel: 'challan.cancel',
} as const;
