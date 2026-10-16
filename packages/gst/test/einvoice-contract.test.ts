/** Issue #366 — the e-invoice store contract, against the in-memory stores. */
import { randomUUID } from "node:crypto";
import type { CompanyId } from "@invoice/kernel";
import { InMemoryEInvoicePolicies, InMemoryEInvoiceStore } from "../src/einvoice-adapters.ts";
import { eInvoiceContract } from "./einvoice-contract.ts";

const records = new InMemoryEInvoiceStore();
const policies = new InMemoryEInvoicePolicies();
eInvoiceContract("memory", () => ({
  records, policies,
  setPolicy: async (companyId, policy) => policies.set(companyId, policy),
  // What the in-memory ledger store does for its participants: put everything back if the action fails.
  run: async (_companyId, work) => {
    const taken = records.snapshot();
    try { return await work(); } catch (error) { records.restore(taken); throw error; }
  },
  company: async () => ({ companyId: randomUUID() as CompanyId, userId: randomUUID() }),
}));
