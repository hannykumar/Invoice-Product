// Issue #18 [E18] — storage for orders, deliveries and match approvals.
//
// All three register as `TransactionParticipant`s on the ledger store, so a confirmation that
// fails halfway — the godown refuses the third line — rolls the receipt row back with the stock
// it had already moved. In Postgres this is one transaction and the snapshot is unnecessary.

import type { CompanyId } from "@invoice/kernel";
import type { TransactionParticipant } from "@invoice/ledger";
import type { GoodsReceipt, MatchApproval, MatchTolerancePolicy, PurchaseOrder } from "./matching-types.ts";
import { DEFAULT_MATCH_TOLERANCE } from "./matching-types.ts";
import type {
  GoodsReceiptRepository, MatchApprovalRepository, MatchTolerancePort, PurchaseOrderRepository,
} from "./matching-ports.ts";

export class InMemoryPurchaseOrderStore implements PurchaseOrderRepository, TransactionParticipant {
  #orders: PurchaseOrder[] = [];

  snapshot(): unknown { return [...this.#orders]; }
  restore(taken: unknown): void { this.#orders = [...(taken as PurchaseOrder[])]; }

  async insert(order: PurchaseOrder): Promise<void> { this.#orders.push(Object.freeze(order)); }

  async update(order: PurchaseOrder): Promise<void> {
    const index = this.#orders.findIndex((candidate) => candidate.companyId === order.companyId && candidate.id === order.id);
    if (index >= 0) this.#orders[index] = Object.freeze(order);
  }

  async findById(companyId: CompanyId, id: string): Promise<PurchaseOrder | null> {
    return this.#orders.find((order) => order.companyId === companyId && order.id === id) ?? null;
  }

  async findByNumber(companyId: CompanyId, orderNumber: string): Promise<PurchaseOrder | null> {
    return this.#orders.find((order) => order.companyId === companyId && order.orderNumber === orderNumber) ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: string): Promise<PurchaseOrder[]> {
    return this.#orders.filter((order) => order.companyId === companyId && order.supplierPartyId === partyId);
  }

  async list(companyId: CompanyId): Promise<PurchaseOrder[]> {
    return this.#orders.filter((order) => order.companyId === companyId);
  }
}

export class InMemoryGoodsReceiptStore implements GoodsReceiptRepository, TransactionParticipant {
  #receipts: GoodsReceipt[] = [];

  snapshot(): unknown { return [...this.#receipts]; }
  restore(taken: unknown): void { this.#receipts = [...(taken as GoodsReceipt[])]; }

  async insert(receipt: GoodsReceipt): Promise<void> { this.#receipts.push(Object.freeze(receipt)); }

  async update(receipt: GoodsReceipt): Promise<void> {
    const index = this.#receipts.findIndex((candidate) => candidate.companyId === receipt.companyId && candidate.id === receipt.id);
    if (index >= 0) this.#receipts[index] = Object.freeze(receipt);
  }

  async findById(companyId: CompanyId, id: string): Promise<GoodsReceipt | null> {
    return this.#receipts.find((receipt) => receipt.companyId === companyId && receipt.id === id) ?? null;
  }

  async findByNumber(companyId: CompanyId, receiptNumber: string): Promise<GoodsReceipt | null> {
    return this.#receipts.find((receipt) => receipt.companyId === companyId && receipt.receiptNumber === receiptNumber) ?? null;
  }

  async listForOrder(companyId: CompanyId, orderId: string): Promise<GoodsReceipt[]> {
    return this.#receipts.filter((receipt) => receipt.companyId === companyId && receipt.orderId === orderId);
  }

  async listForParty(companyId: CompanyId, partyId: string): Promise<GoodsReceipt[]> {
    return this.#receipts.filter((receipt) => receipt.companyId === companyId && receipt.supplierPartyId === partyId);
  }

  async list(companyId: CompanyId): Promise<GoodsReceipt[]> {
    return this.#receipts.filter((receipt) => receipt.companyId === companyId);
  }
}

export class InMemoryMatchApprovalStore implements MatchApprovalRepository, TransactionParticipant {
  #approvals: { companyId: CompanyId; approval: MatchApproval }[] = [];

  snapshot(): unknown { return [...this.#approvals]; }
  restore(taken: unknown): void { this.#approvals = [...(taken as { companyId: CompanyId; approval: MatchApproval }[])]; }

  async insert(companyId: CompanyId, approval: MatchApproval): Promise<void> {
    this.#approvals.push({ companyId, approval: Object.freeze(approval) });
  }

  async findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<MatchApproval | null> {
    return this.#approvals.find((row) => row.companyId === companyId && row.approval.matchFingerprint === fingerprint)?.approval ?? null;
  }
}

/**
 * Effective-dated tolerances held in memory.
 *
 * A company's policies are kept newest-first and the one in force on the date asked for is
 * returned, so a comparison made last year is explained under last year's tolerance rather than
 * today's. That is the same reason #16 records its money tolerance on every verdict.
 */
export class InMemoryMatchTolerances implements MatchTolerancePort {
  readonly #byCompany = new Map<string, MatchTolerancePolicy[]>();

  set(companyId: CompanyId, policy: MatchTolerancePolicy): void {
    const existing = this.#byCompany.get(companyId) ?? [];
    const merged = [...existing.filter((candidate) => candidate.effectiveFrom !== policy.effectiveFrom), policy];
    merged.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
    this.#byCompany.set(companyId, merged);
  }

  async policyFor(companyId: CompanyId, on: string): Promise<MatchTolerancePolicy> {
    const policies = this.#byCompany.get(companyId) ?? [];
    return policies.find((policy) => policy.effectiveFrom <= on) ?? DEFAULT_MATCH_TOLERANCE;
  }
}
