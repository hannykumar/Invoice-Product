/** Issue #366 — the notification store contract on the in-memory store the running app uses today. */
import { randomUUID } from "node:crypto";
import { InMemoryNotificationStore } from "../src/notifications.ts";
import { notificationStoreContract } from "./notification-store-contract.ts";

notificationStoreContract("memory", () => ({
  store: new InMemoryNotificationStore(),
  company: async () => randomUUID(),
  write: (_companyId, work) => work(),
}));
