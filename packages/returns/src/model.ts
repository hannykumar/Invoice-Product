import type { CompanyId, IsoDate, Money, PartyId, Quantity, UserId, VoucherId } from '@invoice/kernel';

export type ReturnKind = 'SALES_RETURN' | 'PURCHASE_RETURN';
export type ReturnDisposition = 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT';
export type ReturnComplianceStatus = 'NOT_APPLICABLE' | 'PENDING_ADJUSTMENT';

export interface ReturnTaxAmounts {
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly ineligibleTax: Money;
  readonly reverseChargeTax: Money;
  readonly total: Money;
}

export interface ReturnNoteLine {
  readonly originalLineId: string;
  readonly itemId: string;
  readonly description: string;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly quantity: Quantity;
  readonly disposition: ReturnDisposition;
  readonly warehouseId: string | null;
  readonly batchId: string | null;
  readonly serialNumbers: readonly string[];
  readonly replacementSerialNumbers: readonly string[];
  readonly amounts: ReturnTaxAmounts;
  /**
   * Issue #186 — the HSN or SAC code, the tax rate and the rate per unit of the original bill's
   * line, copied when the note is posted. The printed note needs them (Rule 53(1A)(h)), and a
   * reprint must never depend on the original bill still being readable. `null` when the original
   * did not carry the figure.
   */
  readonly hsnOrSac: string | null;
  readonly ratePercentTimes100: bigint | null;
  readonly unitPrice: Money | null;
}

/**
 * Issue #233 — freight or another charge from the original bill, rather than goods that came back.
 * The calculator names every charge line `charge:<kind>` (gst-calc #205), and the note keeps the
 * original's item id, so this is read from what is stored and needs no column of its own.
 */
export const isChargeLine = (line: { readonly itemId: string }): boolean => line.itemId.startsWith('charge:');

/**
 * Issue #249 — the supplier's own credit note for goods we sent back to them.
 *
 * The supplier issues it, often days after the goods leave, and it is what shows up in the
 * government's purchase record (GSTR-2B). It is matched against our return there. It is optional
 * when the return is recorded and can be added later; the credit comes down from the month of the
 * return either way, because the credit on goods we no longer hold is not ours to keep.
 */
export interface SupplierCreditNoteRef {
  readonly number: string;
  readonly date: IsoDate;
}

export interface ReturnNote {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly kind: ReturnKind;
  readonly number: string;
  readonly documentDate: IsoDate;
  readonly originalDocument: {
    readonly id: string;
    readonly number: string;
    readonly date: IsoDate;
  };
  readonly partyId: PartyId;
  readonly reason: string;
  readonly lines: readonly ReturnNoteLine[];
  readonly totals: ReturnTaxAmounts;
  readonly voucherId: VoucherId;
  readonly complianceStatus: ReturnComplianceStatus;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly summary: string;
  /** Issue #249 — purchase returns only. `null` (or absent) until the supplier's note is known. */
  readonly supplierCreditNote?: SupplierCreditNoteRef | null;
}

export const RETURN_PERMISSIONS = {
  create: 'returns.create',
} as const;
