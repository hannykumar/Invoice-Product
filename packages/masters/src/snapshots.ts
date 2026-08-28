// Document fact snapshots.
//
// When a transaction references a master record it copies the facts it depends on.
// Later master edits change the master, never the document. This is what the issue #5
// acceptance criterion "changes preserve historical document facts" means in practice,
// and it is also what makes a GST return reproducible months after filing.

import type { Id, IsoDate, MasterKind } from "./types.ts";
import type { Version } from "./effective.ts";

export interface MasterSnapshot {
  readonly kind: MasterKind;
  readonly masterId: Id;
  /** The version of the master that was in force when the document was raised. */
  readonly version: number;
  readonly effectiveFrom: IsoDate;
  readonly capturedAt: string;
  /** The copied facts. Frozen, so a document can never be edited through its snapshot. */
  readonly facts: Readonly<Record<string, unknown>>;
}

/** The fields each master kind contributes to a document. Kept small on purpose. */
const SNAPSHOT_FIELDS: Readonly<Record<MasterKind, readonly string[]>> = Object.freeze({
  party: ["legalName", "tradeName", "role", "gstRegistrationType", "pan", "creditDays", "creditLimitPaise"],
  party_address: ["label", "line1", "line2", "city", "district", "stateCode", "pincode", "gstin", "use"],
  item: ["code", "name", "kind", "hsnSac", "baseUnit", "trackBatches", "trackSerials"],
  warehouse: ["code", "name", "addressLine", "city", "stateCode", "pincode", "gstin"],
  batch: ["batchNumber", "manufacturedOn", "expiresOn", "mrpPaise"],
  serial: ["serial", "status"],
  price_list: ["name", "ratesIncludeTax"],
  tax_default: ["gstRateBasisPoints", "cessRateBasisPoints", "cessPerUnitPaise", "reverseCharge", "source"],
  transporter: ["name", "transporterId", "phone"],
  vehicle: ["registrationNumber", "vehicleType", "bodyType", "ratedCapacityKg"],
  bank_account: ["accountName", "accountNumber", "ifsc", "bankName", "branchName", "accountType"],
});

export function snapshotFrom<T extends object>(kind: MasterKind, version: Version<T>, clock: () => Date = () => new Date()): MasterSnapshot {
  const source = version.data as Record<string, unknown>;
  const facts: Record<string, unknown> = {};
  for (const field of SNAPSHOT_FIELDS[kind]) {
    const value = source[field];
    if (value !== undefined) facts[field] = value;
  }
  return Object.freeze({
    kind,
    masterId: version.recordId,
    version: version.version,
    effectiveFrom: version.effectiveFrom,
    capturedAt: clock().toISOString(),
    facts: Object.freeze(facts),
  });
}

/** Human-readable difference between a snapshot and the master as it stands today. */
export function snapshotDrift(snapshot: MasterSnapshot, currentFacts: Readonly<Record<string, unknown>>): readonly { field: string; documentValue: unknown; currentValue: unknown }[] {
  const drift: { field: string; documentValue: unknown; currentValue: unknown }[] = [];
  for (const field of SNAPSHOT_FIELDS[snapshot.kind]) {
    const documentValue = snapshot.facts[field];
    const currentValue = currentFacts[field];
    if (JSON.stringify(documentValue ?? null) !== JSON.stringify(currentValue ?? null)) drift.push({ field, documentValue, currentValue });
  }
  return drift;
}
