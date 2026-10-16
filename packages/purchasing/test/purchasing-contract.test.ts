/** Issue #366 — the purchasing contract, against the in-memory stores. */
import { InMemoryGoodsReceiptStore, InMemoryMatchApprovalStore, InMemoryMatchTolerances, InMemoryPurchaseOrderStore } from "../src/matching-adapters.ts";
import { InMemoryPurchaseBillStore } from "../src/posting-adapters.ts";
import { InMemoryGstinCache, InMemoryRiskAcknowledgementStore, InMemoryRiskAssessmentStore, InMemoryRiskPolicies } from "../src/supplier-risk-adapters.ts";
import type { CompanyId } from "@invoice/kernel";
import { purchasingContract } from "./purchasing-contract.ts";

const bills = new InMemoryPurchaseBillStore();
const orders = new InMemoryPurchaseOrderStore();
const receipts = new InMemoryGoodsReceiptStore();
const approvals = new InMemoryMatchApprovalStore();
const assessments = new InMemoryRiskAssessmentStore();
const acknowledgements = new InMemoryRiskAcknowledgementStore();
// What the ledger store's transaction does in the running app: snapshot every participant, restore on failure.
const participants = [bills, orders, receipts, approvals, assessments, acknowledgements];

purchasingContract("memory", () => ({
  bills, orders, receipts, approvals, assessments, acknowledgements,
  tolerances: new InMemoryMatchTolerances(), policies: new InMemoryRiskPolicies(), cache: new InMemoryGstinCache(),
  requiresUnitOfWork: false,
  scene: async () => ({ companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID(), partyId: crypto.randomUUID(), itemId: crypto.randomUUID(), warehouseId: crypto.randomUUID(), batchId: crypto.randomUUID() }),
  write: async (_companyId, work) => {
    const taken = participants.map((store) => store.snapshot());
    try { return await work(); } catch (error) { participants.forEach((store, i) => store.restore(taken[i])); throw error; }
  },
}));
