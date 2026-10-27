/** Issue #366 — the purchase inbox store contract, against InMemoryInboxStore. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { InMemoryInboxStore } from "../src/inbox-store.ts";
import { inboxStoreContract } from "./inbox-store-contract.ts";

inboxStoreContract("memory", () => {
  const store = new InMemoryInboxStore();
  const inside = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    store,
    requiresUnitOfWork: false,
    company: async () => randomUUID(),
    // What a unit of work does on PostgreSQL: one action at a time (its company lock), a nested one
    // joins it, and a failed action is undone (snapshot and restore).
    write: (_companyId, work) => {
      if (inside.getStore()) return work();
      const run = queue.then(() => inside.run(true, async () => {
        const taken = store.snapshot();
        try { return await work(); } catch (error) { store.restore(taken); throw error; }
      }));
      queue = run.catch(() => undefined);
      return run;
    },
  };
});
