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
  mastersVehicleAdapter,
} from "./suitability-adapters.ts";
import { VehicleSuitabilityService } from "./suitability-service.ts";
import {
  InMemoryVehicleRecordCache, InMemoryVehicleRecordConsents, InMemoryVehicleRecordFreshness,
  SYNTHETIC_VAHAN_ROWS, SyntheticVahanConnector, apiSetuVehicleAdapter,
} from "./vehicle-record-adapters.ts";
import {
  TRANSPORT_SUITABILITY_PURPOSE, VEHICLE_RECORD_CONNECT_PERMISSION, VehicleRecordService,
} from "./vehicle-record-service.ts";
import { PERMITTED_VEHICLE_FIELDS } from "./vehicle-record-types.ts";
import type { VahanRow } from "./vehicle-record-adapters.ts";
import type { VahanPayloadFields } from "./vehicle-record.ts";
import type { PermittedVehicleField } from "./vehicle-record-types.ts";
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
 * A working dispatch desk: the registering authority behind issue #29's verification, the plate
 * reader, and somewhere to keep what was found.
 *
 * The authority is reached the way production reaches it — issue #29's service, over issue #8's
 * connector gateway, with a synthetic VAHAN at the far end. Only the last hop is fake, so a test
 * that passes here has exercised the consent check, the field narrowing, the caching and the
 * masking rather than stepping over them.
 */
export const makeVehicleDesk = (options: { readonly permissions?: readonly string[]; readonly now?: string; readonly vehicles?: readonly Vehicle[] } = {}) => {
  const clock = movableClock(options.now ?? "2026-08-21T04:30:00.000Z");
  const records = new InMemorySuitabilityStore();
  const policies = new InMemoryVehicleSuitabilityPolicies();
  const audit = new InMemoryAuditPort();
  const plateReader = new SyntheticPlateReader();
  const ownVehicles = options.vehicles ?? [];
  const actor = actorWith(options.permissions ?? ALL_VEHICLE_PERMISSIONS);
  let sequence = 0;

  const desk = makeVehicleRecordDesk({ clock, audit, actor });

  const service = new VehicleSuitabilityService({
    records,
    audit,
    clock,
    // Issue #29's own service, seen through the port issue #28 was written against. The lookups a
    // suitability check makes are attributed to the clerk who ran the check.
    vehicleRecords: desk.service.portFor(actor),
    vehicleMaster: mastersVehicleAdapter(() => ownVehicles, () => clock.now()),
    plateOcr: plateReader,
    policy: policies,
    idFactory: () => `vsc-${String((sequence += 1)).padStart(4, "0")}`,
  });

  return {
    clock, records, policies, audit, plateReader, service, actor,
    // What the tests reach for when they need the authority to misbehave.
    authority: desk.authority,
    vehicleRecords: desk.service,
    vehicleRecordCache: desk.cache,
  };
};

/** Somebody allowed to switch the government service on: a separate permission from checking. */
export const ALL_VEHICLE_RECORD_PERMISSIONS = [...ALL_VEHICLE_PERMISSIONS, VEHICLE_RECORD_CONNECT_PERMISSION];

/**
 * Issue #29's verification on its own, with consent already granted.
 *
 * `authority` is the synthetic VAHAN: `goDown()` and `comeBack()` are how a test makes the outage
 * happen on purpose rather than waiting for one.
 */
export const makeVehicleRecordDesk = (options: {
  readonly clock?: Clock & { travelTo(moment: string): void };
  readonly audit?: InMemoryAuditPort;
  readonly actor?: ReturnType<typeof actorWith>;
  readonly now?: string;
  readonly rows?: readonly VahanRow[];
  readonly keys?: VahanPayloadFields;
  readonly provider?: string;
  readonly grantConsent?: boolean;
  readonly fields?: readonly PermittedVehicleField[];
} = {}) => {
  const clock = options.clock ?? movableClock(options.now ?? "2026-08-21T04:30:00.000Z");
  const audit = options.audit ?? new InMemoryAuditPort();
  const connector = new SyntheticVahanConnector(options.rows ?? SYNTHETIC_VAHAN_ROWS);
  const gateway = new ConnectorGateway([connector], new SyntheticEwayVault(), new StaticWebhookVerifier());
  const cache = new InMemoryVehicleRecordCache();
  const consent = new InMemoryVehicleRecordConsents();
  const freshness = new InMemoryVehicleRecordFreshness();

  const service = new VehicleRecordService({
    provider: apiSetuVehicleAdapter({
      gateway,
      clock: () => clock.now(),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.keys === undefined ? {} : { keys: options.keys }),
    }),
    cache, consent, audit, clock, freshness,
  });

  const actor = options.actor ?? actorWith(ALL_VEHICLE_RECORD_PERMISSIONS);
  // A business that is already connected when the scenario starts. Granting consent for real goes
  // through the service and is exercised in issue #29's own tests; seeding it here keeps every
  // other test from beginning with a piece of setup that is not what it is about.
  if (options.grantConsent ?? true) {
    consent.seed({
      companyId: actor.companyId,
      purpose: TRANSPORT_SUITABILITY_PURPOSE,
      fields: [...(options.fields ?? PERMITTED_VEHICLE_FIELDS)],
      grantedBy: OWNER,
      grantedAt: clock.now().toISOString(),
      credentialReference: "vault://vehicle/sampoorna",
    });
  }

  return {
    clock, audit, cache, consent, freshness, gateway, service, actor,
    authority: {
      /** The provider stops answering. A different thing from it saying "no such vehicle". */
      goDown: () => { connector.mode = "outage"; },
      timeOut: () => { connector.mode = "timeout"; },
      refuseCredentials: () => { connector.mode = "unauthorized"; },
      comeBack: () => { connector.mode = "healthy"; },
      get calls() { return connector.calls; },
    },
  };
};
