// Issue #17 [E17] — storage for purchase bills, and the joins to the lanes either side.

import { isoDate, money, type CompanyId, type Money, type PartyId } from "@invoice/kernel";
import { MICRO } from "../../masters/src/units.ts";
import { divideRoundHalfUp } from "./recompute.ts";
import type { StockMasterData } from "../../inventory/src/ports.ts";
import type { ActorContext, TransactionParticipant } from "@invoice/ledger";
import type { InventoryService } from "../../inventory/src/service.ts";
import type { StockMovement } from "../../inventory/src/model.ts";
import type { DocumentLedgerPort } from "../../receivables/src/ports.ts";
import type { OpenDocument } from "../../receivables/src/model.ts";
import type { PurchaseBill } from "./posting-types.ts";
import type { PurchaseBillRepository, PurchaseInventoryPort, PurchaseReceiptCommand } from "./posting-ports.ts";

/**
 * Bills held in memory, able to roll back with the ledger.
 *
 * It registers as a `TransactionParticipant` on the ledger store, so when a posting fails after
 * the bill row was written, the row goes with it. In Postgres this is one transaction and the
 * snapshot is unnecessary.
 */
export class InMemoryPurchaseBillStore implements PurchaseBillRepository, TransactionParticipant {
  #bills: PurchaseBill[] = [];

  snapshot(): unknown {
    return [...this.#bills];
  }

  restore(taken: unknown): void {
    this.#bills = [...(taken as PurchaseBill[])];
  }

  async insert(bill: PurchaseBill): Promise<void> {
    this.#bills.push(Object.freeze(bill));
  }

  async update(bill: PurchaseBill): Promise<void> {
    const index = this.#bills.findIndex((candidate) => candidate.companyId === bill.companyId && candidate.id === bill.id);
    if (index >= 0) this.#bills[index] = Object.freeze(bill);
  }

  async findById(companyId: CompanyId, id: string): Promise<PurchaseBill | null> {
    return this.#bills.find((bill) => bill.companyId === companyId && bill.id === id) ?? null;
  }

  async findByPurchaseId(companyId: CompanyId, purchaseId: string): Promise<PurchaseBill | null> {
    return this.#bills.find((bill) => bill.companyId === companyId && bill.purchaseId === purchaseId) ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: string): Promise<PurchaseBill[]> {
    return this.#bills.filter((bill) => bill.companyId === companyId && bill.supplierPartyId === partyId);
  }

  async list(companyId: CompanyId): Promise<PurchaseBill[]> {
    return this.#bills.filter((bill) => bill.companyId === companyId);
  }
}

/**
 * Issue #12's service behind this module's narrow port.
 *
 * `recordMovementIn` is the transaction-free variant, so the goods move inside the same unit of
 * work as the entry in the books. A receipt the godown refuses undoes the voucher with it.
 */
export const purchaseInventoryPort = (
  inventory: InventoryService,
  masterData: StockMasterData,
): PurchaseInventoryPort => {
  /**
   * Stock is valued at a cost per base unit, so the line's landed cost is divided by the quantity
   * in the unit stock is actually kept in. Buying ten boxes of twenty-four for ₹2,400 values each
   * of the 240 pieces at ₹10, not each box at ₹2,400.
   */
  const perBaseUnit = (actor: ActorContext, command: PurchaseReceiptCommand): Money | null => {
    const item = masterData.item(actor.companyId, command.itemId);
    if (item === undefined) return null; // the godown will refuse it by name in a moment
    const base = masterData.units(actor.companyId).convertExact(command.quantity, item.baseUnit, command.itemId);
    if (base.micro === 0n) return null;
    return money(divideRoundHalfUp(command.lineCostPaise * MICRO, base.micro));
  };

  return {
  async receiveIn(actor: ActorContext, command: PurchaseReceiptCommand): Promise<StockMovement> {
    return inventory.recordMovementIn(actor, {
      idempotencyKey: command.idempotencyKey,
      itemId: command.itemId,
      warehouseId: command.warehouseId,
      batchId: command.batchId ?? null,
      ...(command.serialNumbers === undefined ? {} : { serialNumbers: command.serialNumbers }),
      kind: "PURCHASE_IN",
      quantity: command.quantity,
      unitCost: perBaseUnit(actor, command),
      documentDate: isoDate(command.documentDate),
      source: command.source,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    });
  },

  async returnIn(actor, command): Promise<StockMovement> {
    return inventory.recordMovementIn(actor, {
      idempotencyKey: command.idempotencyKey,
      itemId: command.itemId,
      warehouseId: command.warehouseId,
      batchId: command.batchId ?? null,
      ...(command.serialNumbers === undefined ? {} : { serialNumbers: command.serialNumbers }),
      kind: "PURCHASE_RETURN_OUT",
      quantity: command.quantity,
      unitCost: null,
      documentDate: isoDate(command.documentDate),
      source: command.source,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
      ...(command.negativeOverrideReason === undefined ? {} : { negativeOverride: { reason: command.negativeOverrideReason } }),
    });
  },
  };
};

/**
 * What issue #20 asks #17 for: the purchase bills a supplier is still owed money on.
 *
 * A reversed bill is not an open document — the reversal took the credit back out of the books,
 * so leaving it here would show money owed that the ledger disagrees with.
 */
export const purchaseDocumentLedger = (
  bills: PurchaseBillRepository,
  nameOfParty: (companyId: CompanyId, partyId: string) => Promise<string>,
): DocumentLedgerPort => ({
  async openDocuments(companyId, partyId): Promise<readonly OpenDocument[]> {
    const found = await bills.listForParty(companyId, partyId);
    return found
      .filter((bill) => bill.state === "POSTED")
      .map((bill): OpenDocument => ({
        documentId: bill.id,
        kind: "PURCHASE_INVOICE",
        number: bill.invoiceNumber,
        partyId,
        date: isoDate(bill.invoiceDate),
        dueDate: isoDate(bill.dueDate),
        value: money(bill.totalPaise) as Money,
        side: "PAYABLE",
      }));
  },

  async parties(companyId) {
    const all = await bills.list(companyId);
    return [...new Set(all.map((bill) => bill.supplierPartyId))] as unknown as readonly PartyId[];
  },

  async nameOf(companyId, partyId) {
    return nameOfParty(companyId, partyId);
  },
});
