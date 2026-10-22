/** Issue #366 — the transport contract suite on the in-memory stores the running app uses today. */
import type { CompanyId } from "@invoice/kernel";
import { InMemoryLedgerStore } from "@invoice/ledger";
import { InMemoryConsolidatedTripStore, InMemoryEwayBillPolicies, InMemoryEwayBillStore } from "../src/adapters.ts";
import { InMemorySuitabilityStore, InMemoryVehicleSuitabilityPolicies } from "../src/suitability-adapters.ts";
import { InMemoryVehicleRecordCache, InMemoryVehicleRecordConsents, InMemoryVehicleRecordFreshness } from "../src/vehicle-record-adapters.ts";
import { transportContract, type TransportHarness } from "./transport-contract.ts";

transportContract("memory", (): TransportHarness => {
  const bills = new InMemoryEwayBillStore();
  const trips = new InMemoryConsolidatedTripStore();
  const checks = new InMemorySuitabilityStore();
  // The app joins these three to the ledger store's transaction (apps/api/src/company-shop.ts).
  const store = new InMemoryLedgerStore().join(bills).join(trips).join(checks);
  const eway = new InMemoryEwayBillPolicies();
  const suitability = new InMemoryVehicleSuitabilityPolicies();
  const freshness = new InMemoryVehicleRecordFreshness();
  return {
    bills, trips, checks, readings: new InMemoryVehicleRecordCache(), consents: new InMemoryVehicleRecordConsents(),
    ewayPolicies: { policyFor: (companyId, on) => eway.policyFor(companyId, on), set: async (companyId, policy) => eway.set(companyId, policy) },
    suitabilityPolicies: { policyFor: (companyId, on) => suitability.policyFor(companyId, on), set: async (companyId, policy) => suitability.set(companyId, policy) },
    freshness: { policyFor: (companyId, on) => freshness.policyFor(companyId, on), set: async (companyId, policy) => freshness.set(companyId, policy) },
    company: async () => ({ companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID() }),
    write: (companyId, work) => store.transaction(companyId, () => work()),
  };
});
