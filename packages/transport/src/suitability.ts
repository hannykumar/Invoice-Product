// Issue #28 [E28] — the rules that decide whether this load can go on this vehicle.
//
// Deterministic and versioned, like every other decision in this product: the same facts on the
// same rule set always produce the same findings, each one carrying the facts it used and the rule
// that produced it. Nothing here calls anything. The government lookup and the plate reader have
// already happened by the time this runs, and their outcomes — including their failures — come in
// as facts.
//
// The ordering of severities is worth stating once, because it is the shape of the whole file:
//
//   BLOCK           the movement cannot go out as it stands.
//   CANNOT_DECIDE   a fact we do not have decides it; it goes to a person.
//   WARN            possible, and somebody should look.
//   OK              every rule ran and found nothing.
//
// `CANNOT_DECIDE` sits above `WARN` on purpose. Not knowing whether a lorry is fit to carry five
// tonnes is a bigger problem than knowing it is 92% loaded.

import {
  DEFAULT_VEHICLE_SUITABILITY_POLICY, GOODS_CARRYING_CLASSES, VEHICLE_CLASS_NAMES,
} from "./suitability-types.ts";
import { normaliseVehicleNumber, VEHICLE_NUMBER } from "./validity.ts";
import type {
  EvidenceSource, PayloadCapacity, PlateComparison, ShipmentFacts, SuitabilityFinding,
  SuitabilityOutcome, SuitabilitySeverity, TransportDetails, VehicleClass, VehicleEvidence,
  VehicleSuitabilityPolicy,
} from "./suitability-types.ts";
import type { VehicleRecordLookup } from "./suitability-ports.ts";
import type { AppliedFact } from "./types.ts";

export const SUITABILITY_RULE_SET_VERSION = "in.transport.vehicle-suitability.2026.1";

/** The portal's own transporter ID: a GSTIN, or the 15-character ID for transporters without one. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;
const TRANSPORTER_ID = /^[0-9A-Z]{15}$/;

export interface SuitabilityInput {
  readonly transport: TransportDetails;
  readonly shipment: ShipmentFacts;
  /** How the registering authority's lookup went, when one was attempted. */
  readonly record?: VehicleRecordLookup;
  /** What the business itself has recorded about this vehicle, when it has anything. */
  readonly master?: VehicleEvidence | null;
  /** The number-plate photograph's verdict, when a photograph was given. */
  readonly plate?: PlateComparison;
  readonly policy?: VehicleSuitabilityPolicy;
}

export interface SuitabilityResult {
  readonly outcome: SuitabilityOutcome;
  readonly summary: string;
  readonly findings: readonly SuitabilityFinding[];
  /** Every piece of evidence the rules read, in the order they were preferred. */
  readonly evidence: readonly VehicleEvidence[];
  readonly capacity?: PayloadCapacity;
}

const kg = (value: number): string => `${value.toLocaleString("en-IN")} kg`;

/** A tonne reads better than four digits when the number is big. */
const weight = (value: number): string => (value >= 1_000 ? `${kg(value)} (${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 2)} tonnes)` : kg(value));

const fact = (label: string, value: string): AppliedFact => ({ label, value });

/**
 * The payload the evidence supports, preferring the government's record over the company's own.
 *
 * A stated payload is used as stated. Where only gross and unladen weights are held, the difference
 * between them is the payload — that subtraction is the registration certificate's own arithmetic,
 * and saying so in `basis` keeps it checkable rather than magic.
 */
export const payloadCapacityOf = (evidence: readonly VehicleEvidence[]): PayloadCapacity | undefined => {
  const ranked = [...evidence].sort((left, right) => rankOf(left.source) - rankOf(right.source));
  for (const item of ranked) {
    if (item.ratedPayloadKg !== undefined && item.ratedPayloadKg > 0) {
      return { capacityKg: item.ratedPayloadKg, basis: "the payload stated on the record", source: item.source };
    }
    if (item.grossVehicleWeightKg !== undefined && item.unladenWeightKg !== undefined) {
      const difference = item.grossVehicleWeightKg - item.unladenWeightKg;
      if (difference > 0) {
        return {
          capacityKg: difference,
          basis: `gross vehicle weight ${kg(item.grossVehicleWeightKg)} less unladen weight ${kg(item.unladenWeightKg)}`,
          source: item.source,
        };
      }
    }
  }
  return undefined;
};

const rankOf = (source: EvidenceSource): number =>
  source === "GOVERNMENT_RECORD" ? 0 : source === "COMPANY_MASTER" ? 1 : 2;

const sourceWords: Readonly<Record<EvidenceSource, string>> = Object.freeze({
  GOVERNMENT_RECORD: "the vehicle's own registration record",
  COMPANY_MASTER: "your vehicle list",
  ENTERED_BY_HAND: "what was typed in for this movement",
});

/** The class the evidence agrees on, preferring the government's word for it. */
const vehicleClassOf = (evidence: readonly VehicleEvidence[]): { readonly vehicleClass: VehicleClass; readonly source: EvidenceSource } | undefined => {
  const ranked = [...evidence].sort((left, right) => rankOf(left.source) - rankOf(right.source));
  const found = ranked.find((item) => item.vehicleClass !== undefined);
  return found === undefined ? undefined : { vehicleClass: found.vehicleClass as VehicleClass, source: found.source };
};

/**
 * Runs every rule and returns everything it found.
 *
 * Every rule runs, always. Stopping at the first block would send somebody back to the yard once to
 * change the lorry and again to fix the permit, and a dispatch clerk deserves the whole list at
 * once — the same reason the e-way bill payload returns all its problems together.
 */
export const checkVehicleSuitability = (input: SuitabilityInput): SuitabilityResult => {
  const policy = input.policy ?? DEFAULT_VEHICLE_SUITABILITY_POLICY;
  const findings: SuitabilityFinding[] = [];
  const evidence: VehicleEvidence[] = [];
  const { transport, shipment } = input;

  if (input.record?.kind === "FOUND") evidence.push(input.record.evidence);
  if (input.master !== undefined && input.master !== null) evidence.push(input.master);

  checkTransportDetails(transport, findings);
  const capacity = payloadCapacityOf(evidence);
  checkGovernmentRecord(input.record, transport, findings);
  checkClass(evidence, shipment, transport, policy, findings);
  checkCapacity(capacity, evidence, shipment, policy, findings);
  checkBody(evidence, shipment, findings);
  checkPapers(evidence, transport, policy, findings);
  checkPlate(input.plate, policy, findings);

  const outcome = outcomeOf(findings);
  return {
    outcome,
    summary: summaryOf(outcome, findings, transport, shipment, capacity),
    findings,
    evidence,
    ...(capacity === undefined ? {} : { capacity }),
  };
};

/** The worst thing found. `CANNOT_DECIDE` outranks `WARN`: not knowing is worse than knowing. */
export const outcomeOf = (findings: readonly SuitabilityFinding[]): SuitabilityOutcome => {
  if (findings.some((finding) => finding.severity === "BLOCK")) return "BLOCK";
  if (findings.some((finding) => finding.severity === "CANNOT_DECIDE")) return "CANNOT_DECIDE";
  if (findings.some((finding) => finding.severity === "WARN")) return "WARN";
  return "OK";
};

// ------------------------------------------------------------------ the transport details

/**
 * The fields the movement itself carries.
 *
 * A vehicle number the portal will refuse is a block, not a warning: the e-way bill cannot be
 * raised with it, so the goods cannot lawfully leave whatever anybody decides about the load.
 */
const checkTransportDetails = (transport: TransportDetails, findings: SuitabilityFinding[]): void => {
  const road = transport.mode === "ROAD";
  const raw = (transport.vehicleNumber ?? "").trim();
  const number = normaliseVehicleNumber(raw);

  if (road && number === "") {
    findings.push({
      code: "TRANSPORT.VEHICLE_NUMBER.MISSING",
      severity: "CANNOT_DECIDE",
      title: "No vehicle number yet",
      reason: "No vehicle has been entered for this movement, so there is nothing to check the load against. Goods may not move until the vehicle number is on the e-way bill.",
      ruleId: "VS.TRANSPORT.VEHICLE_NUMBER",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Rule 138(5), CGST Rules 2017 — Part B carries the vehicle number",
      appliedFacts: [fact("Mode of transport", "By road")],
      overridable: false,
    });
  } else if (road && !VEHICLE_NUMBER.test(number)) {
    findings.push({
      code: "TRANSPORT.VEHICLE_NUMBER.FORMAT",
      severity: "BLOCK",
      title: "That is not a vehicle number the portal accepts",
      reason: `"${raw}" is not a registration number in the shape the e-way bill portal takes. It should look like KA01AB1234. Until it is corrected the e-way bill cannot carry this vehicle.`,
      ruleId: "VS.TRANSPORT.VEHICLE_NUMBER",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "E-way bill portal Part B field format",
      appliedFacts: [fact("Vehicle number entered", raw)],
      overridable: false,
    });
  }

  const transporterId = (transport.transporterId ?? "").trim().toUpperCase();
  if (transporterId !== "" && !GSTIN.test(transporterId) && !TRANSPORTER_ID.test(transporterId)) {
    findings.push({
      code: "TRANSPORT.TRANSPORTER_ID.FORMAT",
      severity: "BLOCK",
      title: "The transporter's ID is not one the portal will take",
      reason: `"${transport.transporterId}" is neither a GST number nor the 15-character transporter ID given to transporters who have none. The portal refuses the movement with it as it stands.`,
      ruleId: "VS.TRANSPORT.TRANSPORTER_ID",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "E-way bill portal Part A field transporterId",
      appliedFacts: [fact("Transporter ID entered", String(transport.transporterId))],
      overridable: false,
    });
  }

  // A goods receipt with a number and no date, or a date and no number, is half a document. It is
  // worth saying rather than passing on to the portal to be refused.
  const hasDocumentNumber = (transport.transportDocumentNumber ?? "").trim() !== "";
  const hasDocumentDate = (transport.transportDocumentDate ?? "").trim() !== "";
  if (hasDocumentNumber !== hasDocumentDate) {
    findings.push({
      code: "TRANSPORT.DOCUMENT.INCOMPLETE",
      severity: "WARN",
      title: "The transporter's document is half entered",
      reason: hasDocumentNumber
        ? "The transporter's goods receipt has a number but no date. Both go on the e-way bill together."
        : "The transporter's goods receipt has a date but no number. Both go on the e-way bill together.",
      ruleId: "VS.TRANSPORT.DOCUMENT",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [
        fact("Goods receipt number", transport.transportDocumentNumber ?? "not given"),
        fact("Goods receipt date", transport.transportDocumentDate ?? "not given"),
      ],
      overridable: true,
    });
  }

  const distance = transport.distanceKm;
  if (distance !== undefined && (!Number.isFinite(distance) || distance < 0 || distance > 4_000)) {
    findings.push({
      code: "TRANSPORT.DISTANCE.RANGE",
      severity: "BLOCK",
      title: "That distance cannot be right",
      reason: `${distance} km is outside what the e-way bill portal accepts. A road distance has to be between 0 and 4,000 kilometres, and the validity of the permit is worked out from it.`,
      ruleId: "VS.TRANSPORT.DISTANCE",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Rule 138(10), CGST Rules 2017 — validity by distance",
      appliedFacts: [fact("Distance entered", `${distance} km`)],
      overridable: false,
    });
  }
};

// -------------------------------------------------------------- the government's vehicle record

/**
 * What the registering authority said, including its silence.
 *
 * The three outcomes stay three. A vehicle the authority does not hold is a real, checked answer
 * about that lorry and it warns. A lookup that could not be made is not an answer at all, and it
 * goes to a person as `CANNOT_DECIDE` rather than reading as a clean check.
 */
const checkGovernmentRecord = (
  lookup: VehicleRecordLookup | undefined,
  transport: TransportDetails,
  findings: SuitabilityFinding[],
): void => {
  if (lookup === undefined) return;
  const number = normaliseVehicleNumber(transport.vehicleNumber ?? "");

  if (lookup.kind === "UNAVAILABLE") {
    findings.push({
      code: "VEHICLE.RECORD.UNAVAILABLE",
      severity: "CANNOT_DECIDE",
      title: "The vehicle record could not be checked",
      reason: `${lookup.message} This is not the same as the vehicle being fine — nothing about ${number || "this vehicle"} has been verified against the registering authority today. ${lookup.retryable ? "It is worth trying again in a few minutes." : "Trying again straight away will not help."}`,
      ruleId: "VS.RECORD.AVAILABILITY",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [
        fact("Vehicle number", number || "not given"),
        fact("What happened", lookup.code),
        fact("Checked at", lookup.checkedAt),
      ],
      overridable: true,
    });
    return;
  }

  if (lookup.kind === "NOT_FOUND") {
    findings.push({
      code: "VEHICLE.RECORD.NOT_FOUND",
      severity: "WARN",
      title: "No such vehicle on the authority's record",
      reason: `The registering authority answered, and it holds no vehicle with the number ${number}. The lookup worked — this is what it found. Usually the number has been typed wrong; occasionally the vehicle is registered somewhere the service does not cover.`,
      ruleId: "VS.RECORD.AVAILABILITY",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [fact("Vehicle number", number), fact("Checked at", lookup.checkedAt)],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: true,
    });
    return;
  }

  const status = (lookup.evidence.registrationStatus ?? "").trim().toUpperCase();
  if (status !== "" && status !== "ACTIVE") {
    findings.push({
      code: "VEHICLE.REGISTRATION.NOT_ACTIVE",
      severity: "BLOCK",
      title: "This vehicle's registration is not live",
      reason: `The registering authority records this vehicle as "${lookup.evidence.registrationStatus}". A vehicle whose registration is not live has no business on the road with a consignment on it.`,
      ruleId: "VS.RECORD.STATUS",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [fact("Vehicle number", number), fact("Registration status", String(lookup.evidence.registrationStatus))],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: false,
    });
  }
};

// --------------------------------------------------------------------------- class and capacity

/** A scooter is not a small lorry. This is the rule the issue's own example is about. */
const checkClass = (
  evidence: readonly VehicleEvidence[],
  shipment: ShipmentFacts,
  transport: TransportDetails,
  policy: VehicleSuitabilityPolicy,
  findings: SuitabilityFinding[],
): void => {
  if (transport.mode !== "ROAD") return;
  const known = vehicleClassOf(evidence);
  if (known === undefined) return;
  const name = VEHICLE_CLASS_NAMES[known.vehicleClass];

  if (!GOODS_CARRYING_CLASSES.includes(known.vehicleClass)) {
    findings.push({
      code: "VEHICLE.CLASS.NOT_GOODS_CARRYING",
      severity: "BLOCK",
      title: `A ${name} cannot carry this consignment`,
      reason: `${normaliseVehicleNumber(transport.vehicleNumber ?? "")} is registered as a ${name}, which is not a goods vehicle at all. Goods moved on it are being carried in something not registered to carry them, whatever they weigh.`,
      ruleId: "VS.CLASS.GOODS_CARRYING",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Motor Vehicles Act 1988, section 2 — a goods carriage is a vehicle constructed or adapted for carrying goods",
      appliedFacts: [
        fact("Vehicle class", name),
        fact("Where that came from", sourceWords[known.source]),
        ...(shipment.grossWeightKg === undefined ? [] : [fact("Weight being loaded", weight(shipment.grossWeightKg))]),
      ],
      evidenceSource: known.source,
      // Not overridable, and deliberately so: no authorisation makes a scooter able to do this.
      overridable: false,
    });
    return;
  }

  // A goods vehicle of a class that could not physically take this load, whatever its own record
  // says. This catches the case where the individual vehicle's capacity is unknown.
  const ceiling = policy.classCeilingKg[known.vehicleClass];
  if (shipment.grossWeightKg !== undefined && ceiling > 0 && shipment.grossWeightKg > ceiling && payloadCapacityOf(evidence) === undefined) {
    findings.push({
      code: "VEHICLE.CLASS.OVER_CEILING",
      severity: "BLOCK",
      title: `Too heavy for any ${name}`,
      reason: `This load is ${weight(shipment.grossWeightKg)}. We do not hold a capacity for this particular vehicle, but no ${name} carries more than ${weight(ceiling)}, so this cannot go as it stands.`,
      ruleId: "VS.CAPACITY.CLASS_CEILING",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [
        fact("Weight being loaded", weight(shipment.grossWeightKg)),
        fact("Vehicle class", name),
        fact("Most any vehicle of this class carries", weight(ceiling)),
        fact("Where that limit is set", "your company's vehicle suitability settings"),
      ],
      evidenceSource: known.source,
      overridable: false,
    });
  }
};

/**
 * The load against the vehicle's own recorded capacity.
 *
 * Exactly at capacity is not over capacity. The boundary is tested, and it is a "greater than",
 * because a lorry rated for 2,000 kg carrying 2,000 kg is doing precisely what it is rated to do.
 */
const checkCapacity = (
  capacity: PayloadCapacity | undefined,
  evidence: readonly VehicleEvidence[],
  shipment: ShipmentFacts,
  policy: VehicleSuitabilityPolicy,
  findings: SuitabilityFinding[],
): void => {
  if (shipment.grossWeightKg === undefined) {
    findings.push({
      code: "SHIPMENT.WEIGHT.MISSING",
      severity: "CANNOT_DECIDE",
      title: "Nobody has said what this weighs",
      reason: "The weight of the consignment has not been entered, so it cannot be compared against what the vehicle is allowed to carry. A guess here would be a guess about an axle load, so there is none.",
      ruleId: "VS.SHIPMENT.WEIGHT",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: capacity === undefined ? [] : [fact("What this vehicle may carry", weight(capacity.capacityKg))],
      overridable: true,
    });
    return;
  }

  if (capacity === undefined) {
    // Only worth saying when we have not already blocked on the class ceiling above.
    if (!findings.some((finding) => finding.code === "VEHICLE.CLASS.OVER_CEILING")) {
      findings.push({
        code: "VEHICLE.CAPACITY.UNKNOWN",
        severity: "CANNOT_DECIDE",
        title: "We do not know what this vehicle may carry",
        reason: `The load is ${weight(shipment.grossWeightKg)}, and neither the registering authority's record nor your own vehicle list gives a capacity for this vehicle. It has not been checked against anything, which is different from having been checked and passed.`,
        ruleId: "VS.CAPACITY.RECORDED",
        ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
        appliedFacts: [
          fact("Weight being loaded", weight(shipment.grossWeightKg)),
          fact("Capacity on record", "none held"),
        ],
        overridable: true,
      });
    }
    return;
  }

  const load = shipment.grossWeightKg;
  const share = load / capacity.capacityKg;
  if (load > capacity.capacityKg) {
    findings.push({
      code: "VEHICLE.CAPACITY.EXCEEDED",
      severity: policy.overloadSeverity,
      title: "This is more than the vehicle may carry",
      reason: `The load is ${weight(load)} and this vehicle's recorded capacity is ${weight(capacity.capacityKg)} — ${weight(load - capacity.capacityKg)} over. Overloading is what a check post weighs for, and the fine falls on the consignor as much as the driver.`,
      ruleId: "VS.CAPACITY.RECORDED",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Motor Vehicles Act 1988, section 113 — no vehicle may exceed its registered laden weight",
      appliedFacts: [
        fact("Weight being loaded", weight(load)),
        fact("What this vehicle may carry", weight(capacity.capacityKg)),
        fact("How that capacity was arrived at", capacity.basis),
        fact("Where that came from", sourceWords[capacity.source]),
        fact("Over by", weight(load - capacity.capacityKg)),
      ],
      evidenceSource: capacity.source,
      // A recorded capacity can be out of date or wrong, and a person who knows the lorry may say
      // so — with a reason, on the record. It never edits the capacity itself.
      overridable: true,
    });
    return;
  }

  if (share >= policy.warnFromLoadFactor) {
    findings.push({
      code: "VEHICLE.CAPACITY.NEAR_LIMIT",
      severity: "WARN",
      title: "Loaded close to the limit",
      reason: `The load is ${weight(load)} against a capacity of ${weight(capacity.capacityKg)}, which is ${Math.round(share * 100)}% full. Legal, and worth knowing before anything else is added at a stop on the way.`,
      ruleId: "VS.CAPACITY.NEAR_LIMIT",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [
        fact("Weight being loaded", weight(load)),
        fact("What this vehicle may carry", weight(capacity.capacityKg)),
        fact("How full", `${Math.round(share * 100)}%`),
        fact("Warn from", `${Math.round(policy.warnFromLoadFactor * 100)}% full`),
      ],
      evidenceSource: capacity.source,
      overridable: true,
    });
  }
};

/** The body on the chassis: a closed van, an open truck, a tanker, a fridge. */
const checkBody = (
  evidence: readonly VehicleEvidence[],
  shipment: ShipmentFacts,
  findings: SuitabilityFinding[],
): void => {
  const ranked = [...evidence].sort((left, right) => rankOf(left.source) - rankOf(right.source));
  const held = ranked.find((item) => item.bodyType !== undefined);
  if (held === undefined) {
    if (shipment.requiresColdChain === true || shipment.bulkLiquid === true) {
      findings.push({
        code: "VEHICLE.BODY.UNKNOWN",
        severity: "CANNOT_DECIDE",
        title: "We do not know what body this vehicle has",
        reason: shipment.requiresColdChain === true
          ? "These goods have to stay cold, and nothing on record says whether this vehicle is refrigerated. Somebody has to look at the lorry."
          : "This is liquid in bulk, and nothing on record says whether this vehicle is a tanker. Somebody has to look at the lorry.",
        ruleId: "VS.BODY.SUITABILITY",
        ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
        appliedFacts: [fact("Body type on record", "none held")],
        overridable: true,
      });
    }
    return;
  }

  const body = held.bodyType;
  if (shipment.requiresColdChain === true && body !== "refrigerated") {
    findings.push({
      code: "VEHICLE.BODY.NOT_REFRIGERATED",
      severity: "BLOCK",
      title: "These goods need a refrigerated vehicle",
      reason: `This consignment has to stay cold and this vehicle has ${body === "open" ? "an open body" : `a ${body} body`}. The goods would be spoiled by the time they arrived.`,
      ruleId: "VS.BODY.SUITABILITY",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [fact("Body type", String(body)), fact("Where that came from", sourceWords[held.source])],
      evidenceSource: held.source,
      overridable: true,
    });
  }
  if (shipment.bulkLiquid === true && body !== "tanker") {
    findings.push({
      code: "VEHICLE.BODY.NOT_TANKER",
      severity: "BLOCK",
      title: "Liquid in bulk needs a tanker",
      reason: `This consignment is liquid carried in bulk and this vehicle has a ${body} body, which has no way to hold it.`,
      ruleId: "VS.BODY.SUITABILITY",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [fact("Body type", String(body)), fact("Where that came from", sourceWords[held.source])],
      evidenceSource: held.source,
      overridable: true,
    });
  }
  if (shipment.hazardous === true && (body === "open" || body === "two_wheeler" || body === "three_wheeler")) {
    findings.push({
      code: "VEHICLE.BODY.HAZARDOUS",
      severity: "WARN",
      title: "Hazardous goods on an open body",
      reason: `These goods are carried under the hazardous-goods rules and this vehicle has ${body === "open" ? "an open body" : `a ${body.replace("_", "-")} body`}. Check the vehicle is endorsed and the driver trained for them before it leaves.`,
      ruleId: "VS.BODY.HAZARDOUS",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Central Motor Vehicles Rules 1989, rules 129 to 137 — carriage of hazardous goods",
      appliedFacts: [fact("Body type", String(body))],
      evidenceSource: held.source,
      overridable: true,
    });
  }
};

/** Fitness, permit and insurance, all read as at the day the goods actually move. */
const checkPapers = (
  evidence: readonly VehicleEvidence[],
  transport: TransportDetails,
  policy: VehicleSuitabilityPolicy,
  findings: SuitabilityFinding[],
): void => {
  const official = evidence.find((item) => item.source === "GOVERNMENT_RECORD");
  if (official === undefined) return;
  const on = transport.movementDate;

  if (official.fitnessValidUpto !== undefined && official.fitnessValidUpto < on) {
    findings.push({
      code: "VEHICLE.FITNESS.EXPIRED",
      severity: policy.expiredFitnessSeverity,
      title: "The fitness certificate has run out",
      reason: `This vehicle's fitness certificate ran out on ${official.fitnessValidUpto} and the goods move on ${on}. A vehicle without a live fitness certificate is not road-legal that day, whatever else is right about it.`,
      ruleId: "VS.PAPERS.FITNESS",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Motor Vehicles Act 1988, section 56 — certificate of fitness for transport vehicles",
      appliedFacts: [
        fact("Fitness valid until", official.fitnessValidUpto),
        fact("Date of the movement", on),
      ],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: true,
    });
  }

  if (official.insuranceValidUpto !== undefined && official.insuranceValidUpto < on) {
    findings.push({
      code: "VEHICLE.INSURANCE.EXPIRED",
      severity: "WARN",
      title: "The insurance has run out",
      reason: `The insurance on record ran out on ${official.insuranceValidUpto}, before the movement on ${on}. If it has been renewed the record simply has not caught up; if it has not, the consignment is travelling uninsured.`,
      ruleId: "VS.PAPERS.INSURANCE",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [fact("Insurance valid until", official.insuranceValidUpto), fact("Date of the movement", on)],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: true,
    });
  }

  if (official.permitValidUpto !== undefined && official.permitValidUpto < on) {
    findings.push({
      code: "VEHICLE.PERMIT.EXPIRED",
      severity: "WARN",
      title: "The permit has run out",
      reason: `The goods permit on record ran out on ${official.permitValidUpto}, before the movement on ${on}.`,
      ruleId: "VS.PAPERS.PERMIT",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [fact("Permit valid until", official.permitValidUpto), fact("Date of the movement", on)],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: true,
    });
  }

  // The one that catches businesses out: a state permit stops at the state border.
  if (transport.interState === true && (official.permitType === "STATE" || official.permitType === "PRIVATE" || official.permitType === "NONE")) {
    findings.push({
      code: "VEHICLE.PERMIT.WRONG_KIND",
      severity: policy.wrongPermitSeverity,
      title: "This permit does not cross a state border",
      reason: official.permitType === "STATE"
        ? "This vehicle holds a state permit and these goods cross a state border. A state permit does not travel outside the state that issued it — a national permit does."
        : `This vehicle's permit is recorded as "${official.permitType?.toLowerCase()}" and these goods cross a state border, which needs a national permit.`,
      ruleId: "VS.PAPERS.PERMIT_SCOPE",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      sourceRef: "Motor Vehicles Act 1988, sections 66 and 88(9) — national permits for goods carriages",
      appliedFacts: [
        fact("Permit on record", String(official.permitType)),
        fact("Does the journey cross a state border", "Yes"),
      ],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: true,
    });
  }
};

/** What the photograph of the plate said about the number that was typed in. */
const checkPlate = (
  plate: PlateComparison | undefined,
  policy: VehicleSuitabilityPolicy,
  findings: SuitabilityFinding[],
): void => {
  if (plate === undefined) return;
  if (plate.verdict === "MATCH") return;

  if (plate.verdict === "MISMATCH") {
    findings.push({
      code: "VEHICLE.PLATE.MISMATCH",
      severity: policy.plateMismatchSeverity,
      title: "The photograph shows a different vehicle",
      reason: plate.explanation,
      ruleId: "VS.PLATE.COMPARISON",
      ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
      appliedFacts: [
        fact("Number plate in the photograph", plate.readNumber ?? "not read"),
        fact("Vehicle number on the movement", plate.declaredNumber),
        ...(plate.confidence === undefined ? [] : [fact("How sure the reader was", `${Math.round(plate.confidence * 100)}%`)]),
      ],
      evidenceSource: "GOVERNMENT_RECORD",
      overridable: true,
    });
    return;
  }

  findings.push({
    code: plate.verdict === "LOOKALIKE_DIFFERENCE" ? "VEHICLE.PLATE.LOOKALIKE" : "VEHICLE.PLATE.UNREADABLE",
    severity: plate.verdict === "LOOKALIKE_DIFFERENCE" ? "WARN" : "CANNOT_DECIDE",
    title: plate.verdict === "LOOKALIKE_DIFFERENCE" ? "The plate is nearly, not exactly, the number entered" : "The number plate photograph could not be read",
    reason: plate.explanation,
    ruleId: "VS.PLATE.COMPARISON",
    ruleSetVersion: SUITABILITY_RULE_SET_VERSION,
    appliedFacts: [
      fact("Number plate in the photograph", plate.readNumber ?? "not read"),
      fact("Vehicle number on the movement", plate.declaredNumber),
      ...(plate.confidence === undefined ? [] : [fact("How sure the reader was", `${Math.round(plate.confidence * 100)}%`)]),
    ],
    overridable: true,
  });
};

/** One sentence at the top of the screen, before anybody reads a list. */
const summaryOf = (
  outcome: SuitabilityOutcome,
  findings: readonly SuitabilityFinding[],
  transport: TransportDetails,
  shipment: ShipmentFacts,
  capacity: PayloadCapacity | undefined,
): string => {
  const vehicle = normaliseVehicleNumber(transport.vehicleNumber ?? "") || "this vehicle";
  const load = shipment.grossWeightKg === undefined ? "This consignment" : `${weight(shipment.grossWeightKg)}`;
  if (outcome === "OK") {
    return capacity === undefined
      ? `${load} on ${vehicle}: nothing was found against this movement.`
      : `${load} on ${vehicle}, which may carry ${weight(capacity.capacityKg)}. Nothing was found against this movement.`;
  }
  const blocks = findings.filter((finding) => finding.severity === "BLOCK");
  if (outcome === "BLOCK") {
    return `${load} on ${vehicle} cannot go out as it stands: ${blocks[0]?.title.toLowerCase()}${blocks.length > 1 ? `, and ${blocks.length - 1} other thing${blocks.length === 2 ? "" : "s"}` : ""}.`;
  }
  if (outcome === "CANNOT_DECIDE") {
    const unknown = findings.filter((finding) => finding.severity === "CANNOT_DECIDE");
    return `${load} on ${vehicle} has not been checked all the way through: ${unknown[0]?.title.toLowerCase()}. This is not a pass — somebody has to decide.`;
  }
  const warnings = findings.filter((finding) => finding.severity === "WARN");
  return `${load} on ${vehicle} can go, with ${warnings.length} thing${warnings.length === 1 ? "" : "s"} worth a look: ${warnings[0]?.title.toLowerCase()}.`;
};
