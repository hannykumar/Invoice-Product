// Issue #18 [E18] — storage for orders, deliveries and match approvals.
//
// All three register as `TransactionParticipant`s on the ledger store, so a confirmation that
// fails halfway — the godown refuses the third line — rolls the receipt row back with the stock
// it had already moved. In Postgres this is one transaction and the snapshot is unnecessary.

import { conflict, notFound, type CompanyId } from "@invoice/kernel";
import type { TransactionParticipant } from "@invoice/ledger";
import { pageOf, type Page } from "./paging.ts";
import type { GoodsReceipt, MatchApproval, MatchTolerancePolicy, PurchaseOrder } from "./matching-types.ts";
import { DEFAULT_MATCH_TOLERANCE } from "./matching-types.ts";
import type {
  GoodsReceiptRepository, MatchApprovalRepository, MatchTolerancePort, PurchaseOrderRepository,
} from "./matching-ports.ts";

// Issue #366 — the in-memory stores refuse what the database refuses, in the same words. The
// service looks before it writes, so these are only ever reached by a mistake in the calling code.
export const orderNumberTaken = (number: string) =>
  conflict("ORDER_NUMBER_TAKEN", `There is already an order numbered ${number} in this business.`);
export const orderNotFound = () => notFound("ORDER_UNKNOWN", "We could not find that purchase order.");
export const receiptNumberTaken = (number: string) =>
  conflict("RECEIPT_NUMBER_TAKEN", `There is already a delivery numbered ${number} in this business.`);
export const receiptNotFound = () => notFound("RECEIPT_UNKNOWN", "We could not find that delivery.");
export const matchAlreadyApproved = () =>
  conflict("MATCH_ALREADY_APPROVED", "These differences have already been accepted, so they were not accepted a second time.");

const createdAt = (row: { readonly createdAt: string }): string => row.createdAt;
const idOf = (row: { readonly id: string }): string => row.id;

export class InMemoryPurchaseOrderStore implements PurchaseOrderRepository, TransactionParticipant {
  #orders: PurchaseOrder[] = [];

  snapshot(): unknown { return [...this.#orders]; }
  restore(taken: unknown): void { this.#orders = [...(taken as PurchaseOrder[])]; }

  async insert(order: PurchaseOrder): Promise<void> {
    if (this.#orders.some((other) => other.companyId === order.companyId && (other.id === order.id || other.orderNumber === order.orderNumber))) {
      throw orderNumberTaken(order.orderNumber);
    }
    this.#orders.push(Object.freeze(order));
  }

  async update(order: PurchaseOrder): Promise<void> {
    const index = this.#orders.findIndex((candidate) => candidate.companyId === order.companyId && candidate.id === order.id);
    if (index < 0) throw orderNotFound();
    this.#orders[index] = Object.freeze(order);
  }

  async findById(companyId: CompanyId, id: string): Promise<PurchaseOrder | null> {
    return this.#orders.find((order) => order.companyId === companyId && order.id === id) ?? null;
  }

  async findByNumber(companyId: CompanyId, orderNumber: string): Promise<PurchaseOrder | null> {
    return this.#orders.find((order) => order.companyId === companyId && order.orderNumber === orderNumber) ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: string, page?: Page): Promise<PurchaseOrder[]> {
    return pageOf(this.#orders.filter((order) => order.companyId === companyId && order.supplierPartyId === partyId), page, createdAt, idOf);
  }

  async list(companyId: CompanyId, page?: Page): Promise<PurchaseOrder[]> {
    return pageOf(this.#orders.filter((order) => order.companyId === companyId), page, createdAt, idOf);
  }
}

export class InMemoryGoodsReceiptStore implements GoodsReceiptRepository, TransactionParticipant {
  #receipts: GoodsReceipt[] = [];

  snapshot(): unknown { return [...this.#receipts]; }
  restore(taken: unknown): void { this.#receipts = [...(taken as GoodsReceipt[])]; }

  async insert(receipt: GoodsReceipt): Promise<void> {
    if (this.#receipts.some((other) => other.companyId === receipt.companyId && (other.id === receipt.id || other.receiptNumber === receipt.receiptNumber))) {
      throw receiptNumberTaken(receipt.receiptNumber);
    }
    this.#receipts.push(Object.freeze(receipt));
  }

  async update(receipt: GoodsReceipt): Promise<void> {
    const index = this.#receipts.findIndex((candidate) => candidate.companyId === receipt.companyId && candidate.id === receipt.id);
    if (index < 0) throw receiptNotFound();
    this.#receipts[index] = Object.freeze(receipt);
  }

  async findById(companyId: CompanyId, id: string): Promise<GoodsReceipt | null> {
    return this.#receipts.find((receipt) => receipt.companyId === companyId && receipt.id === id) ?? null;
  }

  async findByNumber(companyId: CompanyId, receiptNumber: string): Promise<GoodsReceipt | null> {
    return this.#receipts.find((receipt) => receipt.companyId === companyId && receipt.receiptNumber === receiptNumber) ?? null;
  }

  async listForOrder(companyId: CompanyId, orderId: string, page?: Page): Promise<GoodsReceipt[]> {
    return pageOf(this.#receipts.filter((receipt) => receipt.companyId === companyId && receipt.orderId === orderId), page, createdAt, idOf);
  }

  async listForParty(companyId: CompanyId, partyId: string, page?: Page): Promise<GoodsReceipt[]> {
    return pageOf(this.#receipts.filter((receipt) => receipt.companyId === companyId && receipt.supplierPartyId === partyId), page, createdAt, idOf);
  }

  async list(companyId: CompanyId, page?: Page): Promise<GoodsReceipt[]> {
    return pageOf(this.#receipts.filter((receipt) => receipt.companyId === companyId), page, createdAt, idOf);
  }
}

export class InMemoryMatchApprovalStore implements MatchApprovalRepository, TransactionParticipant {
  #approvals: { companyId: CompanyId; approval: MatchApproval }[] = [];

  snapshot(): unknown { return [...this.#approvals]; }
  restore(taken: unknown): void { this.#approvals = [...(taken as { companyId: CompanyId; approval: MatchApproval }[])]; }

  async insert(companyId: CompanyId, approval: MatchApproval): Promise<void> {
    if (this.#approvals.some((row) => row.companyId === companyId && row.approval.matchFingerprint === approval.matchFingerprint)) throw matchAlreadyApproved();
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
