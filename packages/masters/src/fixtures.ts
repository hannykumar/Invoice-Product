// Realistic Indian-business sample data.
//
// Every GSTIN here is synthetic: the PAN block is invented and the check digit is
// computed so the number passes validation without belonging to a real taxpayer. No
// production GSTIN, bank credential or personal detail appears in this repository.

import { gstinCheckDigit } from "./validation.ts";
import type { GstRegistrationType, ItemKind } from "./types.ts";

/** Builds a synthetic but structurally valid GSTIN from a state code and a fake PAN. */
export function syntheticGstin(stateCode: string, pan: string, entity = "1"): string {
  const first14 = `${stateCode}${pan.toUpperCase()}${entity}Z`;
  return `${first14}${gstinCheckDigit(first14)}`;
}

export interface SamplePartySeed {
  readonly code: string;
  readonly legalName: string;
  readonly tradeName?: string;
  readonly role: "customer" | "supplier" | "both";
  readonly gstRegistrationType: GstRegistrationType;
  readonly pan: string;
  readonly stateCode: string;
  readonly city: string;
  readonly pincode: string;
  readonly line1: string;
  readonly phone: string;
  readonly creditDays?: number;
}

export const SAMPLE_PARTIES: readonly SamplePartySeed[] = Object.freeze([
  { code: "ABC", legalName: "ABC Traders", tradeName: "ABC Traders", role: "customer", gstRegistrationType: "regular", pan: "AABCA1234C", stateCode: "29", city: "Bengaluru", pincode: "560001", line1: "14, Avenue Road", phone: "9845012345", creditDays: 30 },
  { code: "SRS", legalName: "Shree Ram Steels Private Limited", tradeName: "Shree Ram Steels", role: "supplier", gstRegistrationType: "regular", pan: "AAECS5678D", stateCode: "27", city: "Pune", pincode: "411001", line1: "Plot 8, MIDC Bhosari", phone: "9822011122", creditDays: 45 },
  { code: "NPT", legalName: "Nandini Provision Stores", role: "customer", gstRegistrationType: "composition", pan: "AFOPN9876E", stateCode: "29", city: "Mysuru", pincode: "570001", line1: "Sayyaji Rao Road", phone: "9880098800" },
  { code: "GEX", legalName: "Gujarat Export House LLP", role: "both", gstRegistrationType: "sez_without_payment", pan: "AAGFG2468F", stateCode: "24", city: "Surat", pincode: "395003", line1: "SEZ Unit 12, Sachin", phone: "9925544332" },
  { code: "WLK", legalName: "Walk-in Customer", role: "customer", gstRegistrationType: "unregistered", pan: "AAAPW1111Z", stateCode: "29", city: "Bengaluru", pincode: "560002", line1: "Counter sale", phone: "9000000001" },
]);

export interface SampleItemSeed {
  readonly code: string;
  readonly name: string;
  readonly kind: ItemKind;
  readonly hsnSac: string;
  readonly baseUnit: string;
  readonly gstRateBasisPoints: number;
  readonly source: string;
  readonly aliases?: readonly string[];
  readonly trackBatches?: boolean;
  /** Item-specific pack size, e.g. one box holds this many base units. */
  readonly unitsPerBox?: bigint;
}

export const SAMPLE_ITEMS: readonly SampleItemSeed[] = Object.freeze([
  { code: "TMT12", name: "TMT Steel Bar 12mm", kind: "goods", hsnSac: "72142090", baseUnit: "KGS", gstRateBasisPoints: 1800, source: "Notification 1/2017-CTR Schedule III, entry 224", aliases: ["12mm sariya", "TMT rod 12"] },
  { code: "CEM53", name: "OPC Cement 53 Grade 50kg Bag", kind: "goods", hsnSac: "25232930", baseUnit: "BAG", gstRateBasisPoints: 2800, source: "Notification 1/2017-CTR Schedule IV, entry 51", aliases: ["cement bag"] },
  { code: "SOAP", name: "Herbal Bath Soap 100g", kind: "goods", hsnSac: "34011190", baseUnit: "PCS", gstRateBasisPoints: 1800, source: "Notification 1/2017-CTR Schedule III, entry 122", trackBatches: true, unitsPerBox: 24n },
  { code: "RICE", name: "Sona Masoori Rice (loose)", kind: "goods", hsnSac: "10063020", baseUnit: "KGS", gstRateBasisPoints: 0, source: "Notification 2/2017-CTR, unbranded cereals" },
  { code: "FRT", name: "Outward Freight", kind: "service", hsnSac: "996511", baseUnit: "NOS", gstRateBasisPoints: 500, source: "Notification 11/2017-CTR, goods transport agency" },
]);

export const SAMPLE_TRANSPORTERS = Object.freeze([
  { name: "Sharma Roadlines", stateCode: "29", pan: "AAFFS4321G", phone: "9448811223" },
  { name: "Konkan Carriers", stateCode: "27", pan: "AAGCK8765H", phone: "9820044556" },
]);

export const SAMPLE_VEHICLES = Object.freeze([
  { registrationNumber: "KA01AB1234", vehicleType: "regular" as const, bodyType: "open" as const, ratedCapacityKg: 9000 },
  { registrationNumber: "MH12CD5678", vehicleType: "regular" as const, bodyType: "container" as const, ratedCapacityKg: 16000 },
  { registrationNumber: "KA05EF9012", vehicleType: "regular" as const, bodyType: "two_wheeler" as const, ratedCapacityKg: 150 },
]);
