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
}

export const RETURN_PERMISSIONS = {
  create: 'returns.create',
} as const;
