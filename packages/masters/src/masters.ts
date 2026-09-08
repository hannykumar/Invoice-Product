// The master-data service for issue #5.
//
// Everything material goes through GPT 2's PlatformCommandService, so tenant checks,
// idempotency and the audit trail are the platform's, not a second implementation.
// This module adds only what is specific to master data: validation, duplicate
// control, effective-dated versions and document snapshots.

import { createHash, randomUUID } from "node:crypto";
import { PlatformError } from "../../platform/src/types.ts";
import type { CommandRecord, RequestContext } from "../../platform/src/types.ts";
import type { AuditLog, PlatformCommandService } from "../../platform/src/platform.ts";
import { VersionedStore, today } from "./effective.ts";
import type { Version } from "./effective.ts";
import { snapshotFrom } from "./snapshots.ts";
import type { MasterSnapshot } from "./snapshots.ts";
import { checkForDuplicates, findMatches, resolveByName } from "./matching.ts";
import type { DuplicateVerdict, MatchCandidate, MatchableRecord, ResolveOutcome } from "./matching.ts";
import { UnitRegistry, createDefaultUnitRegistry } from "./units.ts";
import type { Quantity } from "./units.ts";
import * as validate from "./validation.ts";
import type { ValidationProblem } from "./validation.ts";
import type {
  BankAccount, Batch, Id, IsoDate, Item, MasterKind, OpeningStock, Paise, Party, PartyAddress,
  PriceList, PriceListEntry, SerialNumber, TaxDefault, Transporter, Vehicle, Warehouse,
} from "./types.ts";

export class MasterDataError extends Error {
  public readonly code: "VALIDATION_FAILED" | "DUPLICATE_BLOCKED" | "NOT_FOUND" | "CONFLICT";
  public readonly problems: readonly ValidationProblem[];
  public readonly candidates: readonly MatchCandidate<MatchableRecord>[];
  constructor(code: MasterDataError["code"], message: string, problems: readonly ValidationProblem[] = [], candidates: readonly MatchCandidate<MatchableRecord>[] = []) {
    super(message);
    this.code = code;
    this.problems = problems;
    this.candidates = candidates;
  }
}

export interface WriteOptions {
  /** Required. Retrying a write with the same key returns the first result. */
  readonly idempotencyKey: string;
  /** Defaults to today. Back-dating is allowed so corrections land on the right date. */
  readonly effectiveFrom?: IsoDate;
  readonly reason?: string;
  /** Set after the user has seen and accepted a "this looks similar" warning. */
  readonly acknowledgeSimilar?: boolean;
}

export interface WriteResult<T> {
  readonly record: T;
  readonly version: Version<T>;
  readonly command: CommandRecord;
  /** Non-blocking similarity or data-quality warnings the UI should show. */
  readonly warnings: readonly ValidationProblem[];
  readonly similar: readonly MatchCandidate<MatchableRecord>[];
}

/** Approval policies this module expects the platform to be configured with. */
export const MASTER_APPROVAL_POLICIES = Object.freeze([
  { action: "masters.party.merge", minimumRisk: "high" as const, requiredPermission: "approval.decide" as const },
  { action: "masters.item.merge", minimumRisk: "high" as const, requiredPermission: "approval.decide" as const },
]);

interface Stores {
  readonly parties: VersionedStore<Party>;
  readonly addresses: VersionedStore<PartyAddress>;
  readonly items: VersionedStore<Item>;
  readonly warehouses: VersionedStore<Warehouse>;
  readonly batches: VersionedStore<Batch>;
  readonly serials: VersionedStore<SerialNumber>;
  readonly openingStock: VersionedStore<OpeningStock>;
  readonly priceLists: VersionedStore<PriceList>;
  readonly priceEntries: VersionedStore<PriceListEntry>;
  readonly taxDefaults: VersionedStore<TaxDefault>;
  readonly transporters: VersionedStore<Transporter>;
  readonly vehicles: VersionedStore<Vehicle>;
  readonly bankAccounts: VersionedStore<BankAccount>;
}

const FAR_FUTURE = "9999-12-31";

/**
 * A stable digest of the input a write was asked to perform. Reusing one idempotency
 * key for two different inputs is a caller bug, and the platform rejects it by
 * comparing this value.
 */
function fingerprintOf(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (typeof input === "bigint") return `${input}n`;
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex").slice(0, 32);
}

export class MasterDataService {
  readonly #commands: PlatformCommandService;
  readonly #audit: AuditLog;
  readonly #stores: Stores;
  /** Command id to the record it wrote, so an idempotent retry can return that record. */
  readonly #recordByCommand = new Map<Id, Id>();
  public readonly units: UnitRegistry;

  constructor(commands: PlatformCommandService, audit: AuditLog, units: UnitRegistry = createDefaultUnitRegistry()) {
    this.#commands = commands;
    this.#audit = audit;
    this.units = units;
    this.#stores = {
      parties: new VersionedStore<Party>(), addresses: new VersionedStore<PartyAddress>(), items: new VersionedStore<Item>(),
      warehouses: new VersionedStore<Warehouse>(), batches: new VersionedStore<Batch>(), serials: new VersionedStore<SerialNumber>(),
      openingStock: new VersionedStore<OpeningStock>(), priceLists: new VersionedStore<PriceList>(), priceEntries: new VersionedStore<PriceListEntry>(),
      taxDefaults: new VersionedStore<TaxDefault>(), transporters: new VersionedStore<Transporter>(), vehicles: new VersionedStore<Vehicle>(),
      bankAccounts: new VersionedStore<BankAccount>(),
    };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Opens a platform command for a master change. When the same idempotency key comes
   * back, the platform returns the original command and this returns the record id it
   * wrote, so a retry never runs the duplicate checks or appends a second version.
   */
  #begin(context: RequestContext, action: string, options: WriteOptions, fingerprint: unknown, risk: "low" | "medium" | "high" = "low"): { command: CommandRecord; existingRecordId?: Id } {
    const command = this.#commands.create(context, {
      action,
      risk,
      idempotencyKey: options.idempotencyKey,
      payload: { effectiveFrom: options.effectiveFrom ?? today(), fingerprint: fingerprintOf(fingerprint) },
    });
    const existingRecordId = this.#recordByCommand.get(command.id);
    return existingRecordId === undefined ? { command } : { command, existingRecordId };
  }

  /** Moves the command to finalised and appends the new version of the record. */
  #commit<T extends { readonly id: Id; readonly companyId: Id }>(context: RequestContext, store: VersionedStore<T>, started: { command: CommandRecord }, record: T, options: WriteOptions): { version: Version<T>; command: CommandRecord } {
    // The platform's state machine is draft -> submitted -> approved -> finalised. A
    // master change carries no approval policy by default, so the approval step is a
    // no-op here; adding a policy later makes the same call require an approver.
    const submitted = this.#commands.transition(context, started.command.id, "submitted");
    const approved = this.#commands.transition(context, submitted.id, "approved");
    const finalised = this.#commands.transition(context, approved.id, "finalised", options.reason);
    const version = store.append(record, options.effectiveFrom ?? today(), context.actorId, options.reason ?? `command:${finalised.id}`);
    this.#recordByCommand.set(finalised.id, record.id);
    return { version, command: finalised };
  }

  /** The result to hand back when a write turns out to be a retry of an earlier one. */
  #retried<T extends { readonly id: Id; readonly companyId: Id }>(context: RequestContext, store: VersionedStore<T>, started: { command: CommandRecord; existingRecordId?: Id }): WriteResult<T> {
    const version = store.latest(context.companyId, started.existingRecordId as Id);
    if (!version) throw new MasterDataError("NOT_FOUND", "The earlier attempt with this reference number cannot be found.");
    return { record: version.data, version, command: started.command, warnings: [], similar: [] };
  }

  #require(result: validate.ValidationResult): void {
    if (!result.ok) throw new MasterDataError("VALIDATION_FAILED", result.problems.map((problem) => problem.message).join(" "), result.problems);
  }

  #partyMatchable(party: Party, asOf: IsoDate): MatchableRecord {
    const gstins = this.addressesOfParty(party.companyId, party.id, asOf).map((address) => address.gstin).filter((value): value is string => Boolean(value));
    return {
      name: party.legalName,
      aliases: [party.tradeName, ...party.aliases].filter((value): value is string => Boolean(value)),
      gstins,
      ...(party.pan === undefined ? {} : { pan: party.pan }),
      phones: party.phones,
      emails: party.emails,
      ...(party.code === undefined ? {} : { code: party.code }),
    };
  }

  #itemMatchable(item: Item): MatchableRecord {
    return { name: item.name, aliases: [...item.aliases, ...item.barcodes], ...(item.code === undefined ? {} : { code: item.code }) };
  }

  // ------------------------------------------------------------------ parties

  parties(context: RequestContext, asOf: IsoDate = today()): readonly Party[] {
    return this.#stores.parties.list(context.companyId, asOf).filter((party) => party.mergedIntoId === undefined);
  }

  party(context: RequestContext, id: Id, asOf: IsoDate = today()): Party {
    const found = this.#stores.parties.current(context.companyId, id, asOf);
    if (!found) throw new MasterDataError("NOT_FOUND", "That customer or supplier was not found.");
    // Follow a merge pointer so old references keep working.
    return found.mergedIntoId ? this.party(context, found.mergedIntoId, asOf) : found;
  }

  checkPartyDuplicates(context: RequestContext, subject: MatchableRecord, asOf: IsoDate = today()): DuplicateVerdict<MatchableRecord> {
    return checkForDuplicates(this.parties(context, asOf).map((party) => this.#partyMatchable(party, asOf)), subject);
  }

  createParty(context: RequestContext, input: Omit<Party, "id" | "companyId" | "active" | "aliases" | "phones" | "emails"> & { readonly id?: Id; readonly aliases?: readonly string[]; readonly phones?: readonly string[]; readonly emails?: readonly string[] }, options: WriteOptions): WriteResult<Party> {
    const started = this.#begin(context, "masters.party.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.parties, started);
    const asOf = options.effectiveFrom ?? today();
    const warnings: ValidationProblem[] = [];
    if (input.pan) this.#require(validate.validatePan(input.pan));
    const phones = (input.phones ?? []).map((phone) => {
      const normalised = validate.normalisePhone(phone);
      if (!normalised) throw new MasterDataError("VALIDATION_FAILED", `${phone} is not a valid Indian mobile number.`, [{ field: "phones", code: "PHONE_SHAPE", message: `${phone} is not a valid Indian mobile number.` }]);
      return normalised;
    });
    if (input.legalName.trim().length < 2) throw new MasterDataError("VALIDATION_FAILED", "Please enter the business name.", [{ field: "legalName", code: "NAME_REQUIRED", message: "Please enter the business name." }]);

    const party: Party = {
      ...input,
      id: input.id ?? randomUUID(),
      companyId: context.companyId,
      aliases: input.aliases ?? [],
      phones,
      emails: (input.emails ?? []).map((email) => email.trim().toLowerCase()),
      active: true,
    };
    const verdict = this.checkPartyDuplicates(context, this.#partyMatchable(party, asOf), asOf);
    if (verdict.decision === "block") {
      throw new MasterDataError("DUPLICATE_BLOCKED", `This looks like an existing record: ${verdict.candidates.map((candidate) => candidate.reasons[0]?.detail).join(" ")}`, [], verdict.candidates);
    }
    if (verdict.decision === "warn") {
      if (!options.acknowledgeSimilar) throw new MasterDataError("DUPLICATE_BLOCKED", `A similar name already exists. Confirm it is a different business to continue: ${verdict.candidates.map((candidate) => candidate.record.name).join(", ")}`, [], verdict.candidates);
      warnings.push({ field: "legalName", code: "SIMILAR_NAME_ACKNOWLEDGED", message: `Created even though it is similar to ${verdict.candidates.map((candidate) => candidate.record.name).join(", ")}.` });
    }
    const { version, command } = this.#commit(context, this.#stores.parties, started, party, options);
    return { record: version.data, version, command, warnings, similar: verdict.decision === "clear" ? [] : verdict.candidates };
  }

  updateParty(context: RequestContext, id: Id, changes: Partial<Omit<Party, "id" | "companyId">>, options: WriteOptions): WriteResult<Party> {
    const started = this.#begin(context, "masters.party.update", options, { id, changes });
    if (started.existingRecordId) return this.#retried(context, this.#stores.parties, started);
    const asOf = options.effectiveFrom ?? today();
    const current = this.party(context, id, asOf);
    if (changes.pan) this.#require(validate.validatePan(changes.pan));
    const updated: Party = { ...current, ...changes, id: current.id, companyId: current.companyId };
    const { version, command } = this.#commit(context, this.#stores.parties, started, updated, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  /**
   * Voice and OCR entry point. Returns `ambiguous` rather than picking a winner when
   * two parties are similarly close — the product must ask, not guess.
   */
  resolveParty(context: RequestContext, spokenName: string, asOf: IsoDate = today()): ResolveOutcome<Party> {
    const parties = this.parties(context, asOf);
    const matchables = parties.map((party) => ({ ...this.#partyMatchable(party, asOf), party }));
    const outcome = resolveByName(matchables, spokenName);
    if (outcome.status === "resolved") return { status: "resolved", record: outcome.record.party, score: outcome.score, reasons: outcome.reasons };
    if (outcome.status === "ambiguous") return { status: "ambiguous", candidates: outcome.candidates.map((candidate) => ({ record: candidate.record.party, score: candidate.score, reasons: candidate.reasons })) };
    return { status: "not_found" };
  }

  /**
   * Merges two parties. High risk, so the platform requires an approver, and the
   * losing record is kept as a redirect: historical documents keep their snapshots and
   * their original party id still resolves.
   */
  mergeParties(context: RequestContext, winnerId: Id, loserId: Id, options: WriteOptions): { winner: Party; loser: Party; command: CommandRecord } {
    if (winnerId === loserId) throw new MasterDataError("CONFLICT", "A record cannot be merged into itself.");
    const asOf = options.effectiveFrom ?? today();
    const winner = this.party(context, winnerId, asOf);
    const loser = this.party(context, loserId, asOf);
    const command = this.#commands.create(context, { action: "masters.party.merge", risk: "high", idempotencyKey: options.idempotencyKey, payload: { winnerId, loserId } });
    const submitted = this.#commands.transition(context, command.id, "submitted");
    const approved = this.#commands.transition(context, submitted.id, "approved", options.reason);
    const finalised = this.#commands.transition(context, approved.id, "finalised", options.reason);
    const mergedLoser: Party = { ...loser, active: false, mergedIntoId: winner.id };
    const enrichedWinner: Party = {
      ...winner,
      aliases: [...new Set([...winner.aliases, loser.legalName, ...(loser.tradeName ? [loser.tradeName] : []), ...loser.aliases])],
      phones: [...new Set([...winner.phones, ...loser.phones])],
      emails: [...new Set([...winner.emails, ...loser.emails])],
    };
    this.#stores.parties.append(mergedLoser, asOf, context.actorId, `merged into ${winner.id}`);
    this.#stores.parties.append(enrichedWinner, asOf, context.actorId, `absorbed ${loser.id}`);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "masters.party.merged", correlationId: finalised.id, before: { loser: loser.legalName, winner: winner.legalName }, after: { survivingId: winner.id } });
    return { winner: enrichedWinner, loser: mergedLoser, command: finalised };
  }

  // ---------------------------------------------------------------- addresses

  addressesOfParty(companyId: Id, partyId: Id, asOf: IsoDate = today()): readonly PartyAddress[] {
    return this.#stores.addresses.list(companyId, asOf).filter((address) => address.partyId === partyId && address.active);
  }

  addAddress(context: RequestContext, input: Omit<PartyAddress, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<PartyAddress> {
    const started = this.#begin(context, "masters.address.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.addresses, started);
    const warnings: ValidationProblem[] = [];
    this.#require(validate.validatePincode(input.pincode));
    if (!validate.GST_STATE_CODES[input.stateCode]) throw new MasterDataError("VALIDATION_FAILED", `${input.stateCode} is not a valid GST state code.`, [{ field: "stateCode", code: "GSTIN_STATE_CODE", message: `${input.stateCode} is not a valid GST state code.` }]);
    if (input.gstin) {
      this.#require(validate.validateGstin(input.gstin));
      const gstinState = validate.gstinStateCode(input.gstin);
      if (gstinState !== input.stateCode) {
        throw new MasterDataError("VALIDATION_FAILED", `This GST number belongs to ${validate.GST_STATE_CODES[gstinState]?.name ?? "another state"} but the address is in ${validate.GST_STATE_CODES[input.stateCode]?.name}. Please check which one is wrong.`, [{ field: "gstin", code: "GSTIN_STATE_MISMATCH", message: "The GST number and the address are in different states." }]);
      }
      const gstin = validate.normaliseIdentifier(input.gstin);
      const heldBy = this.#stores.addresses.list(context.companyId, options.effectiveFrom ?? today()).find((address) => address.gstin && validate.normaliseIdentifier(address.gstin) === gstin && address.partyId !== input.partyId && address.active);
      if (heldBy) {
        const owner = this.party(context, heldBy.partyId);
        throw new MasterDataError("DUPLICATE_BLOCKED", `GST number ${gstin} is already saved for ${owner.legalName}. If this is the same business, merge the two records instead of creating a second one.`, [{ field: "gstin", code: "GSTIN_ALREADY_USED", message: `GST number ${gstin} is already saved for ${owner.legalName}.` }]);
      }
      if (validate.isRetiredStateCode(gstinState)) warnings.push({ field: "gstin", code: "GSTIN_STATE_RETIRED", message: "This GST number uses a state code that is no longer issued. It is fine for old invoices, but please confirm it for new ones." });
      const party = this.party(context, input.partyId);
      if (party.pan && validate.gstinPan(input.gstin) !== party.pan.toUpperCase()) {
        throw new MasterDataError("VALIDATION_FAILED", "The PAN inside this GST number does not match the PAN saved for this business.", [{ field: "gstin", code: "GSTIN_PAN_MISMATCH", message: "The PAN inside this GST number does not match the PAN saved for this business." }]);
      }
    }
    const address: PartyAddress = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.addresses, started, address, options);
    return { record: version.data, version, command, warnings, similar: [] };
  }

  // -------------------------------------------------------------------- items

  items(context: RequestContext, asOf: IsoDate = today()): readonly Item[] {
    return this.#stores.items.list(context.companyId, asOf).filter((item) => item.mergedIntoId === undefined);
  }

  item(context: RequestContext, id: Id, asOf: IsoDate = today()): Item {
    const found = this.#stores.items.current(context.companyId, id, asOf);
    if (!found) throw new MasterDataError("NOT_FOUND", "That item was not found.");
    return found.mergedIntoId ? this.item(context, found.mergedIntoId, asOf) : found;
  }

  createItem(context: RequestContext, input: Omit<Item, "id" | "companyId" | "active" | "aliases" | "barcodes"> & { readonly id?: Id; readonly aliases?: readonly string[]; readonly barcodes?: readonly string[] }, options: WriteOptions): WriteResult<Item> {
    const started = this.#begin(context, "masters.item.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.items, started);
    this.#require(validate.validateHsnOrSac(input.hsnSac, input.kind));
    this.units.unit(input.baseUnit);
    const item: Item = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId, aliases: input.aliases ?? [], barcodes: input.barcodes ?? [], active: true };
    const verdict = checkForDuplicates(this.items(context, options.effectiveFrom ?? today()).map((existing) => this.#itemMatchable(existing)), this.#itemMatchable(item));
    if (verdict.decision === "block") throw new MasterDataError("DUPLICATE_BLOCKED", `This item already exists: ${verdict.candidates.map((candidate) => candidate.record.name).join(", ")}`, [], verdict.candidates);
    if (verdict.decision === "warn" && !options.acknowledgeSimilar) throw new MasterDataError("DUPLICATE_BLOCKED", `A similar item already exists. Confirm it is different to continue: ${verdict.candidates.map((candidate) => candidate.record.name).join(", ")}`, [], verdict.candidates);
    const { version, command } = this.#commit(context, this.#stores.items, started, item, options);
    return { record: version.data, version, command, warnings: [], similar: verdict.decision === "clear" ? [] : verdict.candidates };
  }

  updateItem(context: RequestContext, id: Id, changes: Partial<Omit<Item, "id" | "companyId">>, options: WriteOptions): WriteResult<Item> {
    const started = this.#begin(context, "masters.item.update", options, { id, changes });
    if (started.existingRecordId) return this.#retried(context, this.#stores.items, started);
    const current = this.item(context, id, options.effectiveFrom ?? today());
    if (changes.hsnSac) this.#require(validate.validateHsnOrSac(changes.hsnSac, changes.kind ?? current.kind));
    const updated: Item = { ...current, ...changes, id: current.id, companyId: current.companyId };
    const { version, command } = this.#commit(context, this.#stores.items, started, updated, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  resolveItem(context: RequestContext, spokenName: string, asOf: IsoDate = today()): ResolveOutcome<Item> {
    const matchables = this.items(context, asOf).map((item) => ({ ...this.#itemMatchable(item), item }));
    const outcome = resolveByName(matchables, spokenName);
    if (outcome.status === "resolved") return { status: "resolved", record: outcome.record.item, score: outcome.score, reasons: outcome.reasons };
    if (outcome.status === "ambiguous") return { status: "ambiguous", candidates: outcome.candidates.map((candidate) => ({ record: candidate.record.item, score: candidate.score, reasons: candidate.reasons })) };
    return { status: "not_found" };
  }

  /** Item-specific pack sizes, e.g. one box of this soap is 24 pieces. */
  registerItemConversion(context: RequestContext, itemId: Id, fromUnit: string, toUnit: string, numerator: bigint, denominator = 1n): void {
    this.item(context, itemId);
    this.units.registerConversion({ fromUnit, toUnit, numerator, denominator, itemId });
  }

  // ------------------------------------------------- warehouses, batches, serials

  createWarehouse(context: RequestContext, input: Omit<Warehouse, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<Warehouse> {
    const started = this.#begin(context, "masters.warehouse.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.warehouses, started);
    this.#require(validate.validatePincode(input.pincode));
    if (input.gstin) this.#require(validate.validateGstin(input.gstin));
    const warehouse: Warehouse = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.warehouses, started, warehouse, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  warehouses(context: RequestContext, asOf: IsoDate = today()): readonly Warehouse[] {
    return this.#stores.warehouses.list(context.companyId, asOf);
  }

  createBatch(context: RequestContext, input: Omit<Batch, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<Batch> {
    const started = this.#begin(context, "masters.batch.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.batches, started);
    const item = this.item(context, input.itemId);
    if (!item.trackBatches) throw new MasterDataError("CONFLICT", `${item.name} is not set up to track batches.`);
    if (input.expiresOn && input.manufacturedOn && input.expiresOn < input.manufacturedOn) throw new MasterDataError("VALIDATION_FAILED", "The expiry date is before the manufacturing date.");
    const batch: Batch = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.batches, started, batch, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  createSerial(context: RequestContext, input: Omit<SerialNumber, "id" | "companyId" | "status"> & { readonly id?: Id }, options: WriteOptions): WriteResult<SerialNumber> {
    const started = this.#begin(context, "masters.serial.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.serials, started);
    const item = this.item(context, input.itemId);
    if (!item.trackSerials) throw new MasterDataError("CONFLICT", `${item.name} is not set up to track serial numbers.`);
    const duplicate = this.#stores.serials.list(context.companyId, FAR_FUTURE).find((existing) => existing.itemId === input.itemId && existing.serial === input.serial);
    if (duplicate) throw new MasterDataError("DUPLICATE_BLOCKED", `Serial number ${input.serial} is already recorded for this item.`);
    const serial: SerialNumber = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId, status: "in_stock" };
    const { version, command } = this.#commit(context, this.#stores.serials, started, serial, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  /** Opening stock seeds a balance without pretending a purchase happened. */
  setOpeningStock(context: RequestContext, input: Omit<OpeningStock, "id" | "companyId"> & { readonly id?: Id }, options: WriteOptions): WriteResult<OpeningStock> {
    const started = this.#begin(context, "masters.opening_stock.set", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.openingStock, started);
    const item = this.item(context, input.itemId);
    if (input.quantity.scaled < 0n) throw new MasterDataError("VALIDATION_FAILED", "Opening stock cannot be negative.");
    // Stored in the item's base unit so every later movement compares like with like.
    const inBaseUnit = this.units.convertExact(input.quantity, item.baseUnit, item.id);
    const opening: OpeningStock = { ...input, quantity: inBaseUnit, id: input.id ?? randomUUID(), companyId: context.companyId };
    const { version, command } = this.#commit(context, this.#stores.openingStock, started, opening, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  // --------------------------------------------------- prices and tax defaults

  createPriceList(context: RequestContext, input: Omit<PriceList, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<PriceList> {
    const started = this.#begin(context, "masters.price_list.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.priceLists, started);
    const priceList: PriceList = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.priceLists, started, priceList, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  setPrice(context: RequestContext, input: Omit<PriceListEntry, "id" | "companyId"> & { readonly id?: Id }, options: WriteOptions): WriteResult<PriceListEntry> {
    const started = this.#begin(context, "masters.price.set", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.priceEntries, started);
    if (input.ratePaise < 0n) throw new MasterDataError("VALIDATION_FAILED", "A price cannot be negative.");
    this.units.unit(input.unit);
    const entry: PriceListEntry = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId };
    const { version, command } = this.#commit(context, this.#stores.priceEntries, started, entry, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  /**
   * The rate for an item on a date, in the requested unit. Slab prices pick the
   * highest minimum quantity that the order still satisfies. Returns null rather than
   * inventing a price when the item is not on the list.
   */
  priceFor(context: RequestContext, priceListId: Id, itemId: Id, unit: string, orderQuantity: Quantity, asOf: IsoDate = today()): { ratePaise: Paise; unit: string; entryId: Id } | null {
    const entries = this.#stores.priceEntries.list(context.companyId, asOf).filter((entry) => entry.priceListId === priceListId && entry.itemId === itemId);
    const applicable = entries.filter((entry) => {
      if (!entry.minimumQuantity) return true;
      const threshold = this.units.convert(entry.minimumQuantity, orderQuantity.unit, itemId);
      return orderQuantity.scaled >= threshold.quantity.scaled;
    });
    if (applicable.length === 0) return null;
    const best = applicable.reduce((winner, candidate) => {
      const winnerMinimum = winner.minimumQuantity ? this.units.convert(winner.minimumQuantity, orderQuantity.unit, itemId).quantity.scaled : 0n;
      const candidateMinimum = candidate.minimumQuantity ? this.units.convert(candidate.minimumQuantity, orderQuantity.unit, itemId).quantity.scaled : 0n;
      return candidateMinimum > winnerMinimum ? candidate : winner;
    });
    const converted = this.units.factor(best.unit, unit, itemId);
    if (!converted) return null;
    // Rate per requested unit = rate per priced unit divided by units per priced unit.
    const ratePaise = (best.ratePaise * converted.denominator) / converted.numerator;
    return { ratePaise, unit: unit.toUpperCase(), entryId: best.id };
  }

  setTaxDefault(context: RequestContext, input: Omit<TaxDefault, "id" | "companyId"> & { readonly id?: Id }, options: WriteOptions): WriteResult<TaxDefault> {
    const started = this.#begin(context, "masters.tax_default.set", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.taxDefaults, started);
    if ((input.itemId === undefined) === (input.hsnSac === undefined)) throw new MasterDataError("VALIDATION_FAILED", "A tax default applies either to one item or to an HSN code, not both and not neither.");
    if (input.gstRateBasisPoints < 0 || input.gstRateBasisPoints > 10000) throw new MasterDataError("VALIDATION_FAILED", "A GST rate must be between 0 and 100 percent.");
    if (!input.source.trim()) throw new MasterDataError("VALIDATION_FAILED", "Record where this rate comes from so it can be explained later.");
    const taxDefault: TaxDefault = { ...input, id: input.id ?? randomUUID(), companyId: context.companyId };
    const { version, command } = this.#commit(context, this.#stores.taxDefaults, started, taxDefault, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  /**
   * The GST default for an item on a date: an item-level default wins over an HSN-level
   * one. Returns null when nothing is configured, so callers ask instead of assuming 18%.
   */
  taxDefaultFor(context: RequestContext, itemId: Id, asOf: IsoDate = today()): TaxDefault | null {
    const item = this.item(context, itemId, asOf);
    const defaults = this.#stores.taxDefaults.list(context.companyId, asOf);
    return defaults.find((entry) => entry.itemId === itemId) ?? defaults.find((entry) => entry.hsnSac === item.hsnSac) ?? null;
  }

  /**
   * Every default that could apply, rather than the first one that does.
   *
   * `taxDefaultFor` answers "what rate should this line use", and to answer it has to pick one.
   * Issue #59 asks a different question — "what does the register actually hold about this?" — and
   * there the difference between one answer and three matters enormously: three entries claiming
   * different rates for one HSN is a register somebody has to fix, not a rate to quietly apply. So
   * this returns them all, item-level first, and leaves the choosing to the caller.
   *
   * Neither the item nor the code has to exist. A line whose item is not in the master list is the
   * ordinary case when a supplier's bill has only just been photographed.
   */
  taxDefaultCandidates(
    context: RequestContext,
    lookup: { readonly itemId?: Id; readonly hsnSac?: string },
    asOf: IsoDate = today(),
  ): readonly Version<TaxDefault>[] {
    const defaults = this.#stores.taxDefaults.list(context.companyId, asOf);
    const code = lookup.hsnSac?.trim();
    const matching = [
      ...(lookup.itemId === undefined ? [] : defaults.filter((entry) => entry.itemId === lookup.itemId)),
      ...(code === undefined || code === "" ? [] : defaults.filter((entry) => entry.hsnSac === code)),
    ];
    // The version, not just the row: the effective date is half of what makes a rate defensible,
    // and it lives on the version rather than on the record.
    return matching
      .map((entry) => this.#stores.taxDefaults.asOf(context.companyId, entry.id, asOf))
      .filter((version): version is Version<TaxDefault> => version !== null);
  }

  // ------------------------------------------------ logistics and bank accounts

  createTransporter(context: RequestContext, input: Omit<Transporter, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<Transporter> {
    const started = this.#begin(context, "masters.transporter.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.transporters, started);
    const identifier = validate.normaliseIdentifier(input.transporterId);
    if (identifier.length !== 15) throw new MasterDataError("VALIDATION_FAILED", "A transporter ID or GST number has 15 characters.");
    const transporter: Transporter = { ...input, transporterId: identifier, id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.transporters, started, transporter, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  createVehicle(context: RequestContext, input: Omit<Vehicle, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<Vehicle> {
    const started = this.#begin(context, "masters.vehicle.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.vehicles, started);
    this.#require(validate.validateVehicleNumber(input.registrationNumber));
    const registrationNumber = validate.normaliseIdentifier(input.registrationNumber);
    const duplicate = this.#stores.vehicles.list(context.companyId, FAR_FUTURE).find((existing) => existing.registrationNumber === registrationNumber);
    if (duplicate) throw new MasterDataError("DUPLICATE_BLOCKED", `Vehicle ${registrationNumber} is already saved.`);
    const vehicle: Vehicle = { ...input, registrationNumber, id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.vehicles, started, vehicle, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  vehicles(context: RequestContext, asOf: IsoDate = today()): readonly Vehicle[] {
    return this.#stores.vehicles.list(context.companyId, asOf);
  }

  transporters(context: RequestContext, asOf: IsoDate = today()): readonly Transporter[] {
    return this.#stores.transporters.list(context.companyId, asOf);
  }

  createBankAccount(context: RequestContext, input: Omit<BankAccount, "id" | "companyId" | "active"> & { readonly id?: Id }, options: WriteOptions): WriteResult<BankAccount> {
    const started = this.#begin(context, "masters.bank_account.create", options, input);
    if (started.existingRecordId) return this.#retried(context, this.#stores.bankAccounts, started);
    this.#require(validate.combine(validate.validateIfsc(input.ifsc), validate.validateBankAccountNumber(input.accountNumber)));
    if (input.ownerType === "party" && !input.partyId) throw new MasterDataError("VALIDATION_FAILED", "Say which supplier or customer this bank account belongs to.");
    const account: BankAccount = { ...input, ifsc: validate.normaliseIdentifier(input.ifsc), accountNumber: input.accountNumber.replace(/\s/g, ""), id: input.id ?? randomUUID(), companyId: context.companyId, active: true };
    const { version, command } = this.#commit(context, this.#stores.bankAccounts, started, account, options);
    return { record: version.data, version, command, warnings: [], similar: [] };
  }

  bankAccounts(context: RequestContext, asOf: IsoDate = today()): readonly BankAccount[] {
    return this.#stores.bankAccounts.list(context.companyId, asOf);
  }

  // --------------------------------------------------------------- snapshots

  /**
   * The facts a transaction should copy. Callers pass the document date so the
   * snapshot reflects the master as it stood then, not as it stands now.
   */
  snapshot(context: RequestContext, kind: MasterKind, id: Id, asOf: IsoDate = today()): MasterSnapshot {
    const store = this.#storeFor(kind);
    const version = store.asOf(context.companyId, id, asOf);
    if (!version) throw new MasterDataError("NOT_FOUND", "That record did not exist on this date.");
    return snapshotFrom(kind, version as Version<object>);
  }

  #storeFor(kind: MasterKind): VersionedStore<{ readonly id: Id; readonly companyId: Id }> {
    const map: Record<MasterKind, VersionedStore<never>> = {
      party: this.#stores.parties as never, party_address: this.#stores.addresses as never, item: this.#stores.items as never,
      warehouse: this.#stores.warehouses as never, batch: this.#stores.batches as never, serial: this.#stores.serials as never,
      price_list: this.#stores.priceLists as never, tax_default: this.#stores.taxDefaults as never,
      transporter: this.#stores.transporters as never, vehicle: this.#stores.vehicles as never, bank_account: this.#stores.bankAccounts as never,
    };
    return map[kind] as unknown as VersionedStore<{ readonly id: Id; readonly companyId: Id }>;
  }

  /** Full change history for one record, for the "who changed this" screen. */
  history(context: RequestContext, kind: MasterKind, id: Id): readonly Version<{ readonly id: Id; readonly companyId: Id }>[] {
    return this.#storeFor(kind).history(context.companyId, id);
  }

  /** Named export for tests and screens that need the raw duplicate scores. */
  similarParties(context: RequestContext, subject: MatchableRecord, asOf: IsoDate = today()): readonly MatchCandidate<MatchableRecord>[] {
    return findMatches(this.parties(context, asOf).map((party) => this.#partyMatchable(party, asOf)), subject);
  }
}

export { PlatformError };
