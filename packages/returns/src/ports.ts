import type { CompanyId, IsoDate, Money, PartyId, Quantity } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { ReturnNote } from './model.ts';

export interface OriginalReturnLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly description: string;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly quantity: Quantity;
  readonly warehouseId: string | null;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  /** What the customer was charged for this line. Reverse-charge tax is excluded. */
  readonly total: Money;
}

export interface OriginalSalesDocument {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly number: string;
  readonly date: IsoDate;
  readonly partyId: PartyId;
  readonly state: 'FINAL' | 'CANCELLED';
  readonly governmentRegistered: boolean;
  readonly lines: readonly OriginalReturnLine[];
}

export interface SalesReturnSourcePort {
  findSalesDocument(companyId: CompanyId, id: string): Promise<OriginalSalesDocument | null>;
}

export interface OriginalPurchaseDocument {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly number: string;
  readonly date: IsoDate;
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly state: 'FINAL' | 'CANCELLED';
  readonly reverseCharge: boolean;
  readonly governmentRegistered: boolean;
  readonly lines: readonly (OriginalReturnLine & { readonly ineligibleTax: Money })[];
}

export interface PurchaseReturnSourcePort {
  findPurchaseDocument(companyId: CompanyId, id: string): Promise<OriginalPurchaseDocument | null>;
}

export interface ReturnNoteRepository {
  insert(note: ReturnNote): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<ReturnNote | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnNote | null>;
  listForOriginal(companyId: CompanyId, originalDocumentId: string): Promise<ReturnNote[]>;
  list(companyId: CompanyId): Promise<ReturnNote[]>;
}

export interface ReturnInventoryLine {
  readonly noteId: string;
  readonly noteNumber: string;
  readonly originalDocumentId: string;
  readonly originalLineId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchId: string | null;
  readonly serialNumbers: readonly string[];
  readonly replacementSerialNumbers: readonly string[];
  readonly quantity: Quantity;
  readonly disposition: 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT';
  readonly documentDate: IsoDate;
  readonly reason: string;
}

/** Runs inside the return service's existing ledger transaction. */
export interface ReturnInventoryPort {
  applySalesReturnIn(actor: ActorContext, line: ReturnInventoryLine): Promise<readonly string[]>;
  applyPurchaseReturnIn(actor: ActorContext, line: ReturnInventoryLine): Promise<readonly string[]>;
}

export const noReturnInventory: ReturnInventoryPort = {
  async applySalesReturnIn() { return []; },
  async applyPurchaseReturnIn() { return []; },
};
