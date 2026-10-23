/** Issue #289, part 2b — the reverse-charge register contract against the in-memory store. */
import type { CompanyId } from "@invoice/kernel";
import { InMemoryReverseChargeRegister } from "../src/reverse-charge-register.ts";
import { reverseChargeRegisterContract, type RegisterHarness } from "./reverse-charge-register-contract.ts";

reverseChargeRegisterContract("memory", (): RegisterHarness => {
  const register = new InMemoryReverseChargeRegister();
  return {
    register,
    scene: async () => ({ companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID(), partyId: crypto.randomUUID() }),
    bill: async () => crypto.randomUUID(),
    // Memory rolls back with the ledger store it joins; here a failed write leaves nothing because
    // every refusal is raised before anything is pushed.
    write: (_companyId, work) => work(),
  };
});
