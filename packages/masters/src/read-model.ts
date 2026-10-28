// Issue #366 — the synchronous read side of master data.
//
// `MasterDataService` is asynchronous: it reads its repository (PostgreSQL in the running app). A few
// consumers sit behind synchronous ports owned by other lanes — the GST calculator's
// `MasterDataReader`, the stock module's `StockMasterData` — and cannot await. They read this model
// instead: the same rules as the service's reads (active parties, merge pointers followed, the same
// name matching), over in-memory `VersionedStore`s. In memory those are the service's own stores; on
// PostgreSQL they are a copy of what the database holds, refreshed at the start of each request
// (apps/api/src/master-view.ts). Versions are append-only, so a copy can be behind but never wrong.

import type { Version } from "./effective.ts";
import { VersionedStore, today } from "./effective.ts";
import { MasterDataError } from "./errors.ts";
import { resolveByName } from "./matching.ts";
import type { MatchableRecord, ResolveOutcome } from "./matching.ts";
import type { Id, IsoDate, Item, MasterKind, Party, PartyAddress, Transporter, Vehicle, Warehouse, BankAccount, TaxDefault } from "./types.ts";
import { snapshotFrom } from "./snapshots.ts";
import type { MasterSnapshot } from "./snapshots.ts";
import type { UnitRegistry } from "./units.ts";

/** The stores the read side needs, one per kind. */
export interface ReadStores {
  readonly parties: VersionedStore<Party>;
  readonly addresses: VersionedStore<PartyAddress>;
  readonly items: VersionedStore<Item>;
  readonly warehouses: VersionedStore<Warehouse>;
  readonly taxDefaults: VersionedStore<TaxDefault>;
  readonly transporters: VersionedStore<Transporter>;
  readonly vehicles: VersionedStore<Vehicle>;
  readonly bankAccounts: VersionedStore<BankAccount>;
  readonly byKind: (kind: MasterKind) => VersionedStore<{ readonly id: Id; readonly companyId: Id }>;
}

export const partyMatchable = (party: Party, addresses: readonly PartyAddress[]): MatchableRecord => ({
  name: party.legalName,
  aliases: [party.tradeName, ...party.aliases].filter((value): value is string => Boolean(value)),
  gstins: addresses.map((address) => address.gstin).filter((value): value is string => Boolean(value)),
  ...(party.pan === undefined ? {} : { pan: party.pan }),
  phones: party.phones,
  emails: party.emails,
  ...(party.code === undefined ? {} : { code: party.code }),
});

export const itemMatchable = (item: Item): MatchableRecord =>
  ({ name: item.name, aliases: [...item.aliases, ...item.barcodes], ...(item.code === undefined ? {} : { code: item.code }) });

export class MasterReadModel {
  readonly #stores: ReadStores;
  readonly #units: UnitRegistry | ((companyId: Id) => UnitRegistry);
  constructor(stores: ReadStores, units: UnitRegistry | ((companyId: Id) => UnitRegistry)) { this.#stores = stores; this.#units = units; }

  units(companyId: Id): UnitRegistry { return typeof this.#units === "function" ? this.#units(companyId) : this.#units; }

  parties(companyId: Id, asOf: IsoDate = today()): readonly Party[] {
    return this.#stores.parties.list(companyId, asOf).filter((party) => party.mergedIntoId === undefined);
  }

  party(companyId: Id, id: Id, asOf: IsoDate = today()): Party {
    const found = this.#stores.parties.current(companyId, id, asOf);
    if (!found) throw new MasterDataError("NOT_FOUND", "That customer or supplier was not found.");
    return found.mergedIntoId ? this.party(companyId, found.mergedIntoId, asOf) : found;
  }

  addressesOfParty(companyId: Id, partyId: Id, asOf: IsoDate = today()): readonly PartyAddress[] {
    return this.#stores.addresses.list(companyId, asOf).filter((address) => address.partyId === partyId && address.active);
  }

  resolveParty(companyId: Id, spokenName: string, asOf: IsoDate = today()): ResolveOutcome<Party> {
    const addresses = this.#stores.addresses.list(companyId, asOf).filter((address) => address.active);
    const matchables = this.parties(companyId, asOf).map((party) => ({ ...partyMatchable(party, addresses.filter((address) => address.partyId === party.id)), party }));
    const outcome = resolveByName(matchables, spokenName);
    if (outcome.status === "resolved") return { status: "resolved", record: outcome.record.party, score: outcome.score, reasons: outcome.reasons };
    if (outcome.status === "ambiguous") return { status: "ambiguous", candidates: outcome.candidates.map((candidate) => ({ record: candidate.record.party, score: candidate.score, reasons: candidate.reasons })) };
    return { status: "not_found" };
  }

  items(companyId: Id, asOf: IsoDate = today()): readonly Item[] {
    return this.#stores.items.list(companyId, asOf).filter((item) => item.mergedIntoId === undefined);
  }

  item(companyId: Id, id: Id, asOf: IsoDate = today()): Item {
    const found = this.#stores.items.current(companyId, id, asOf);
    if (!found) throw new MasterDataError("NOT_FOUND", "That item was not found.");
    return found.mergedIntoId ? this.item(companyId, found.mergedIntoId, asOf) : found;
  }

  resolveItem(companyId: Id, spokenName: string, asOf: IsoDate = today()): ResolveOutcome<Item> {
    const matchables = this.items(companyId, asOf).map((item) => ({ ...itemMatchable(item), item }));
    const outcome = resolveByName(matchables, spokenName);
    if (outcome.status === "resolved") return { status: "resolved", record: outcome.record.item, score: outcome.score, reasons: outcome.reasons };
    if (outcome.status === "ambiguous") return { status: "ambiguous", candidates: outcome.candidates.map((candidate) => ({ record: candidate.record.item, score: candidate.score, reasons: candidate.reasons })) };
    return { status: "not_found" };
  }

  warehouses(companyId: Id, asOf: IsoDate = today()): readonly Warehouse[] { return this.#stores.warehouses.list(companyId, asOf); }
  vehicles(companyId: Id, asOf: IsoDate = today()): readonly Vehicle[] { return this.#stores.vehicles.list(companyId, asOf); }
  transporters(companyId: Id, asOf: IsoDate = today()): readonly Transporter[] { return this.#stores.transporters.list(companyId, asOf); }
  bankAccounts(companyId: Id, asOf: IsoDate = today()): readonly BankAccount[] { return this.#stores.bankAccounts.list(companyId, asOf); }

  taxDefaultFor(companyId: Id, itemId: Id, asOf: IsoDate = today()): TaxDefault | null {
    const item = this.item(companyId, itemId, asOf);
    const defaults = this.#stores.taxDefaults.list(companyId, asOf);
    return defaults.find((entry) => entry.itemId === itemId) ?? defaults.find((entry) => entry.hsnSac === item.hsnSac) ?? null;
  }

  snapshot(companyId: Id, kind: MasterKind, id: Id, asOf: IsoDate = today()): MasterSnapshot {
    const version = this.#stores.byKind(kind).asOf(companyId, id, asOf);
    if (!version) throw new MasterDataError("NOT_FOUND", "That record did not exist on this date.");
    return snapshotFrom(kind, version as Version<object>);
  }

  history(companyId: Id, kind: MasterKind, id: Id): readonly Version<{ readonly id: Id; readonly companyId: Id }>[] {
    return this.#stores.byKind(kind).history(companyId, id);
  }
}
