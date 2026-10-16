/** Issue #366 — the master-data store contract, against the in-memory classes. */
import { CommandRecordIndex, UnitRegistry, VersionedStore, createDefaultUnitRegistry } from "../src/index.ts";
import { mastersStoreContract, type Sample } from "./masters-store-contract.ts";

const stores = new Map<string, VersionedStore<Sample>>();
const registries = new Map<string, UnitRegistry>();
const commandIndex = new CommandRecordIndex();
const once = <K, V>(map: Map<K, V>, key: K, make: () => V): V => map.get(key) ?? (map.set(key, make()), map.get(key) as V);

mastersStoreContract("memory", () => ({
  store: (kind) => once(stores, kind, () => new VersionedStore<Sample>()),
  commandIndex,
  // One registry per company, as the running app keeps them (apps/api/src/company-shop.ts).
  units: (companyId) => once(registries, companyId, createDefaultUnitRegistry),
  company: async () => crypto.randomUUID(),
  user: async () => crypto.randomUUID(),
  command: async () => crypto.randomUUID(),
  write: async (_companyId, work) => work(),
}));
