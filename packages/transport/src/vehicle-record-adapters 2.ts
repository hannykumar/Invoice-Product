// Issue #29 [E29] — the approved provider behind issue #8's connector, a second provider that
// proves the first one can be swapped, storage, and a synthetic VAHAN for development.
//
// Nothing here needs a production credential to run. The synthetic service below answers with
// VAHAN's own field names and VAHAN's own date formats, including the awkward ones, so that the
// normalising code is exercised against the shapes it will really meet rather than against a tidy
// invention of our own.

import { ConnectorError, type ConnectorGateway, type ConnectorRequest } from "../../platform/src/connectors.ts";
import { normaliseVehicleNumber } from "./validity.ts";
import { normaliseVehicleRecord } from "./vehicle-record.ts";
import { DEFAULT_VEHICLE_RECORD_FRESHNESS } from "./vehicle-record-types.ts";
import type { CompanyId } from "@invoice/kernel";
import type { ExternalConnector, ConnectorResponse } from "../../platform/src/connectors.ts";
import type { IsoDate } from "../../masters/src/types.ts";
import type {
  VehicleLookupPurpose, VehicleRecordConsent, VehicleRecordFreshnessPolicy, VehicleRecordSnapshot,
  VehicleRecordUnavailableCode,
} from "./vehicle-record-types.ts";
import type {
  VehicleRecordCacheRepository, VehicleRecordConsentPort, VehicleRecordFreshnessPort,
  VehicleRecordProviderOutcome, VehicleRecordProviderPort, VehicleRecordRequest,
} from "./vehicle-record-ports.ts";
import type { VahanPayloadFields } from "./vehicle-record.ts";

/** The connector's operation name, so a gateway log line says what was asked for. */
export const VEHICLE_RECORD_OPERATION = "vehicle.record.fetch";

const unavailableFrom = (error: unknown): { code: VehicleRecordUnavailableCode; retryable: boolean; detail: string } => {
  if (error instanceof ConnectorError) {
    if (error.code === "TIMEOUT") return { code: "TIMEOUT", retryable: true, detail: "the provider did not answer in time" };
    if (error.code === "UNAUTHORIZED") return { code: "UNAUTHORIZED", retryable: false, detail: "the provider did not accept our credentials" };
    if (error.code === "INVALID_REQUEST") return { code: "REFUSED", retryable: false, detail: "the provider would not accept the request as it was made" };
    return { code: "OUTAGE", retryable: true, detail: "the provider is not responding" };
  }
  return { code: "OUTAGE", retryable: true, detail: error instanceof Error ? error.message : "the provider could not be reached" };
};

export interface VehicleProviderDeps {
  readonly gateway: ConnectorGateway;
  readonly clock: () => Date;
  /** The adapter's name, written onto every reading. Defaults to the API Setu VAHAN service. */
  readonly provider?: string;
  readonly correlationId?: () => string;
  /** Where this provider's payload keeps each field, when it is not VAHAN's own naming. */
  readonly keys?: VahanPayloadFields;
}

/**
 * The approved vehicle-record provider, reached through issue #8's connector gateway.
 *
 * The gateway owns the credential lookup, the retries and the circuit breaker; this adapter owns
 * the shape of the question and the narrowing of the answer. A different approved provider is a
 * different `provider` name and a different `keys` table, and nothing else in the product moves.
 */
export const apiSetuVehicleAdapter = (deps: VehicleProviderDeps): VehicleRecordProviderPort => {
  const provider = deps.provider ?? "api-setu-vahan";
  return {
    provider,
    async health() {
      try {
        return await deps.gateway.health("vehicle");
      } catch {
        return "unavailable";
      }
    },
    async fetch(request: VehicleRecordRequest): Promise<VehicleRecordProviderOutcome> {
      const number = normaliseVehicleNumber(request.registrationNumber);
      const connectorRequest: ConnectorRequest = {
        tenantId: request.companyId,
        operation: VEHICLE_RECORD_OPERATION,
        payload: {
          registrationNumber: number,
          // The purpose and the field list travel with the request. An approved provider records
          // both on its side, and sending them is what makes our consent record and theirs match.
          purpose: request.purpose,
          fields: [...request.fields],
        },
        idempotencyKey: request.idempotencyKey,
        correlationId: deps.correlationId?.() ?? `vhr-${request.idempotencyKey}`,
      };

      let response: ConnectorResponse;
      try {
        response = await deps.gateway.execute("vehicle", connectorRequest);
      } catch (error) {
        return { kind: "UNAVAILABLE", checkedAt: deps.clock().toISOString(), ...unavailableFrom(error) };
      }

      const retrievedAt = deps.clock().toISOString();
      const body = response.payload;
      const provenance = { provider, providerReference: response.providerRequestId, retrievedAt };

      // "No such vehicle" is an answer, and the providers say it in two different ways: an explicit
      // flag, or an empty record. Both are the authority answering, and neither is a failure.
      const numberKey = deps.keys?.registrationNumberKey ?? "rc_regn_no";
      if (body.notFound === true || (body[numberKey] === undefined && body.errorCode === undefined)) {
        return { kind: "NOT_FOUND", provenance };
      }
      if (typeof body.errorCode === "string") {
        const code = body.errorCode;
        if (code === "404" || code.toUpperCase() === "NO_RECORD") return { kind: "NOT_FOUND", provenance };
        return {
          kind: "UNAVAILABLE",
          code: "REFUSED",
          retryable: false,
          checkedAt: retrievedAt,
          detail: typeof body.errorMessage === "string" ? body.errorMessage : `the provider refused with code ${code}`,
        };
      }

      const normalised = normaliseVehicleRecord(body, {
        registrationNumber: number,
        retrievedAt,
        reference: response.providerRequestId,
        allowedFields: request.fields,
        ...(deps.keys === undefined ? {} : { keys: deps.keys }),
      });
      return { kind: "FOUND", evidence: normalised.evidence, provenance, gaps: normalised.gaps };
    },
  };
};

// -------------------------------------------------------------------------------- storage

export class InMemoryVehicleRecordCache implements VehicleRecordCacheRepository {
  #rows = new Map<string, VehicleRecordSnapshot>();

  #key(companyId: string, registrationNumber: string): string {
    return `${companyId}|${normaliseVehicleNumber(registrationNumber)}`;
  }

  snapshot(): unknown { return new Map(this.#rows); }
  restore(taken: unknown): void { this.#rows = new Map(taken as Map<string, VehicleRecordSnapshot>); }

  async find(companyId: CompanyId, registrationNumber: string): Promise<VehicleRecordSnapshot | null> {
    return this.#rows.get(this.#key(companyId, registrationNumber)) ?? null;
  }

  async save(snapshot: VehicleRecordSnapshot): Promise<void> {
    this.#rows.set(this.#key(snapshot.companyId, snapshot.registrationNumber), Object.freeze(snapshot));
  }

  async list(companyId: CompanyId): Promise<readonly VehicleRecordSnapshot[]> {
    return [...this.#rows.values()].filter((row) => row.companyId === companyId);
  }

  async forget(companyId: CompanyId, registrationNumber: string): Promise<void> {
    this.#rows.delete(this.#key(companyId, registrationNumber));
  }
}

export class InMemoryVehicleRecordConsents implements VehicleRecordConsentPort {
  readonly #rows = new Map<string, VehicleRecordConsent>();

  /**
   * Puts consent in place without going through the service.
   *
   * For fixtures and seeds, where a business is already connected before the scenario starts.
   * Granting it for real goes through `VehicleRecordService.grantConsent`, which is what writes the
   * audit entry — so this is never the path a person's action takes.
   */
  seed(consent: VehicleRecordConsent): void {
    this.#rows.set(`${consent.companyId}|${consent.purpose}`, Object.freeze(consent));
  }

  async current(companyId: CompanyId, purpose: VehicleLookupPurpose): Promise<VehicleRecordConsent | null> {
    return this.#rows.get(`${companyId}|${purpose}`) ?? null;
  }

  async save(consent: VehicleRecordConsent): Promise<void> {
    this.#rows.set(`${consent.companyId}|${consent.purpose}`, Object.freeze(consent));
  }
}

/** Effective-dated freshness rules, per company, like every other policy in this product. */
export class InMemoryVehicleRecordFreshness implements VehicleRecordFreshnessPort {
  readonly #byCompany = new Map<string, VehicleRecordFreshnessPolicy[]>();

  set(companyId: CompanyId, policy: VehicleRecordFreshnessPolicy): void {
    const merged = [...(this.#byCompany.get(companyId) ?? []).filter((candidate) => candidate.effectiveFrom !== policy.effectiveFrom), policy];
    merged.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
    this.#byCompany.set(companyId, merged);
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleRecordFreshnessPolicy> {
    return (this.#byCompany.get(companyId) ?? []).find((policy) => policy.effectiveFrom <= on) ?? DEFAULT_VEHICLE_RECORD_FRESHNESS;
  }
}

// ------------------------------------------------------------- the synthetic VAHAN service

/** One vehicle as the synthetic authority holds it, in the provider's own field names. */
export type VahanRow = Readonly<Record<string, unknown>>;

/**
 * A stand-in for the real service, sitting where the real one will sit.
 *
 * It is an `ExternalConnector`, which means the whole path — gateway, credential lookup, retries,
 * circuit breaker, adapter, normalising, consent, caching — is the same in development as in
 * production, and only the last hop is synthetic. A test that passes here is a test of the real
 * plumbing.
 */
export class SyntheticVahanConnector implements ExternalConnector {
  readonly kind = "vehicle" as const;
  readonly #rows = new Map<string, VahanRow>();
  #mode: "healthy" | "timeout" | "outage" | "unauthorized" = "healthy";
  #calls = 0;

  constructor(rows: readonly VahanRow[] = SYNTHETIC_VAHAN_ROWS) {
    rows.forEach((row) => this.#rows.set(normaliseVehicleNumber(String(row.rc_regn_no ?? "")), row));
  }

  /** How many times the provider was actually asked: the caching tests count this. */
  get calls(): number { return this.#calls; }

  set mode(mode: "healthy" | "timeout" | "outage" | "unauthorized") { this.#mode = mode; }

  async health(): Promise<"healthy" | "degraded" | "unavailable"> {
    return this.#mode === "healthy" ? "healthy" : "unavailable";
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    this.#calls += 1;
    if (this.#mode === "timeout") throw new ConnectorError("TIMEOUT", true);
    if (this.#mode === "outage") throw new ConnectorError("OUTAGE", true);
    if (this.#mode === "unauthorized") throw new ConnectorError("UNAUTHORIZED", false);

    const asked = normaliseVehicleNumber(String(request.payload.registrationNumber ?? ""));
    const row = this.#rows.get(asked);
    const providerRequestId = `VAHAN/${asked}/${request.idempotencyKey.slice(-10)}`;
    if (row === undefined) return { providerRequestId, status: "completed", payload: { notFound: true } };

    // A real provider returns what it holds and lets the caller narrow it; the adapter's field
    // narrowing has to be tested against that, so this deliberately returns everything.
    return { providerRequestId, status: "completed", payload: row };
  }
}

/**
 * The vehicles the demo and the tests run against.
 *
 * Chosen to cover what actually goes wrong: a scooter, a private car, a small goods vehicle whose
 * capacity has to be worked out from gross minus unladen, a proper lorry, a refrigerated truck, one
 * whose class description nothing recognises, and one the record says has been scrapped. The dates
 * are written in three different formats on purpose, because the real service does that too.
 */
export const SYNTHETIC_VAHAN_ROWS: readonly VahanRow[] = Object.freeze([
  {
    rc_regn_no: "KA05MN9012", rc_vh_class_desc: "M-CYCLE/SCOOTER", rc_body_type_desc: "SOLO",
    rc_gvw: "240", rc_unld_wt: "118", rc_permit_type: "NA",
    rc_fit_upto: "31-Mar-2029", rc_insurance_upto: "31/01/2027",
    rc_owner_name: "R Manjunath", rc_status: "ACTIVE",
    // Held by the provider, never requested and never stored by us.
    rc_chasi_no: "MD2A11CZ8KWJ00000", rc_eng_no: "JC50ED0000", rc_present_address: "12 Cross, Bengaluru",
  },
  {
    rc_regn_no: "KA03MC4455", rc_vh_class_desc: "MOTOR CAR", rc_body_type_desc: "CLOSED BODY",
    rc_gvw: "1950", rc_unld_wt: "1450", rc_permit_type: "NOT APPLICABLE",
    rc_fit_upto: "2030-06-30", rc_insurance_upto: "31-May-2027",
    rc_owner_name: "Priya Nair", rc_status: "ACTIVE",
  },
  {
    // Weights written with their unit, the way several states' records do.
    rc_regn_no: "KA02GV3344", rc_vh_class_desc: "LIGHT GOODS VEHICLE", rc_body_type_desc: "CLOSED BODY",
    rc_gvw: "2590 KG", rc_unld_wt: "1340 KG", rc_pyld_wt: "1,250 KG", rc_permit_type: "STATE PERMIT",
    rc_permit_valid_upto: "31-Mar-2027", rc_fit_upto: "30-Sep-2027", rc_insurance_upto: "28-Feb-2027",
    rc_owner_name: "Karnataka Fast Carriers", rc_status: "ACTIVE",
  },
  {
    rc_regn_no: "KA01AB1234", rc_vh_class_desc: "HEAVY GOODS VEHICLE", rc_body_type_desc: "OPEN BODY",
    rc_gvw: "25000", rc_unld_wt: "8600", rc_pyld_wt: "16400", rc_permit_type: "NATIONAL PERMIT",
    rc_permit_valid_upto: "31-Mar-2028", rc_fit_upto: "30-Nov-2027", rc_insurance_upto: "31-Jul-2027",
    rc_owner_name: "Sampoorna Traders Private Limited", rc_status: "ACTIVE",
  },
  {
    rc_regn_no: "KA07RF8899", rc_vh_class_desc: "MEDIUM GOODS VEHICLE", rc_body_type_desc: "REEFER",
    rc_gvw: "12000", rc_unld_wt: "5200", rc_pyld_wt: "6800", rc_permit_type: "NATIONAL PERMIT",
    rc_permit_valid_upto: "31-Mar-2028", rc_fit_upto: "31-Aug-2027", rc_insurance_upto: "30-Sep-2027",
    rc_owner_name: "Cool Chain Logistics LLP", rc_status: "ACTIVE",
  },
  {
    // The record answers, and answers something we do not recognise. It must come back as "we do
    // not know what this is", never as a class picked to fill the gap.
    rc_regn_no: "KA11XX0007", rc_vh_class_desc: "SPECIAL PURPOSE VEHICLE (CRANE)", rc_body_type_desc: "OTHER",
    rc_gvw: "18000", rc_unld_wt: "15000", rc_permit_type: "SPECIAL PERMIT",
    rc_fit_upto: "31-Dec-2027", rc_insurance_upto: "31-Dec-2027",
    rc_owner_name: "Deccan Cranes", rc_status: "ACTIVE",
  },
  {
    // Registered, on record, and not allowed on the road. `NOT_FOUND` would be a lie about it.
    rc_regn_no: "KA04SC7788", rc_vh_class_desc: "GOODS CARRIER", rc_body_type_desc: "OPEN BODY",
    rc_gvw: "7490", rc_unld_wt: "3100", rc_permit_type: "STATE PERMIT",
    rc_permit_valid_upto: "31-Mar-2026", rc_fit_upto: "31-Mar-2026", rc_insurance_upto: "31-Mar-2026",
    rc_owner_name: "Old Yard Transport", rc_status: "SCRAPPED",
  },
]);

/**
 * A second provider, to prove the first one can be replaced.
 *
 * This is the same synthetic data behind a service that names its fields differently — the shape a
 * state transport department's own feed, or a second approved aggregator, would arrive in. Swapping
 * it in changes the `keys` table and the provider name, and nothing else: the same lookups produce
 * the same evidence, which is exactly what the provider-replacement test asserts.
 */
export const ALTERNATE_PROVIDER_KEYS: VahanPayloadFields = Object.freeze({
  registrationNumberKey: "registration_number",
  classKey: "vehicle_class",
  bodyKey: "body_description",
  grossWeightKey: "gross_weight_kg",
  unladenWeightKey: "kerb_weight_kg",
  payloadKey: "payload_kg",
  permitKey: "permit",
  permitValidKey: "permit_expiry",
  fitnessKey: "fitness_expiry",
  insuranceKey: "insurance_expiry",
  ownerKey: "owner",
  statusKey: "status",
});

/** The same vehicles as `SYNTHETIC_VAHAN_ROWS`, in the second provider's own field names. */
export const alternateProviderRows = (rows: readonly VahanRow[] = SYNTHETIC_VAHAN_ROWS): readonly VahanRow[] =>
  rows.map((row) => ({
    // The connector matches on `rc_regn_no`, so it stays; everything the *adapter* reads is renamed.
    rc_regn_no: row.rc_regn_no,
    registration_number: row.rc_regn_no,
    vehicle_class: row.rc_vh_class_desc,
    body_description: row.rc_body_type_desc,
    gross_weight_kg: row.rc_gvw,
    kerb_weight_kg: row.rc_unld_wt,
    payload_kg: row.rc_pyld_wt,
    permit: row.rc_permit_type,
    permit_expiry: row.rc_permit_valid_upto,
    fitness_expiry: row.rc_fit_upto,
    insurance_expiry: row.rc_insurance_upto,
    owner: row.rc_owner_name,
    status: row.rc_status,
  }));
