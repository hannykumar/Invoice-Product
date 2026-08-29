// Issue #18 [E18] — where orders, receipts and match approvals are kept.
//
// Stock movements are #12's and are not stored here; only the movement ids are, so a cancelled
// receipt can put back exactly what it took in.

import type { CompanyId } from "@invoice/kernel";
import type { GoodsReceipt, MatchApproval, MatchTolerancePolicy, PurchaseOrder } from "./matching-types.ts";

export interface PurchaseOrderRepository {
  insert(order: PurchaseOrder): Promise<void>;
  update(order: PurchaseOrder): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<PurchaseOrder | null>;
  /** One order per number per company; this is what stops the same order being raised twice. */
  findByNumber(companyId: CompanyId, orderNumber: string): Promise<PurchaseOrder | null>;
  listForParty(companyId: CompanyId, partyId: string): Promise<PurchaseOrder[]>;
  list(companyId: CompanyId): Promise<PurchaseOrder[]>;
}

export interface GoodsReceiptRepository {
  insert(receipt: GoodsReceipt): Promise<void>;
  update(receipt: GoodsReceipt): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<GoodsReceipt | null>;
  findByNumber(companyId: CompanyId, receiptNumber: string): Promise<GoodsReceipt | null>;
  listForOrder(companyId: CompanyId, orderId: string): Promise<GoodsReceipt[]>;
  listForParty(companyId: CompanyId, partyId: string): Promise<GoodsReceipt[]>;
  list(companyId: CompanyId): Promise<GoodsReceipt[]>;
}

/** Approvals of a held match, kept apart because they answer for a decision, not a document. */
export interface MatchApprovalRepository {
  insert(companyId: CompanyId, approval: MatchApproval): Promise<void>;
  findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<MatchApproval | null>;
}

/**
 * The tolerance in force for a company on a date.
 *
 * A port rather than a table read, because #7's versioned rules will eventually answer this and
 * the rest of the module should not have to change when it does.
 */
export interface MatchTolerancePort {
  policyFor(companyId: CompanyId, on: string): Promise<MatchTolerancePolicy>;
}
