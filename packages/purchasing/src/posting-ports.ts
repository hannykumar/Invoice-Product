// Issue #17 [E17] — the narrow surfaces purchase posting needs from other lanes.

import type { CompanyId, IsoDate } from "@invoice/kernel";
import type { ActorContext } from "@invoice/ledger";
import type { StockMovement } from "../../inventory/src/model.ts";
import type { Quantity } from "../../masters/src/units.ts";
import type { Id, Paise } from "../../masters/src/types.ts";
import type { PurchaseBill } from "./posting-types.ts";

/** One stock receipt, as this module needs to ask for it. */
export interface PurchaseReceiptCommand {
  readonly idempotencyKey: string;
  readonly itemId: Id;
  readonly warehouseId: Id;
  readonly batchId?: Id | null;
  readonly serialNumbers?: readonly string[];
  readonly quantity: Quantity;
  /** Landed cost of this whole line: taxable value plus any GST that cannot be claimed. */
  readonly lineCostPaise: Paise;
  readonly documentDate: IsoDate;
  readonly source: { readonly kind: string; readonly id: string; readonly number: string | null };
  readonly reason?: string;
}

/**
 * Issue #12's surface, as purchase posting needs it.
 *
 * Both methods run inside a transaction the caller has already opened, so the goods, the books
 * and the supplier's account move as one. That is why they are `…In` methods and why this port
 * exists rather than this module reaching into the inventory service directly.
 */
export interface PurchaseInventoryPort {
  receiveIn(actor: ActorContext, command: PurchaseReceiptCommand): Promise<StockMovement>;
  /** Takes a receipt back out when a bill is reversed. */
  returnIn(actor: ActorContext, command: PurchaseReceiptCommand & { readonly negativeOverrideReason?: string }): Promise<StockMovement>;
}

export interface PurchaseBillRepository {
  insert(bill: PurchaseBill): Promise<void>;
  update(bill: PurchaseBill): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<PurchaseBill | null>;
  /** The idempotency that matters: one live bill per approved purchase. */
  findByPurchaseId(companyId: CompanyId, purchaseId: string): Promise<PurchaseBill | null>;
  listForParty(companyId: CompanyId, partyId: string): Promise<PurchaseBill[]>;
  list(companyId: CompanyId): Promise<PurchaseBill[]>;
}
