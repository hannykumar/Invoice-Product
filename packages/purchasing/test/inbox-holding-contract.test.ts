/** Issue #488 — the purchase inbox holding contract, against InMemoryInboxHolding. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { InMemoryInboxHolding } from "../src/inbox-holding.ts";
import { InMemoryInboxStore } from "../src/inbox-store.ts";
import { inboxHoldingContract } from "./inbox-holding-contract.ts";

inboxHoldingContract("memory", () => {
  const holding = new InMemoryInboxHolding();
  const store = new InMemoryInboxStore();
  const inside = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    holding: () => holding,
    store: () => store,
    transactional: false,
    company: async () => randomUUID(),
    // What a unit of work does on PostgreSQL: one action at a time, and a nested one joins it.
    write: (_companyId, work) => {
      if (inside.getStore()) return work();
      const run = queue.then(() => inside.run(true, work));
      queue = run.catch(() => undefined);
      return run;
    },
  };
});
