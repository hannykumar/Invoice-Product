// Issue #28 [E28] — storage, the company's own vehicle list, and a stand-in for the plate reader.
//
// The registering authority is not here. Issue #29 owns it: `VehicleRecordService` implements the
// `VehicleRecordPort` below, over issue #8's connector gateway, with a synthetic VAHAN behind it
// for development. Keeping a second synthetic authority here as well would give this module two
// ideas of what a vehicle record looks like, and eventually two different answers.

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
