// A runnable walkthrough of issue #5: `npm run demo:masters`.
//
// It uses only synthetic data and prints what a reviewer needs in order to check the
// acceptance criteria by eye, without a database or any credentials.

import { AccessControl, AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import { MASTER_APPROVAL_POLICIES, MasterDataService } from "./masters.ts";
import { SAMPLE_ITEMS, SAMPLE_PARTIES, SAMPLE_VEHICLES, syntheticGstin } from "./fixtures.ts";
import { formatQuantity, quantity } from "./units.ts";

const line = (text = "") => console.log(text);
const heading = (text: string) => { line(); line(text); line("-".repeat(text.length)); };

export function runDemo(): void {
  const access = new AccessControl();
  access.grant({ companyId: "demo-company", userId: "demo-owner", branchIds: new Set(["demo-branch"]), active: true, permissions: new Set(["approval.decide", "access.review"]) });
  const audit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit);
  const context = access.context("demo-company", "demo-branch", "demo-owner", "demo-session");
  let counter = 0;
  const key = (label: string) => `demo-${label}-${(counter += 1)}`;

  heading("1. Customers and suppliers, with their GST registrations");
  for (const seed of SAMPLE_PARTIES) {
    const party = masters.createParty(context, {
      code: seed.code, legalName: seed.legalName, role: seed.role, gstRegistrationType: seed.gstRegistrationType,
      pan: seed.pan, phones: [seed.phone], ...(seed.tradeName ? { tradeName: seed.tradeName } : {}),
      ...(seed.creditDays ? { creditDays: seed.creditDays } : {}),
    } as never, { idempotencyKey: key(seed.code), effectiveFrom: "2026-04-01" });
    const gstin = seed.gstRegistrationType === "unregistered" ? undefined : syntheticGstin(seed.stateCode, seed.pan);
    masters.addAddress(context, {
      partyId: party.record.id, label: "Main place of business", line1: seed.line1, city: seed.city,
      stateCode: seed.stateCode, pincode: seed.pincode, use: "both", isPrimary: true, ...(gstin ? { gstin } : {}),
    } as never, { idempotencyKey: key(`${seed.code}-addr`), effectiveFrom: "2026-04-01" });
    line(`  ${seed.legalName.padEnd(40)} ${seed.gstRegistrationType.padEnd(20)} ${gstin ?? "no GST registration"}`);
  }

  heading("2. Items, HSN codes, pack sizes and GST defaults");
  const itemIds = new Map<string, string>();
  for (const seed of SAMPLE_ITEMS) {
    const item = masters.createItem(context, {
      code: seed.code, name: seed.name, kind: seed.kind, hsnSac: seed.hsnSac, baseUnit: seed.baseUnit,
      aliases: seed.aliases ?? [], trackBatches: seed.trackBatches ?? false, trackSerials: false,
    } as never, { idempotencyKey: key(seed.code), effectiveFrom: "2026-04-01" });
    itemIds.set(seed.code, item.record.id);
    if (seed.unitsPerBox) masters.registerItemConversion(context, item.record.id, "BOX", seed.baseUnit, seed.unitsPerBox);
    masters.setTaxDefault(context, { itemId: item.record.id, gstRateBasisPoints: seed.gstRateBasisPoints, reverseCharge: false, source: seed.source } as never, { idempotencyKey: key(`${seed.code}-tax`), effectiveFrom: "2026-04-01" });
    line(`  ${seed.name.padEnd(34)} HSN ${seed.hsnSac.padEnd(10)} ${(seed.gstRateBasisPoints / 100).toFixed(2)}% GST   source: ${seed.source}`);
  }

  heading("3. Speaking a name resolves it, or asks instead of guessing");
  for (const spoken of ["ABC Traders", "Shree Ram Steels", "Traders", "Zenith Polymers"]) {
    const outcome = masters.resolveParty(context, spoken, "2026-04-02");
    const summary = outcome.status === "resolved" ? `resolved to ${outcome.record.legalName} (score ${outcome.score})`
      : outcome.status === "ambiguous" ? `asks the user: ${outcome.candidates.map((candidate) => candidate.record.legalName).join(" or ")}`
      : "not found, so nothing is guessed";
    line(`  "${spoken}" -> ${summary}`);
  }

  heading("4. A near-duplicate is refused until someone confirms");
  try {
    masters.createParty(context, { legalName: "ABC Trader", role: "customer", gstRegistrationType: "regular" } as never, { idempotencyKey: key("dupe"), effectiveFrom: "2026-04-02" });
  } catch (error) {
    line(`  Refused: ${(error as Error).message}`);
  }

  heading("5. Unit conversions are exact, and refuse to round stock");
  const soapId = itemIds.get("SOAP") as string;
  line(`  10 boxes of soap = ${formatQuantity(masters.units.convertExact(quantity("10", "BOX"), "PCS", soapId), 0)}`);
  line(`  2 quintals of rice = ${formatQuantity(masters.units.convertExact(quantity("2", "QTL"), "KGS"), 0)}`);

  heading("6. Changing a master does not rewrite yesterday's document");
  const abc = masters.parties(context, "2026-04-02").find((party) => party.code === "ABC");
  if (abc) {
    const invoiceSnapshot = masters.snapshot(context, "party", abc.id, "2026-05-10");
    masters.updateParty(context, abc.id, { legalName: "ABC Traders and Sons" }, { idempotencyKey: key("rename"), effectiveFrom: "2026-07-01", reason: "Partnership admitted a new partner" });
    line(`  Invoice raised 10 May 2026 still says: ${invoiceSnapshot.facts.legalName as string}`);
    line(`  The customer record today says:        ${masters.party(context, abc.id, "2026-08-01").legalName}`);
    line(`  Change history: ${masters.history(context, "party", abc.id).map((version) => `v${version.version} from ${version.effectiveFrom}`).join(", ")}`);
  }

  heading("7. Vehicles saved for transport checks later (issue #28)");
  for (const vehicle of SAMPLE_VEHICLES) {
    masters.createVehicle(context, { ...vehicle } as never, { idempotencyKey: key(vehicle.registrationNumber), effectiveFrom: "2026-04-01" });
    line(`  ${vehicle.registrationNumber}  ${vehicle.bodyType.padEnd(12)} rated ${vehicle.ratedCapacityKg} kg`);
  }

  heading("Audit");
  line(`  ${audit.forCompany(context).length} audit events recorded for this company, none for any other.`);
  line();
}

if (process.argv[1]?.endsWith("demo.ts")) runDemo();
