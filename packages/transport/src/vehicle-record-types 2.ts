// Issue #29 [E29] — what we are allowed to ask the registering authority, what we keep of the
// answer, and how old an answer may be before it stops counting as a fact.
//
// The registering authority's vehicle record (the RC, held in the VAHAN database and reachable
// through API Setu or an equivalent approved provider) holds a great deal about a lorry, and most
// of it is none of this product's business. A dispatch desk needs to know what the vehicle is and
// what it may carry. It does not need the owner's address, the chassis number or the engine
// number, and asking for them would be a privacy failure whether or not anybody ever looked.
//
// Three rules run through this file.
//
//   1. **An allow-list, not a deny-list.** The fields this product may request and store are named
//      here. A provider that returns more has the extra dropped before it reaches storage, so a
//      provider adding a field can never quietly widen what we hold.
//   2. **A reading has a date and a source, always.** Every stored record says which provider
//      answered, the provider's own reference for that answer, and when it was read. A record with
//      no date is not evidence; a year-old reading of an insurance expiry is not today's fact.
//   3. **"We could not ask" is never "nothing is wrong".** No consent, no credential, provider
//      down, request refused — all of those are `UNAVAILABLE`, which is a different answer from
//      the authority saying it holds no such vehicle.

import type { IsoDate } from "../../masters/src/types.ts";
import type { PermitType, VehicleClass, VehicleEvidence } from "./suitability-types.ts";
import type { VehicleBodyType } from "../../masters/src/types.ts";

/**
 * The fields this product is permitted to ask for and to keep.
 *
 * Everything here answers a suitability question. `registeredOwnerName` is the one field that names
 * a person, and it is stored masked (see `maskOwnerName`) because its only use is a sanity check
 * that the lorry at the gate belongs to the transporter who was booked — for which "S***** T*****"
 * is as useful as the full name, and far less to lose.
 */
export const PERMITTED_VEHICLE_FIELDS = Object.freeze([
  "registrationNumber",
  "vehicleClass",
  "bodyType",
  "grossVehicleWeightKg",
  "unladenWeightKg",
  "ratedPayloadKg",
  "permitType",
  "permitValidUpto",
  "fitnessValidUpto",
  "insuranceValidUpto",
  "registeredOwnerName",
  "registrationStatus",
] as const);

export type PermittedVehicleField = (typeof PERMITTED_VEHICLE_FIELDS)[number];

/**
 * Each permitted field in plain words.
 *
 * A consent screen that says `grossVehicleWeightKg` at a shopkeeper has not obtained consent to
 * anything; it has shown them a variable name. This is what the screens print instead.
 */
export const PERMITTED_VEHICLE_FIELD_NAMES: Readonly<Record<PermittedVehicleField, string>> = Object.freeze({
  registrationNumber: "the vehicle number",
  vehicleClass: "what kind of vehicle it is",
  bodyType: "the kind of body it has",
  grossVehicleWeightKg: "what it may weigh when loaded",
  unladenWeightKg: "what it weighs empty",
  ratedPayloadKg: "how much it may carry",
  permitType: "which permit it holds",
  permitValidUpto: "when that permit runs out",
  fitnessValidUpto: "when its fitness certificate runs out",
  insuranceValidUpto: "when its insurance runs out",
  registeredOwnerName: "the owner's initials only",
  registrationStatus: "whether the registration is still live",
});

/**
 * Why a business is asking, recorded once and checked on every lookup.
 *
 * The provider's terms and the underlying rules allow a vehicle record to be read for a stated
 * purpose. This product has exactly one: deciding whether a movement may go out on this vehicle.
 * Holding the purpose as data rather than as a comment means a lookup for any other reason has to
 * be a deliberate change here, and shows up in the audit trail as one.
 */
export type VehicleLookupPurpose = "TRANSPORT_SUITABILITY";

/**
 * A company's permission to use the vehicle-record service, and the credential behind it.
 *
 * The credential itself is never in this record. `credentialReference` is a name that means
 * something to the credential vault from issue #8 and nothing to anybody who reads this row.
 */
export interface VehicleRecordConsent {
  readonly companyId: string;
  readonly purpose: VehicleLookupPurpose;
  /** Which of the permitted fields this business has agreed to have read and kept. */
  readonly fields: readonly PermittedVehicleField[];
  readonly grantedBy: string;
  readonly grantedAt: string;
  /** Consent is dated. An expired one is not consent, and the lookup stops rather than continues. */
  readonly expiresOn?: IsoDate;
  readonly credentialReference?: string;
  /** Set when somebody withdrew it, which is a fact worth keeping rather than a row to delete. */
  readonly revokedAt?: string;
}

/** How old a reading may be before the screens stop treating it as today's fact. */
export interface VehicleRecordFreshnessPolicy {
  /**
   * Below this age, a stored reading is reused instead of asking the provider again.
   *
   * A registration class does not change from one hour to the next, and every avoided call is a
   * call the provider does not charge for and a person's data not moved again.
   */
  readonly reuseWithinHours: number;
  /**
   * Above this age, a stored reading is shown as stale.
   *
   * Insurance and fitness certificates expire, so a month-old reading may be describing a lorry
   * that is no longer road-legal. Stale evidence is still shown — it is simply not passed off as
   * current, and the suitability check treats it as something a person should look at.
   */
  readonly staleAfterDays: number;
  readonly effectiveFrom: IsoDate;
}

/**
 * The default: reuse for six hours, stale after seven days.
 *
 * Six hours means a lorry checked in the morning and re-checked at loading time is not two calls.
 * Seven days is the same window the supplier check uses for a government reading, so a business
 * sees one idea of "recent" across the product.
 */
export const DEFAULT_VEHICLE_RECORD_FRESHNESS: VehicleRecordFreshnessPolicy = Object.freeze({
  reuseWithinHours: 6,
  staleAfterDays: 7,
  effectiveFrom: "2026-04-01",
});

/** Which provider answered, so a reading can be traced to the service that gave it. */
export interface VehicleRecordProvenance {
  /** The adapter's own name: "api-setu-vahan", "ntr", or whatever replaces them. */
  readonly provider: string;
  /** The provider's reference for this one answer. The audit trail's link back to their side. */
  readonly providerReference: string;
  /** When we asked. Not when they say the record was last updated: that is their claim, not ours. */
  readonly retrievedAt: string;
}

/**
 * One stored reading of one vehicle.
 *
 * This is the row that is cached, and it is deliberately thin: permitted fields only, owner name
 * masked, no free-form provider payload kept alongside "just in case".
 */
export interface VehicleRecordSnapshot {
  readonly companyId: string;
  readonly registrationNumber: string;
  readonly provenance: VehicleRecordProvenance;
  /** Absent when the authority answered that it holds no such vehicle. */
  readonly evidence?: VehicleEvidence;
  /** True when the authority answered, and answered that there is no such vehicle. */
  readonly notFound: boolean;
}

/** What a screen is told about one lookup, over and above the evidence itself. */
export type VehicleRecordFreshness =
  /** Read just now, or recently enough to still be today's fact. */
  | "CURRENT"
  /** Older than the freshness policy allows. Shown, with its age, and never as proof of today. */
  | "STALE";

/**
 * The answer to "tell me about this lorry", as the verification service gives it.
 *
 * `FOUND` and `NOT_FOUND` are both the authority answering. `UNAVAILABLE` is us failing to ask, and
 * the three are never collapsed into two — a lorry we could not check has not been checked.
 */
export type VehicleRecordVerification =
  | {
      readonly kind: "FOUND";
      readonly evidence: VehicleEvidence;
      readonly provenance: VehicleRecordProvenance;
      readonly freshness: VehicleRecordFreshness;
      /** True when this came from the stored reading rather than a fresh call. */
      readonly fromCache: boolean;
      /** One sentence a dispatch clerk can read, with the class and the date in it. */
      readonly summary: string;
    }
  | {
      readonly kind: "NOT_FOUND";
      readonly provenance: VehicleRecordProvenance;
      readonly fromCache: boolean;
      readonly summary: string;
    }
  | {
      readonly kind: "UNAVAILABLE";
      readonly code: VehicleRecordUnavailableCode;
      readonly retryable: boolean;
      readonly checkedAt: string;
      readonly summary: string;
      /**
       * A reading we already had, however old.
       *
       * Kept rather than thrown away: when the provider is down, a week-old class is more use to a
       * loading bay than nothing, as long as the screen says how old it is and that today's answer
       * could not be obtained.
       */
      readonly lastKnown?: {
        readonly evidence: VehicleEvidence;
        readonly provenance: VehicleRecordProvenance;
        readonly freshness: VehicleRecordFreshness;
      };
    };

/** The reasons a lookup could not be made. Each is a different thing for somebody to do about it. */
export type VehicleRecordUnavailableCode =
  /** Nobody at this business has turned the vehicle-record service on. */
  | "NOT_CONNECTED"
  /** Consent was given and has run out, or was withdrawn. */
  | "CONSENT_EXPIRED"
  /** The credential the provider needs is missing or rejected. */
  | "UNAUTHORIZED"
  /** The provider answered too slowly. */
  | "TIMEOUT"
  /** The provider is down. */
  | "OUTAGE"
  /** The number does not look like an Indian registration number, so nothing was sent. */
  | "INVALID_NUMBER"
  /** The provider took the request and refused it for a reason of its own. */
  | "REFUSED";

/**
 * A registration number as the provider will accept it.
 *
 * Indian registration numbers are two letters of state, one or two digits of district, up to three
 * letters of series and up to four digits — with older and armed-forces formats that do not fit.
 * This is deliberately loose: the job is to catch a typed-in "ABC" or a phone number before it
 * becomes a paid call and a person's data being moved, not to be the authority on plate formats.
 */
export const looksLikeRegistrationNumber = (raw: string): boolean =>
  /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/.test(raw.toUpperCase().replace(/[\s-]/g, ""));

/**
 * The owner's name, reduced to what a gate check needs.
 *
 * "Sampoorna Traders Private Limited" becomes "S******** T****** P****** L******". Somebody standing
 * at the gate with the transporter's paperwork can tell whether it is the same business. Somebody
 * reading a stolen copy of the database learns nothing.
 */
export const maskOwnerName = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]}${"*".repeat(word.length - 1)}`)
    .join(" ");

/** Plain words for why we could not ask, for a screen and for the audit trail alike. */
export const VEHICLE_RECORD_UNAVAILABLE_MESSAGES: Readonly<Record<VehicleRecordUnavailableCode, string>> = Object.freeze({
  NOT_CONNECTED: "This business has not connected the vehicle-record service yet, so the vehicle has not been checked against the registering authority.",
  CONSENT_EXPIRED: "The permission to look up vehicle records has run out, so nothing was asked. Someone with access has to give it again.",
  UNAUTHORIZED: "The vehicle-record service did not accept our credentials, so the vehicle has not been checked.",
  TIMEOUT: "The vehicle-record service did not answer in time, so the vehicle has not been checked.",
  OUTAGE: "The vehicle-record service is not responding at the moment, so the vehicle has not been checked.",
  INVALID_NUMBER: "That does not look like a vehicle number, so nothing was sent to the registering authority.",
  REFUSED: "The vehicle-record service refused the request, so the vehicle has not been checked.",
});

/** The provider's own words for a class, mapped to the classes the suitability rules understand. */
export type ProviderVehicleClassMap = Readonly<Record<string, VehicleClass>>;

/** The provider's own words for a body, mapped to ours. */
export type ProviderBodyTypeMap = Readonly<Record<string, VehicleBodyType>>;

/** The provider's own words for a permit, mapped to ours. */
export type ProviderPermitMap = Readonly<Record<string, PermitType>>;
