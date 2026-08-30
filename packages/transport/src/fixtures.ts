/**
 * Issue #27 [E27] — a Bengaluru hardware trader sending steel out, and a shop delivering soap.
 *
 * Every GSTIN is built by `syntheticGstin`: structurally valid, checksum-correct, belonging to
 * nobody. The portal is synthetic and sits behind #8's real gateway, so no production credential is
 * needed to run or test anything here.
 */
import { asId, type Clock, type CompanyId } from "@invoice/kernel";
import { InMemoryAuditPort } from "@invoice/ledger";
import { ConnectorGateway, StaticWebhookVerifier } from "../../platform/src/connectors.ts";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import {
  InMemoryConsolidatedTripStore, InMemoryEwayBillPolicies, InMemoryEwayBillStore,
  SyntheticEwayBillPortal, SyntheticEwayVault, ewayBillAdapter,
} from "./adapters.ts";
import { EwayBillService } from "./service.ts";
import {
  InMemorySuitabilityStore, InMemoryVehicleSuitabilityPolicies, SyntheticPlateReader,
  SyntheticVehicleRecordService, mastersVehicleAdapter,
} from "./suitability-adapters.ts";
import { VehicleSuitabilityService } from "./suitability-service.ts";
import type { ConsignmentLine, Movement, MovementParty, VehicleAssignment } from "./types.ts";
import type { ShipmentFacts, TransportDetails } from "./suitability-types.ts";
import type { Vehicle } from "../../masters/src/types.ts";

export const COMPANY: CompanyId = asId<"Company">("sampoorna");
export const OWNER = asId<"User">("ravi");

export const ALL_EWAY_PERMISSIONS = ["eway.view", "eway.generate", "eway.update", "eway.cancel"];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY) => ({
  companyId, branchId: asId<"Branch">("main"), userId: OWNER, permissions,
});

export const CONSIGNOR_GSTIN = syntheticGstin("29", "AAECS5678D");
export const BUYER_GSTIN = syntheticGstin("27", "AAFCD1234K");
export const KARNATAKA_BUYER_GSTIN = syntheticGstin("29", "AAFCK4321L");

export const CONSIGNOR: MovementParty = {
  legalName: "Sampoorna Traders Private Limited",
  gstin: CONSIGNOR_GSTIN,
  address1: "14, Peenya Industrial Area, Phase 2",
  place: "Bengaluru",
  pincode: "560058",
  stateCode: "29",
};

/** A buyer in Pune: goods crossing a state border, so the national ₹50,000 limit applies. */
export const PUNE_BUYER: MovementParty = {
  legalName: "Deccan Hardware Traders",
  gstin: BUYER_GSTIN,
  address1: "22, Laxmi Road",
  place: "Pune",
  pincode: "411030",
  stateCode: "27",
};

/** A buyer in Mysuru: inside Karnataka, so Karnataka's own limit applies. */
export const MYSURU_BUYER: MovementParty = {
  legalName: "Chamundi Hardware Stores",
  gstin: KARNATAKA_BUYER_GSTIN,
  address1: "3, Sayyaji Rao Road",
  place: "Mysuru",
  pincode: "570001",
  stateCode: "29",
};

/** Steel bar: ₹80,000 of goods with 18% GST, which is ₹94,400 on the lorry. */
export const steelLine = (over: Partial<ConsignmentLine> = {}): ConsignmentLine => ({
  description: "TMT Steel Bar 12mm",
  hsnCode: "72142090",
  quantity: "2000",
  unit: "KGS",
  taxableValuePaise: 80_000_00n,
  cgstPaise: 0n,
  sgstPaise: 0n,
  igstPaise: 14_400_00n,
  cessPaise: 0n,
  ...over,
});

/** Soap moving inside Karnataka: ₹42,372 of goods plus 18%, which is ₹49,999 all in. */
export const soapLine = (over: Partial<ConsignmentLine> = {}): ConsignmentLine => ({
  description: "Herbal Bath Soap 100g",
  hsnCode: "34011190",
  quantity: "500",
  unit: "PCS",
  taxableValuePaise: 42_372_00n,
  cgstPaise: 3_813_50n,
  sgstPaise: 3_813_50n,
  igstPaise: 0n,
  cessPaise: 0n,
  ...over,
});

export const lorry = (over: Partial<VehicleAssignment> = {}): VehicleAssignment => ({
  registrationNumber: "KA01AB1234",
  vehicleType: "REGULAR",
  fromPlace: "Bengaluru",
  fromStateCode: "29",
  ...over,
});

/** Steel going from Bengaluru to Pune: 840 km, two states, well over ₹50,000. */
export const interStateMovement = (over: Partial<Movement> = {}): Movement => ({
  movementId: "mov-001",
  reason: "SUPPLY",
  consignor: CONSIGNOR,
  billTo: PUNE_BUYER,
  documents: [{
    documentId: "inv-001",
    documentType: "TAX_INVOICE",
    documentNumber: "SAM/2026/0117",
    documentDate: "2026-08-21",
    lines: [steelLine()],
  }],
  transportMode: "ROAD",
  vehicleType: "REGULAR",
  conveyance: "OWN_VEHICLE",
  approximateDistanceKm: 840,
  ...over,
});

/** Soap going from Bengaluru to Mysuru: 145 km, one state, just under ₹50,000. */
export const intraStateMovement = (over: Partial<Movement> = {}): Movement => ({
  movementId: "mov-002",
  reason: "SUPPLY",
  consignor: CONSIGNOR,
  billTo: MYSURU_BUYER,
  documents: [{
    documentId: "inv-002",
    documentType: "TAX_INVOICE",
    documentNumber: "SAM/2026/0118",
    documentDate: "2026-08-21",
    lines: [soapLine()],
  }],
  transportMode: "ROAD",
  vehicleType: "REGULAR",
  conveyance: "OWN_VEHICLE",
  approximateDistanceKm: 145,
  ...over,
});

/**
 * The same consignment, but billed to Mumbai and delivered to Hyderabad.
 *
 * Bill-to and ship-to pull in different directions here on purpose: the money goes to Maharashtra
 * and the lorry goes to Telangana, and only the second decides which rules the movement is under.
 */
export const billToShipToMovement = (over: Partial<Movement> = {}): Movement => interStateMovement({
  movementId: "mov-003",
  billTo: { ...PUNE_BUYER, place: "Mumbai", pincode: "400001", stateCode: "27" },
  shipTo: {
    legalName: "Charminar Steel Works",
    gstin: syntheticGstin("36", "AAGCC7788M"),
    address1: "7, Balanagar Industrial Estate",
    place: "Hyderabad",
    pincode: "500037",
    stateCode: "36",
  },
  documents: [{
    documentId: "inv-003",
    documentType: "TAX_INVOICE",
    documentNumber: "SAM/2026/0119",
    documentDate: "2026-08-21",
    lines: [steelLine()],
  }],
  approximateDistanceKm: 570,
  ...over,
});

/**
 * A clock that can be moved forward.
 *
 * Validity, cancellation windows and the eight-hour extension window are all about *time passing*,
 * and a fixed clock cannot test any of them. This keeps one portal and one set of records while
 * the day moves on, which is the only honest way to test an expiry.
 */
export const movableClock = (at: string): Clock & { travelTo(moment: string): void } => {
  let instant = new Date(at);
  return {
    now: () => new Date(instant.getTime()),
    travelTo: (moment: string) => { instant = new Date(moment); },
  };
};

/** A working desk: the portal behind #8's gateway, and somewhere to keep what it said. */
export const makeEwayDesk = (options: { readonly permissions?: readonly string[]; readonly now?: string } = {}) => {
  const clock = movableClock(options.now ?? "2026-08-21T04:30:00.000Z");
  const portal = new SyntheticEwayBillPortal(() => clock.now());
  const gateway = new ConnectorGateway([portal], new SyntheticEwayVault(), new StaticWebhookVerifier());
  const records = new InMemoryEwayBillStore();
  const trips = new InMemoryConsolidatedTripStore();
  const policies = new InMemoryEwayBillPolicies();
  const audit = new InMemoryAuditPort();
  let sequence = 0;

  const service = new EwayBillService({
    portal: ewayBillAdapter({ gateway, clock: () => clock.now() }),
    records, trips, audit, clock, policy: policies,
    idFactory: () => `ewb-${String((sequence += 1)).padStart(4, "0")}`,
  });

  return {
    portal, gateway, records, trips, policies, audit, clock, service,
    actor: actorWith(options.permissions ?? ALL_EWAY_PERMISSIONS),
  };
};

// ------------------------------------------------ issue #28: the load, the lorry, and the check

/** Checking a vehicle, and the separate permission to send it out anyway. */
export const ALL_VEHICLE_PERMISSIONS = ["transport.vehicle.view", "transport.vehicle.check", "transport.vehicle.override"];

/** A movement's transport details as the dispatch desk enters them. */
export const transportDetails = (over: Partial<TransportDetails> = {}): TransportDetails => ({
  mode: "ROAD",
  vehicleNumber: "KA01AB1234",
  transporterId: syntheticGstin("29", "AAJCT9876Q"),
  transporterName: "Deccan Roadlines",
  transportDocumentNumber: "GR/2026/4471",
  transportDocumentDate: "2026-08-21",
  distanceKm: 840,
  interState: true,
  movementDate: "2026-08-21",
  ...over,
});

/** Five tonnes of steel: the load the issue's own example puts on a scooter. */
export const fiveTonneShipment = (over: Partial<ShipmentFacts> = {}): ShipmentFacts => ({
  grossWeightKg: 5_000,
  volumeCubicMetres: 3.2,
  ...over,
});

/**
 * A working dispatch desk: the vehicle record service, the plate reader and somewhere to keep
 * what was found.
 *
 * The vehicle-record service is the synthetic stand-in for issue #29. Swapping it for #29's own
 * adapter when that lands changes this line and nothing else.
 */
export const makeVehicleDesk = (options: { readonly permissions?: readonly string[]; readonly now?: string; readonly vehicles?: readonly Vehicle[] } = {}) => {
  const clock = movableClock(options.now ?? "2026-08-21T04:30:00.000Z");
  const records = new InMemorySuitabilityStore();
  const policies = new InMemoryVehicleSuitabilityPolicies();
  const audit = new InMemoryAuditPort();
  const authority = new SyntheticVehicleRecordService(() => clock.now());
  const plateReader = new SyntheticPlateReader();
  const ownVehicles = options.vehicles ?? [];
  let sequence = 0;

  const service = new VehicleSuitabilityService({
    records,
    audit,
    clock,
    vehicleRecords: authority,
    vehicleMaster: mastersVehicleAdapter(() => ownVehicles, () => clock.now()),
    plateOcr: plateReader,
    policy: policies,
    idFactory: () => `vsc-${String((sequence += 1)).padStart(4, "0")}`,
  });

  return {
    clock, records, policies, audit, authority, plateReader, service,
    actor: actorWith(options.permissions ?? ALL_VEHICLE_PERMISSIONS),
  };
};
