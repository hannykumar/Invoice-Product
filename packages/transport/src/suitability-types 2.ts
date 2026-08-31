// Issue #28 [E28] — what a lorry is, what is being loaded onto it, and whether that is possible.
//
// The thing this module exists to stop is a movement whose facts do not fit each other: five tonnes
// of steel booked out on a scooter, a refrigerated load on an open truck, a goods vehicle carrying
// three times the weight its own registration record allows. These are not tax mistakes. They are
// the mistakes that get a lorry stopped at a check post, or get the goods never delivered at all,
// and every one of them is visible before the vehicle leaves the yard.
//
// Three rules run through everything here.
//
//   1. **Evidence has a source, and the source is never hidden.** A capacity read from the
//      government's vehicle record is a different kind of fact from a capacity somebody typed into
//      the vehicle master, and the screens say which one decided the answer. Where the government
//      service could not be reached, that is `CANNOT_DECIDE` and says so — it is never quietly
//      treated as "no problem found".
//   2. **A block is about physical facts, a warning is about judgement.** A scooter cannot carry a
//      tonne, and no reason makes it able to. A load at 95% of a lorry's rated payload is legal and
//      merely worth knowing about.
//   3. **An override is a separate record, never an edit.** Overriding a finding does not change
//      the weight, the capacity, the photograph or the government's record. It adds a person's name,
//      the time and their reason on top of evidence that stays exactly as it was.

import type { IsoDate } from "../../masters/src/types.ts";
import type { VehicleBodyType } from "../../masters/src/types.ts";
import type { AppliedFact, TransportMode } from "./types.ts";

export type { VehicleBodyType };

/**
 * What the vehicle is, in the registering authority's own categories.
 *
 * These are the classes that appear on an Indian registration certificate, collapsed to the ones
 * that change the answer. The distinction that does the work is passenger versus goods: a motor car
 * and a scooter are not small goods vehicles, they are not goods vehicles at all.
 */
export type VehicleClass =
  | "TWO_WHEELER"
  | "THREE_WHEELER_PASSENGER"
  /** An auto-rickshaw built to carry goods. A real goods vehicle, and a very small one. */
  | "THREE_WHEELER_GOODS"
  | "MOTOR_CAR"
  | "BUS"
  /** Light goods vehicle: gross weight up to 7.5 tonnes. The ordinary small-town delivery truck. */
  | "LIGHT_GOODS_VEHICLE"
  | "MEDIUM_GOODS_VEHICLE"
  | "HEAVY_GOODS_VEHICLE"
  | "TRAILER"
  | "TRACTOR"
  /** A class we hold but do not recognise. Never assumed to be able to carry anything. */
  | "OTHER";

/** Classes built to carry goods. Everything else is carrying a consignment it was not made for. */
export const GOODS_CARRYING_CLASSES: readonly VehicleClass[] = Object.freeze([
  "THREE_WHEELER_GOODS", "LIGHT_GOODS_VEHICLE", "MEDIUM_GOODS_VEHICLE", "HEAVY_GOODS_VEHICLE",
  "TRAILER", "TRACTOR",
]);

/**
 * Where a fact came from. This is the difference between proof and a note somebody made.
 *
 * `GOVERNMENT_RECORD` is the registering authority's own record, reached through issue #29's
 * verification. `COMPANY_MASTER` is what the business typed into its own vehicle list — useful, and
 * not proof of anything. `ENTERED_BY_HAND` is a value given for this one movement.
 */
export type EvidenceSource = "GOVERNMENT_RECORD" | "COMPANY_MASTER" | "ENTERED_BY_HAND";

/**
 * The facts we hold about one vehicle, and where each set of them came from.
 *
 * Everything except the number is optional on purpose. A small transporter's lorry may have nothing
 * recorded against it anywhere, and the honest answer then is "we cannot tell", not a capacity
 * invented from the shape of the number plate.
 */
export interface VehicleEvidence {
  readonly registrationNumber: string;
  readonly source: EvidenceSource;
  /** When this evidence was obtained, so a stale government reading can be seen for what it is. */
  readonly retrievedAt: string;
  readonly vehicleClass?: VehicleClass;
  readonly bodyType?: VehicleBodyType;
  /** Gross vehicle weight: the whole thing, loaded, as registered. */
  readonly grossVehicleWeightKg?: number;
  /** What the vehicle weighs empty. Payload is the difference between the two. */
  readonly unladenWeightKg?: number;
  /** Payload where the record states it directly rather than leaving it to be worked out. */
  readonly ratedPayloadKg?: number;
  readonly permitType?: PermitType;
  readonly permitValidUpto?: IsoDate;
  readonly fitnessValidUpto?: IsoDate;
  readonly insuranceValidUpto?: IsoDate;
  readonly registeredOwnerName?: string;
  /** "SCRAPPED", "REGISTRATION CANCELLED" and the like, kept in the authority's own words. */
  readonly registrationStatus?: string;
  /** The authority's own reference for this reading, for the audit trail. */
  readonly reference?: string;
}

/**
 * The permit a goods vehicle carries.
 *
 * A state permit does not let a lorry cross a border. That is the permit fact that most often
 * catches a business out, and it is why inter-state movements are checked against it.
 */
export type PermitType = "NATIONAL" | "STATE" | "CONTRACT_CARRIAGE" | "PRIVATE" | "NONE";

/** The payload the evidence actually supports, and how it was arrived at. */
export interface PayloadCapacity {
  readonly capacityKg: number;
  /** Plain words: "stated on the record" or "gross weight minus unladen weight". */
  readonly basis: string;
  readonly source: EvidenceSource;
}

/**
 * What is being loaded.
 *
 * Weight is in kilograms because that is what a weighbridge slip says and what a registration
 * certificate states. Nothing here is derived from the invoice value: a light, expensive
 * consignment and a heavy, cheap one are the same to a lorry's axles.
 */
export interface ShipmentFacts {
  readonly grossWeightKg?: number;
  readonly volumeCubicMetres?: number;
  /** The longest single piece, for a load that will not fit however light it is. */
  readonly longestSideMetres?: number;
  /** Goods that must stay cold: ice cream, vaccines, some chemicals. */
  readonly requiresColdChain?: boolean;
  /** Goods carried under the hazardous-goods rules. */
  readonly hazardous?: boolean;
  /** Liquid in bulk, which needs a tanker rather than a body with a floor. */
  readonly bulkLiquid?: boolean;
}

/** The transport details as entered, before anything has been checked. */
export interface TransportDetails {
  readonly mode: TransportMode;
  readonly vehicleNumber?: string;
  readonly transporterId?: string;
  readonly transporterName?: string;
  /** The transporter's own goods receipt, its number and date. */
  readonly transportDocumentNumber?: string;
  readonly transportDocumentDate?: IsoDate;
  readonly distanceKm?: number;
  /** True when the goods cross a state border, which is what a state permit cannot do. */
  readonly interState?: boolean;
  /** The date the movement happens, so a permit is judged as at the day of the journey. */
  readonly movementDate: IsoDate;
}

// ------------------------------------------------------------------ the number-plate photograph

/** A photograph of the number plate, as bytes plus what the camera said about it. */
export interface PlatePhoto {
  readonly photoId: string;
  readonly capturedAt: string;
  readonly mimeType: string;
  /** The image itself. Kept out of every audit entry and every log line. */
  readonly bytes: Uint8Array;
}

export type PlateComparisonVerdict =
  /** The photo reads as the vehicle number that was entered. */
  | "MATCH"
  /** It differs only where the two characters look the same. Worth a person's eye, not a block. */
  | "LOOKALIKE_DIFFERENCE"
  | "MISMATCH"
  /** The photo could not be read, or the reader could not be reached. Not a mismatch. */
  | "CANNOT_READ";

/** Who read the plate: the yard's camera, or a person standing in front of the lorry. */
export type PlateReadBy = "PHOTO" | "PERSON";

export interface PlateComparison {
  readonly verdict: PlateComparisonVerdict;
  /**
   * A photograph is not always there. A yard with no camera, a phone out of charge, a picture too
   * dark to use — in all of those a person reads the plate and types it, and that reading is
   * checked by exactly the same rules. What changes is this field and the words on the screen.
   */
  readonly readBy: PlateReadBy;
  /** What the reader made of the plate, normalised. Absent when nothing could be read. */
  readonly readNumber?: string;
  readonly declaredNumber: string;
  /** 0 to 1, as the reader reported it. */
  readonly confidence?: number;
  readonly explanation: string;
  readonly photoId?: string;
}

// ------------------------------------------------------------------------------ the assessment

export type SuitabilitySeverity =
  /** The movement must not go out on this vehicle as it stands. */
  | "BLOCK"
  /** Possible, but somebody should look. */
  | "WARN"
  /** A fact we do not have decides it. Never counted as "nothing wrong". */
  | "CANNOT_DECIDE";

/** The whole assessment's answer: the worst thing found, or `OK` when nothing was found. */
export type SuitabilityOutcome = "OK" | SuitabilitySeverity;

export interface SuitabilityFinding {
  /** Stable code, so a screen, a test and an audit entry all name the same thing. */
  readonly code: string;
  readonly severity: SuitabilitySeverity;
  /** A heading a person reads first. */
  readonly title: string;
  /** Why, in plain words, with the numbers in it. */
  readonly reason: string;
  readonly ruleId: string;
  readonly ruleSetVersion: string;
  /** The rule, notification or standard behind it, where there is one. */
  readonly sourceRef?: string;
  readonly appliedFacts: readonly AppliedFact[];
  /** Where the evidence that decided this came from. */
  readonly evidenceSource?: EvidenceSource;
  /**
   * Whether a person with the right permission may send the movement out anyway.
   *
   * Physical impossibility is not overridable. A scooter does not become able to carry five tonnes
   * because a manager signed for it, and offering that button would be a lie about what the
   * override does.
   */
  readonly overridable: boolean;
}

/** One person deciding to go ahead anyway. Stored beside the findings, never inside them. */
export interface SuitabilityOverride {
  /** The findings this override covers. Anything else found stays in force. */
  readonly findingCodes: readonly string[];
  readonly reason: string;
  readonly byUserId: string;
  readonly at: string;
}

export interface VehicleSuitabilityAssessment {
  readonly id: string;
  readonly companyId: string;
  readonly movementId: string;
  readonly checkedAt: string;
  readonly checkedBy: string;
  readonly outcome: SuitabilityOutcome;
  /** What a dispatch clerk reads at the top of the screen. */
  readonly summary: string;
  readonly transport: TransportDetails;
  readonly shipment: ShipmentFacts;
  /** Every piece of evidence used, government and company alike, exactly as it was read. */
  readonly evidence: readonly VehicleEvidence[];
  readonly capacity?: PayloadCapacity;
  readonly plate?: PlateComparison;
  readonly findings: readonly SuitabilityFinding[];
  readonly overrides: readonly SuitabilityOverride[];
  /** True when every blocking finding has an override against it. */
  readonly clearedToMove: boolean;
  readonly idempotencyKey: string;
}

// ------------------------------------------------------------------------------------ policy

/**
 * The configurable part.
 *
 * The class ceilings are not capacities of particular vehicles — they are the most any vehicle of
 * that class could carry, used only to catch the obviously impossible when nothing better is known.
 * They are held here, per company and effective-dated, so a business that runs unusual vehicles can
 * change them without anybody changing code.
 */
export interface VehicleSuitabilityPolicy {
  /** The most a vehicle of each class could plausibly carry, in kilograms. */
  readonly classCeilingKg: Readonly<Record<VehicleClass, number>>;
  /** Above this share of the rated payload, warn. 0.9 means "warn from 90% loaded". */
  readonly warnFromLoadFactor: number;
  /** Load above the rated payload blocks by default; a business may soften it to a warning. */
  readonly overloadSeverity: SuitabilitySeverity;
  /** What to do when the plate photo reads as a different vehicle. */
  readonly plateMismatchSeverity: SuitabilitySeverity;
  /** Confidence below which a reading is treated as unreadable rather than as evidence. */
  readonly minimumPlateConfidence: number;
  /** An expired fitness certificate: the vehicle is not road-legal that day. */
  readonly expiredFitnessSeverity: SuitabilitySeverity;
  /** A state permit on an inter-state run. */
  readonly wrongPermitSeverity: SuitabilitySeverity;
  readonly effectiveFrom: IsoDate;
}

/**
 * The default ceilings.
 *
 * These are deliberately generous — the point is to catch the impossible, not to second-guess a
 * loader. A two-wheeler at 50 kg, a car boot at 400 kg, a goods auto at 750 kg: any of these being
 * asked to carry a tonne is a data-entry mistake, not a tight load.
 */
export const DEFAULT_VEHICLE_SUITABILITY_POLICY: VehicleSuitabilityPolicy = Object.freeze({
  classCeilingKg: Object.freeze({
    TWO_WHEELER: 50,
    THREE_WHEELER_PASSENGER: 200,
    THREE_WHEELER_GOODS: 750,
    MOTOR_CAR: 400,
    BUS: 1_000,
    LIGHT_GOODS_VEHICLE: 7_500,
    MEDIUM_GOODS_VEHICLE: 16_200,
    HEAVY_GOODS_VEHICLE: 49_000,
    TRAILER: 55_000,
    TRACTOR: 25_000,
    OTHER: 0,
  }),
  warnFromLoadFactor: 0.9,
  overloadSeverity: "BLOCK",
  plateMismatchSeverity: "BLOCK",
  minimumPlateConfidence: 0.6,
  expiredFitnessSeverity: "BLOCK",
  wrongPermitSeverity: "WARN",
  effectiveFrom: "2026-04-01",
});

/** Plain English for a class code, so no screen ever prints `THREE_WHEELER_GOODS` at a person. */
export const VEHICLE_CLASS_NAMES: Readonly<Record<VehicleClass, string>> = Object.freeze({
  TWO_WHEELER: "two-wheeler",
  THREE_WHEELER_PASSENGER: "passenger auto-rickshaw",
  THREE_WHEELER_GOODS: "goods auto-rickshaw",
  MOTOR_CAR: "private car",
  BUS: "bus",
  LIGHT_GOODS_VEHICLE: "light goods vehicle",
  MEDIUM_GOODS_VEHICLE: "medium goods vehicle",
  HEAVY_GOODS_VEHICLE: "heavy goods vehicle",
  TRAILER: "trailer",
  TRACTOR: "tractor",
  OTHER: "vehicle of an unrecognised class",
});
