// Issue #29 [E29] — turning one provider's answer into the facts the suitability rules understand.
//
// This file is pure: strings in, normalised facts out, no clock, no network, no storage. That is
// what makes the provider replaceable. Everything that differs between API Setu, an NTR-style
// service and whatever a business is allowed to use in three years' time is a mapping table here,
// so swapping the provider is a new adapter and a new table, never a change to the rules that
// decide whether a lorry may carry a load.
//
// Two things it refuses to do:
//
//   * **It never invents a class.** A description the mapping does not recognise comes out as
//     "we do not know what this vehicle is", not as `OTHER`-means-fine and not as a guess from the
//     body type. The suitability rules already know how to say "cannot decide"; giving them a made
//     up class would turn that into a false "no problem found".
//   * **It never keeps a field nobody asked for.** The allow-list in `vehicle-record-types.ts` is
//     applied here, at the boundary, before anything reaches storage.

import { normaliseVehicleNumber } from "./validity.ts";
import { maskOwnerName, PERMITTED_VEHICLE_FIELDS } from "./vehicle-record-types.ts";
import type { PermitType, VehicleClass, VehicleEvidence } from "./suitability-types.ts";
import type { VehicleBodyType } from "../../masters/src/types.ts";
import type { IsoDate } from "../../masters/src/types.ts";
import type {
  PermittedVehicleField, ProviderBodyTypeMap, ProviderPermitMap, ProviderVehicleClassMap,
  VehicleRecordFreshness, VehicleRecordFreshnessPolicy,
} from "./vehicle-record-types.ts";

/**
 * The registering authority's own class descriptions, as they come back from VAHAN.
 *
 * These are the strings that actually appear on Indian registration records, not tidy codes. The
 * same vehicle is "M-CYCLE/SCOOTER" in one state's data and "MOTOR CYCLE" in another's, so both
 * are here. Anything not in this table is left unknown on purpose.
 */
export const VAHAN_CLASS_DESCRIPTIONS: ProviderVehicleClassMap = Object.freeze({
  "M-CYCLE/SCOOTER": "TWO_WHEELER",
  "MOTOR CYCLE": "TWO_WHEELER",
  "MOTOR CYCLE/SCOOTER": "TWO_WHEELER",
  "TWO WHEELER": "TWO_WHEELER",
  "MOPED": "TWO_WHEELER",
  "THREE WHEELER (PASSENGER)": "THREE_WHEELER_PASSENGER",
  "THREE WHEELER (T)": "THREE_WHEELER_PASSENGER",
  "AUTO RICKSHAW": "THREE_WHEELER_PASSENGER",
  "THREE WHEELER (GOODS)": "THREE_WHEELER_GOODS",
  "THREE WHEELER (G)": "THREE_WHEELER_GOODS",
  "GOODS AUTO": "THREE_WHEELER_GOODS",
  "MOTOR CAR": "MOTOR_CAR",
  "LMV-CAR": "MOTOR_CAR",
  "OMNI BUS": "BUS",
  "BUS": "BUS",
  "STAGE CARRIAGE": "BUS",
  "LIGHT GOODS VEHICLE": "LIGHT_GOODS_VEHICLE",
  "LGV": "LIGHT_GOODS_VEHICLE",
  "LMV-GOODS": "LIGHT_GOODS_VEHICLE",
  "MEDIUM GOODS VEHICLE": "MEDIUM_GOODS_VEHICLE",
  "MGV": "MEDIUM_GOODS_VEHICLE",
  "HEAVY GOODS VEHICLE": "HEAVY_GOODS_VEHICLE",
  "HGV": "HEAVY_GOODS_VEHICLE",
  "HEAVY MOTOR VEHICLE": "HEAVY_GOODS_VEHICLE",
  "TRAILER": "TRAILER",
  "ARTICULATED VEHICLE": "TRAILER",
  "TRACTOR": "TRACTOR",
  "AGRICULTURAL TRACTOR": "TRACTOR",
});

/**
 * A goods vehicle whose record says only "goods carrier", sorted by its registered gross weight.
 *
 * This is the Motor Vehicles Act's own division and it is arithmetic, not judgement: up to 7,500 kg
 * is light, up to 12,000 kg is medium, above that is heavy. It is used only when the description
 * says the vehicle carries goods but not what size it is, and the basis is recorded so a person can
 * see that the class was worked out from the weight rather than read off the record.
 */
export const GOODS_ONLY_DESCRIPTIONS: readonly string[] = Object.freeze([
  "GOODS CARRIER", "GOODS VEHICLE", "TRUCK", "DELIVERY VAN", "MAXI CAB (GOODS)",
]);

export const VAHAN_BODY_DESCRIPTIONS: ProviderBodyTypeMap = Object.freeze({
  "OPEN BODY": "open",
  "OPEN": "open",
  "CLOSED BODY": "closed",
  "CLOSED": "closed",
  "CONTAINER": "container",
  "TANKER": "tanker",
  "TRAILER": "trailer",
  "REFRIGERATED": "refrigerated",
  "REEFER": "refrigerated",
  "SOLO": "two_wheeler",
  "SADDLE": "two_wheeler",
  "THREE WHEELER": "three_wheeler",
});

export const VAHAN_PERMIT_DESCRIPTIONS: ProviderPermitMap = Object.freeze({
  "NATIONAL PERMIT": "NATIONAL",
  "ALL INDIA PERMIT": "NATIONAL",
  "NATIONAL": "NATIONAL",
  "STATE PERMIT": "STATE",
  "STATE CARRIAGE PERMIT": "STATE",
  "STATE": "STATE",
  "GOODS PERMIT (STATE)": "STATE",
  "CONTRACT CARRIAGE PERMIT": "CONTRACT_CARRIAGE",
  "CONTRACT CARRIAGE": "CONTRACT_CARRIAGE",
  "PRIVATE SERVICE VEHICLE": "PRIVATE",
  "PRIVATE": "PRIVATE",
  "NA": "NONE",
  "NOT APPLICABLE": "NONE",
  "NONE": "NONE",
});

const tidy = (raw: unknown): string =>
  typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, " ") : "";

/** Reads a class description, or says nothing at all rather than guessing. */
export const readVehicleClass = (
  description: unknown,
  grossVehicleWeightKg: number | undefined,
  classes: ProviderVehicleClassMap = VAHAN_CLASS_DESCRIPTIONS,
): { readonly vehicleClass: VehicleClass; readonly basis: string } | null => {
  const text = tidy(description);
  if (text === "") return null;
  const direct = classes[text];
  if (direct !== undefined) return { vehicleClass: direct, basis: `the registering authority's own class, "${text}"` };
  if (GOODS_ONLY_DESCRIPTIONS.includes(text)) {
    if (grossVehicleWeightKg === undefined) return null;
    const vehicleClass: VehicleClass = grossVehicleWeightKg <= 7_500
      ? "LIGHT_GOODS_VEHICLE"
      : grossVehicleWeightKg <= 12_000 ? "MEDIUM_GOODS_VEHICLE" : "HEAVY_GOODS_VEHICLE";
    return {
      vehicleClass,
      basis: `"${text}" on the record, sorted by its registered gross weight of ${grossVehicleWeightKg} kg`,
    };
  }
  return null;
};

export const readBodyType = (description: unknown, bodies: ProviderBodyTypeMap = VAHAN_BODY_DESCRIPTIONS): VehicleBodyType | null => {
  const text = tidy(description);
  return text === "" ? null : bodies[text] ?? null;
};

export const readPermitType = (description: unknown, permits: ProviderPermitMap = VAHAN_PERMIT_DESCRIPTIONS): PermitType | null => {
  const text = tidy(description);
  return text === "" ? null : permits[text] ?? null;
};

const MONTHS: Readonly<Record<string, string>> = Object.freeze({
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
});

/**
 * A date as the vehicle record writes it.
 *
 * VAHAN answers vary by state and by API version: "31-Mar-2027", "31/03/2027" and "2027-03-31" all
 * appear. A date that cannot be read is dropped rather than turned into today, because a wrong
 * insurance expiry is worse than a missing one — a missing one shows as "we do not know".
 */
export const readRecordDate = (raw: unknown): IsoDate | null => {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) return text as IsoDate;
  const named = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/.exec(text);
  if (named !== null) {
    const month = MONTHS[(named[2] as string).toUpperCase()];
    if (month === undefined) return null;
    return `${named[3]}-${month}-${(named[1] as string).padStart(2, "0")}` as IsoDate;
  }
  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (numeric !== null) {
    const month = Number(numeric[2]);
    if (month < 1 || month > 12) return null;
    return `${numeric[3]}-${String(month).padStart(2, "0")}-${(numeric[1] as string).padStart(2, "0")}` as IsoDate;
  }
  return null;
};

/** A weight as the record writes it: "2590", "2590 KG", 2590. Nonsense comes back as nothing. */
export const readWeightKg = (raw: unknown): number | undefined => {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  const digits = /(\d+(?:\.\d+)?)/.exec(text.replace(/,/g, ""));
  if (digits === null) return undefined;
  const value = Number(digits[1]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
};

/**
 * The provider's payload, as this product is allowed to hold it.
 *
 * The field names are VAHAN's own (`rc_vh_class_desc` and the rest) because that is what the
 * approved providers return; a provider using different names supplies its own reader and calls
 * `assemble` below with the same normalised parts.
 */
export interface VahanPayloadFields {
  readonly registrationNumberKey?: string;
  readonly classKey?: string;
  readonly bodyKey?: string;
  readonly grossWeightKey?: string;
  readonly unladenWeightKey?: string;
  readonly payloadKey?: string;
  readonly permitKey?: string;
  readonly permitValidKey?: string;
  readonly fitnessKey?: string;
  readonly insuranceKey?: string;
  readonly ownerKey?: string;
  readonly statusKey?: string;
}

const VAHAN_KEYS: Required<VahanPayloadFields> = Object.freeze({
  registrationNumberKey: "rc_regn_no",
  classKey: "rc_vh_class_desc",
  bodyKey: "rc_body_type_desc",
  grossWeightKey: "rc_gvw",
  unladenWeightKey: "rc_unld_wt",
  payloadKey: "rc_pyld_wt",
  permitKey: "rc_permit_type",
  permitValidKey: "rc_permit_valid_upto",
  fitnessKey: "rc_fit_upto",
  insuranceKey: "rc_insurance_upto",
  ownerKey: "rc_owner_name",
  statusKey: "rc_status",
});

/** What normalising a payload produced, including what had to be left out and why. */
export interface NormalisedVehicleRecord {
  readonly evidence: VehicleEvidence;
  /** Plain sentences about anything the record did not say or we could not read. */
  readonly gaps: readonly string[];
  /** How the class was arrived at, where there is one. */
  readonly classBasis?: string;
}

/**
 * Turns one provider payload into evidence.
 *
 * `allowedFields` is the company's consent, and it is applied here rather than trusted to be
 * applied later: a business that has not agreed to have the owner's name read does not get an
 * owner's name in the object at all, masked or otherwise.
 */
export const normaliseVehicleRecord = (
  payload: Readonly<Record<string, unknown>>,
  options: {
    readonly registrationNumber: string;
    readonly retrievedAt: string;
    readonly reference?: string;
    readonly allowedFields?: readonly PermittedVehicleField[];
    readonly keys?: VahanPayloadFields;
  },
): NormalisedVehicleRecord => {
  const keys = { ...VAHAN_KEYS, ...(options.keys ?? {}) };
  const allowed = new Set<PermittedVehicleField>(options.allowedFields ?? PERMITTED_VEHICLE_FIELDS);
  const gaps: string[] = [];
  const may = (field: PermittedVehicleField): boolean => allowed.has(field);

  const grossVehicleWeightKg = may("grossVehicleWeightKg") ? readWeightKg(payload[keys.grossWeightKey]) : undefined;
  const unladenWeightKg = may("unladenWeightKg") ? readWeightKg(payload[keys.unladenWeightKey]) : undefined;
  const ratedPayloadKg = may("ratedPayloadKg") ? readWeightKg(payload[keys.payloadKey]) : undefined;

  const readClass = may("vehicleClass") ? readVehicleClass(payload[keys.classKey], grossVehicleWeightKg) : null;
  if (may("vehicleClass") && readClass === null) {
    gaps.push(
      tidy(payload[keys.classKey]) === ""
        ? "The record does not say what kind of vehicle this is."
        : `The record calls this a "${tidy(payload[keys.classKey])}", which is not a description we recognise, so the kind of vehicle is being treated as unknown rather than guessed.`,
    );
  }
  const bodyType = may("bodyType") ? readBodyType(payload[keys.bodyKey]) : null;
  const permitType = may("permitType") ? readPermitType(payload[keys.permitKey]) : null;
  if (may("permitType") && permitType === null && tidy(payload[keys.permitKey]) !== "") {
    gaps.push(`The permit is recorded as "${tidy(payload[keys.permitKey])}", which we do not recognise, so it is not being read as any particular permit.`);
  }
  if (grossVehicleWeightKg === undefined && ratedPayloadKg === undefined && may("grossVehicleWeightKg")) {
    gaps.push("The record does not state a weight this vehicle is registered to carry.");
  }

  const permitValidUpto = may("permitValidUpto") ? readRecordDate(payload[keys.permitValidKey]) : null;
  const fitnessValidUpto = may("fitnessValidUpto") ? readRecordDate(payload[keys.fitnessKey]) : null;
  const insuranceValidUpto = may("insuranceValidUpto") ? readRecordDate(payload[keys.insuranceKey]) : null;
  if (may("fitnessValidUpto") && fitnessValidUpto === null) gaps.push("The record does not give a fitness certificate expiry we could read.");

  const ownerRaw = may("registeredOwnerName") && typeof payload[keys.ownerKey] === "string" ? (payload[keys.ownerKey] as string) : "";
  const status = may("registrationStatus") ? tidy(payload[keys.statusKey]) : "";

  const evidence: VehicleEvidence = {
    registrationNumber: normaliseVehicleNumber(options.registrationNumber),
    source: "GOVERNMENT_RECORD",
    retrievedAt: options.retrievedAt,
    ...(readClass === null ? {} : { vehicleClass: readClass.vehicleClass }),
    ...(bodyType === null ? {} : { bodyType }),
    ...(grossVehicleWeightKg === undefined ? {} : { grossVehicleWeightKg }),
    ...(unladenWeightKg === undefined ? {} : { unladenWeightKg }),
    ...(ratedPayloadKg === undefined ? {} : { ratedPayloadKg }),
    ...(permitType === null ? {} : { permitType }),
    ...(permitValidUpto === null ? {} : { permitValidUpto }),
    ...(fitnessValidUpto === null ? {} : { fitnessValidUpto }),
    ...(insuranceValidUpto === null ? {} : { insuranceValidUpto }),
    // Masked at the boundary. The full name never enters this product's memory or its storage.
    ...(ownerRaw.trim() === "" ? {} : { registeredOwnerName: maskOwnerName(ownerRaw) }),
    ...(status === "" ? {} : { registrationStatus: status }),
    ...(options.reference === undefined ? {} : { reference: options.reference }),
  };

  return {
    evidence,
    gaps: Object.freeze(gaps),
    ...(readClass === null ? {} : { classBasis: readClass.basis }),
  };
};

/** Hours between two instants, as a number a policy can be compared against. */
export const hoursBetween = (earlier: string, later: string): number =>
  (Date.parse(later) - Date.parse(earlier)) / 3_600_000;

/** Whether a stored reading is still today's fact, by the company's own freshness policy. */
export const freshnessOf = (retrievedAt: string, now: string, policy: VehicleRecordFreshnessPolicy): VehicleRecordFreshness =>
  hoursBetween(retrievedAt, now) > policy.staleAfterDays * 24 ? "STALE" : "CURRENT";

/** Whether a stored reading is recent enough to be used instead of asking the provider again. */
export const reusable = (retrievedAt: string, now: string, policy: VehicleRecordFreshnessPolicy): boolean => {
  const age = hoursBetween(retrievedAt, now);
  return age >= 0 && age <= policy.reuseWithinHours;
};

/** "3 hours ago", "6 days ago" — how a screen says the age of a reading. */
export const ageInWords = (retrievedAt: string, now: string): string => {
  const hours = hoursBetween(retrievedAt, now);
  if (!Number.isFinite(hours)) return "at an unknown time";
  if (hours < 1) return "in the last hour";
  if (hours < 24) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};
