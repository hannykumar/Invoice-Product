// Issue #28 [E28] — storage, the company's own vehicle list, and stand-ins for the two outside
// services until issue #29 and a real plate reader arrive.
//
// The synthetic vehicle-record service below is not a happy path. It implements the behaviours that
// actually decide whether this module is any good: a scooter that is registered and perfectly real
// but cannot carry a consignment, a goods vehicle with a capacity well under what is being loaded,
// a vehicle the authority has never heard of, and a service that is simply down — which is a
// different answer from all three.

import type { CompanyId } from "@invoice/kernel";
import type { TransactionParticipant } from "@invoice/ledger";
import { DEFAULT_VEHICLE_SUITABILITY_POLICY } from "./suitability-types.ts";
import { normaliseVehicleNumber } from "./validity.ts";
import { outstandingOf } from "./suitability-service.ts";
import type {
  PlatePhoto, VehicleEvidence, VehicleSuitabilityAssessment, VehicleSuitabilityPolicy,
} from "./suitability-types.ts";
import type {
  PlateOcrPort, PlateReadOutcome, SuitabilityRepository, VehicleMasterPort, VehicleRecordLookup,
  VehicleRecordPort, VehicleSuitabilityPolicyPort,
} from "./suitability-ports.ts";
import type { Id, IsoDate, Vehicle } from "../../masters/src/types.ts";

export class InMemorySuitabilityStore implements SuitabilityRepository, TransactionParticipant {
  #rows: VehicleSuitabilityAssessment[] = [];

  snapshot(): unknown { return [...this.#rows]; }
  restore(taken: unknown): void { this.#rows = [...(taken as VehicleSuitabilityAssessment[])]; }

  async insert(assessment: VehicleSuitabilityAssessment): Promise<void> { this.#rows.push(Object.freeze(assessment)); }

  async update(assessment: VehicleSuitabilityAssessment): Promise<void> {
    const index = this.#rows.findIndex((row) => row.companyId === assessment.companyId && row.id === assessment.id);
    if (index >= 0) this.#rows[index] = Object.freeze(assessment);
  }

  async findById(companyId: CompanyId, id: Id): Promise<VehicleSuitabilityAssessment | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.id === id) ?? null;
  }

  /** The newest check for a movement: a lorry can be checked, changed and checked again. */
  async findLatestForMovement(companyId: CompanyId, movementId: Id): Promise<VehicleSuitabilityAssessment | null> {
    const matching = this.#rows.filter((row) => row.companyId === companyId && row.movementId === movementId);
    return matching[matching.length - 1] ?? null;
  }

  async list(companyId: CompanyId): Promise<VehicleSuitabilityAssessment[]> {
    return this.#rows.filter((row) => row.companyId === companyId);
  }

  async listBlocked(companyId: CompanyId): Promise<VehicleSuitabilityAssessment[]> {
    return this.#rows.filter((row) => row.companyId === companyId && outstandingOf(row.findings, row.overrides).length > 0);
  }
}

/** Effective-dated policies, newest first, as every other policy in this product is held. */
export class InMemoryVehicleSuitabilityPolicies implements VehicleSuitabilityPolicyPort {
  readonly #byCompany = new Map<string, VehicleSuitabilityPolicy[]>();

  set(companyId: CompanyId, policy: VehicleSuitabilityPolicy): void {
    const merged = [...(this.#byCompany.get(companyId) ?? []).filter((candidate) => candidate.effectiveFrom !== policy.effectiveFrom), policy];
    merged.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
    this.#byCompany.set(companyId, merged);
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleSuitabilityPolicy> {
    return (this.#byCompany.get(companyId) ?? []).find((policy) => policy.effectiveFrom <= on) ?? DEFAULT_VEHICLE_SUITABILITY_POLICY;
  }
}

/**
 * The company's own vehicle list from issue #5, read as evidence.
 *
 * The mapping is deliberately thin. A capacity somebody typed into the vehicle master is a real
 * fact and is carried across; a *class* is not inferred from a body type, because "closed" tells
 * you nothing about whether the authority registered the thing as a goods vehicle. The single
 * exception is a two-wheeler body, which cannot be anything but a two-wheeler.
 */
export const mastersVehicleAdapter = (vehicles: (companyId: CompanyId) => readonly Vehicle[], now: () => Date): VehicleMasterPort => ({
  async findByRegistrationNumber(companyId: CompanyId, registrationNumber: string): Promise<VehicleEvidence | null> {
    const wanted = normaliseVehicleNumber(registrationNumber);
    const found = vehicles(companyId).find((vehicle) => normaliseVehicleNumber(vehicle.registrationNumber) === wanted && vehicle.active);
    if (found === undefined) return null;
    return {
      registrationNumber: wanted,
      source: "COMPANY_MASTER",
      retrievedAt: now().toISOString(),
      bodyType: found.bodyType,
      ...(found.bodyType === "two_wheeler" ? { vehicleClass: "TWO_WHEELER" as const } : {}),
      ...(found.ratedCapacityKg === undefined ? {} : { ratedPayloadKg: found.ratedCapacityKg }),
    };
  },
});

// ------------------------------------------------------- the stand-in for issue #29's service

/** One vehicle as the synthetic authority holds it, plus the ways a lookup can fail. */
export interface SyntheticVehicleRow extends Omit<VehicleEvidence, "source" | "retrievedAt"> {}

/**
 * A vehicle-record service for development and tests.
 *
 * Issue #29 owns the real one. This implements the same port so everything above it can be built,
 * demonstrated and tested today, and so the failure cases — no such vehicle, service down — can be
 * exercised deliberately rather than waited for.
 */
export class SyntheticVehicleRecordService implements VehicleRecordPort {
  readonly #rows = new Map<string, SyntheticVehicleRow>();
  readonly #now: () => Date;
  #outage: { readonly code: string; readonly message: string; readonly retryable: boolean } | null = null;

  constructor(now: () => Date, rows: readonly SyntheticVehicleRow[] = DEMO_VEHICLE_RECORDS) {
    this.#now = now;
    rows.forEach((row) => this.#rows.set(normaliseVehicleNumber(row.registrationNumber), row));
  }

  /** Takes the service down, so the "we could not ask" path can be tested on purpose. */
  goDown(code = "OUTAGE", message = "The vehicle record service is not responding at the moment.", retryable = true): void {
    this.#outage = { code, message, retryable };
  }

  comeBack(): void { this.#outage = null; }

  async lookup(_companyId: CompanyId, registrationNumber: string): Promise<VehicleRecordLookup> {
    const checkedAt = this.#now().toISOString();
    if (this.#outage !== null) return { kind: "UNAVAILABLE", ...this.#outage, checkedAt };
    const row = this.#rows.get(normaliseVehicleNumber(registrationNumber));
    if (row === undefined) {
      return { kind: "NOT_FOUND", checkedAt, message: `The registering authority holds no vehicle with the number ${normaliseVehicleNumber(registrationNumber)}.` };
    }
    return { kind: "FOUND", evidence: { ...row, source: "GOVERNMENT_RECORD", retrievedAt: checkedAt } };
  }
}

/**
 * The vehicles the demo and the tests run against.
 *
 * A scooter, a private car, a small goods vehicle and a proper lorry — the four the issue's own
 * scenarios need, with real-shaped capacities.
 */
export const DEMO_VEHICLE_RECORDS: readonly SyntheticVehicleRow[] = Object.freeze([
  {
    registrationNumber: "KA05MN9012",
    vehicleClass: "TWO_WHEELER",
    bodyType: "two_wheeler",
    grossVehicleWeightKg: 240,
    unladenWeightKg: 118,
    permitType: "NONE",
    fitnessValidUpto: "2029-03-31",
    insuranceValidUpto: "2027-01-31",
    registrationStatus: "ACTIVE",
    registeredOwnerName: "R Manjunath",
    reference: "SYN/KA05MN9012",
  },
  {
    registrationNumber: "KA03MC4455",
    vehicleClass: "MOTOR_CAR",
    bodyType: "closed",
    grossVehicleWeightKg: 1_950,
    unladenWeightKg: 1_450,
    permitType: "PRIVATE",
    fitnessValidUpto: "2030-06-30",
    insuranceValidUpto: "2027-05-31",
    registrationStatus: "ACTIVE",
    reference: "SYN/KA03MC4455",
  },
  {
    // The one the issue's second sentence is about: a real goods vehicle, comfortably too small.
    registrationNumber: "KA02GV3344",
    vehicleClass: "LIGHT_GOODS_VEHICLE",
    bodyType: "closed",
    grossVehicleWeightKg: 2_590,
    unladenWeightKg: 1_340,
    ratedPayloadKg: 1_250,
    permitType: "STATE",
    permitValidUpto: "2027-03-31",
    fitnessValidUpto: "2027-09-30",
    insuranceValidUpto: "2027-02-28",
    registrationStatus: "ACTIVE",
    reference: "SYN/KA02GV3344",
  },
  {
    registrationNumber: "KA01AB1234",
    vehicleClass: "HEAVY_GOODS_VEHICLE",
    bodyType: "open",
    grossVehicleWeightKg: 25_000,
    unladenWeightKg: 8_600,
    ratedPayloadKg: 16_400,
    permitType: "NATIONAL",
    permitValidUpto: "2028-03-31",
    fitnessValidUpto: "2027-11-30",
    insuranceValidUpto: "2027-07-31",
    registrationStatus: "ACTIVE",
    registeredOwnerName: "Sampoorna Traders Private Limited",
    reference: "SYN/KA01AB1234",
  },
  {
    registrationNumber: "KA07RF8899",
    vehicleClass: "MEDIUM_GOODS_VEHICLE",
    bodyType: "refrigerated",
    grossVehicleWeightKg: 12_000,
    unladenWeightKg: 5_200,
    ratedPayloadKg: 6_800,
    permitType: "NATIONAL",
    permitValidUpto: "2028-03-31",
    fitnessValidUpto: "2027-08-31",
    insuranceValidUpto: "2027-09-30",
    registrationStatus: "ACTIVE",
    reference: "SYN/KA07RF8899",
  },
]);

// ------------------------------------------------------------------- the number-plate reader

/**
 * A plate reader for development.
 *
 * It reads whatever the photograph was labelled with, at whatever confidence the photograph was
 * labelled with — which is exactly what a test needs and exactly what a demo needs, without pulling
 * a vision model into the repository. The bytes are never inspected and never stored.
 */
export class SyntheticPlateReader implements PlateOcrPort {
  #outcome: PlateReadOutcome | null = null;

  /** Makes the next reads return this, whatever the photograph says. */
  willReturn(outcome: PlateReadOutcome | null): void { this.#outcome = outcome; }

  async read(_companyId: CompanyId, photo: PlatePhoto): Promise<PlateReadOutcome> {
    if (this.#outcome !== null) return this.#outcome;
    // The convention in fixtures and the demo: the photo id carries what the camera saw, as
    // "plate:KA01AB1234@0.94". Anything else is a photograph nothing can be made of.
    const parsed = /^plate:([A-Z0-9]+)(?:@([0-9.]+))?$/i.exec(photo.photoId);
    if (parsed === null) return { kind: "UNREADABLE", reason: "The plate could not be made out in this picture." };
    return { kind: "READ", text: parsed[1] as string, confidence: parsed[2] === undefined ? 0.95 : Number(parsed[2]) };
  }
}

/** A photograph for the demo and the tests. The bytes are a stand-in; nothing reads them. */
export const platePhoto = (photoId: string, capturedAt: string): PlatePhoto => ({
  photoId,
  capturedAt,
  mimeType: "image/jpeg",
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
});
