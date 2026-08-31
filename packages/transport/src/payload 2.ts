// Issue #27 [E27] — the portal's Part A and Part B, and refusing to guess at either.
//
// Part A is the consignment: who is sending, who is receiving, what is on the lorry and what it is
// worth. Part B is the vehicle. They are separate on the portal and separate here, because they are
// filled in by different people at different times — a consignor can raise Part A in the morning
// and the transporter can add the lorry at four in the afternoon — and because **goods may not move
// on a Part A alone**. Keeping them apart in the code is what keeps that true on the screen.
//
// Money inside this product is always `bigint` paise. The portal wants rupees with two decimals.
// That conversion happens here, at the boundary, and only here.

import { normaliseVehicleNumber, VEHICLE_NUMBER } from "./validity.ts";
import type {
  ConsignmentLine, Movement, MovementParty, MovementReason, TransportMode, VehicleAssignment,
} from "./types.ts";
import type { Paise } from "../../masters/src/types.ts";
import { consignmentValueOf, lineValueWithTax, movementRoute } from "./applicability.ts";

/** Paise to the rupee number the portal's schema expects. Exact: no float ever touches this. */
export const toRupees = (paise: Paise): number => {
  const negative = paise < 0n;
  const size = negative ? -paise : paise;
  return Number(`${negative ? "-" : ""}${size / 100n}.${(size % 100n).toString().padStart(2, "0")}`);
};

export interface PayloadProblem {
  /** The portal's own field name, so its error message can be matched back to it. */
  readonly field: string;
  /** Written for the person who has to fix it. */
  readonly message: string;
}

export type PayloadResult =
  | { readonly ok: true; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problems: readonly PayloadProblem[] };

const PINCODE = /^\d{6}$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;
/** The 15-character id the portal issues to transporters who have no GSTIN. */
const TRANSPORTER_ID = /^[0-9A-Z]{15}$/;

/** The portal's numbers for why goods are moving. */
export const SUB_SUPPLY_CODES: Readonly<Record<MovementReason, string>> = Object.freeze({
  SUPPLY: "1",
  IMPORT: "2",
  EXPORT: "3",
  JOB_WORK: "4",
  FOR_OWN_USE: "5",
  EXHIBITION_OR_FAIRS: "6",
  LINE_SALES: "7",
  SALES_RETURN: "8",
  BRANCH_TRANSFER: "9",
  SKD_CKD: "10",
  OTHERS: "11",
});

export const TRANSPORT_MODE_CODES: Readonly<Record<TransportMode, string>> = Object.freeze({
  ROAD: "1",
  RAIL: "2",
  AIR: "3",
  SHIP: "4",
  NON_MOTORISED: "5",
});

export const DOCUMENT_TYPE_CODES: Readonly<Record<string, string>> = Object.freeze({
  TAX_INVOICE: "INV",
  BILL_OF_SUPPLY: "BIL",
  DELIVERY_CHALLAN: "CHL",
  CREDIT_NOTE: "CNT",
  BILL_OF_ENTRY: "BOE",
});

/**
 * "URP" is what the portal expects for a party with no GST number.
 *
 * It is a real value, not a missing one, and treating a blank as URP would quietly turn "we do not
 * know this customer's GST number" into "this customer has none".
 */
export const UNREGISTERED = "URP";

const checkParty = (party: MovementParty | undefined, role: string, prefix: string, problems: PayloadProblem[]): void => {
  if (party === undefined) {
    problems.push({ field: prefix, message: `We do not have the ${role}'s details, so this e-way bill cannot be raised.` });
    return;
  }
  const gstin = (party.gstin ?? "").trim().toUpperCase();
  if (gstin === "") {
    problems.push({ field: `${prefix}Gstin`, message: `The ${role}'s GST number is missing. If they have none, say so explicitly rather than leaving it blank.` });
  } else if (gstin !== UNREGISTERED && !GSTIN.test(gstin)) {
    problems.push({ field: `${prefix}Gstin`, message: `The ${role}'s GST number is not a valid one.` });
  }
  if ((party.legalName ?? "").trim() === "") problems.push({ field: `${prefix}TrdName`, message: `The ${role}'s name is missing.` });
  if ((party.address1 ?? "").trim() === "") problems.push({ field: `${prefix}Addr1`, message: `The ${role}'s address is missing.` });
  if ((party.place ?? "").trim() === "") problems.push({ field: `${prefix}Place`, message: `The ${role}'s town or city is missing, and the e-way bill has to show where the goods are going.` });
  if (!PINCODE.test(party.pincode ?? "")) problems.push({ field: `${prefix}Pincode`, message: `The ${role}'s pin code is missing or is not six digits.` });
  if ((party.stateCode ?? "").trim() === "") problems.push({ field: `${prefix}StateCode`, message: `We do not know which state the ${role} is in, and the e-way bill rules depend on it.` });
};

/** Part B on its own, checked the same way whether it goes in now or in four hours. */
export const checkVehicle = (vehicle: VehicleAssignment | undefined, mode: TransportMode, problems: PayloadProblem[]): void => {
  if (vehicle === undefined) {
    problems.push({ field: "vehicleNo", message: "No vehicle has been entered yet. Goods may not move until the vehicle number is on the e-way bill." });
    return;
  }
  const number = normaliseVehicleNumber(vehicle.registrationNumber ?? "");
  if (number === "") {
    problems.push({ field: "vehicleNo", message: "The vehicle number is missing." });
  } else if (mode === "ROAD" && !VEHICLE_NUMBER.test(number)) {
    problems.push({ field: "vehicleNo", message: `"${vehicle.registrationNumber}" is not a vehicle number the portal accepts. It should look like KA01AB1234.` });
  }
  if ((vehicle.fromPlace ?? "").trim() === "") {
    problems.push({ field: "fromPlace", message: "We need the place the vehicle is picking the goods up from." });
  }
};

export interface PartABuildOptions {
  /** Kilometres by road. The portal takes 0 to mean "work it out from the pin codes". */
  readonly distanceKm?: number;
}

/**
 * Builds Part A, or says exactly what is missing.
 *
 * Every problem comes back at once. A person filling gaps in a form should see all of them, not
 * find a new one on each attempt while a lorry waits in the yard.
 */
export const buildPartA = (movement: Movement, options: PartABuildOptions = {}): PayloadResult => {
  const problems: PayloadProblem[] = [];
  const primary = movement.documents[0];

  if (primary === undefined) {
    return { ok: false, problems: [{ field: "docNo", message: "There is no bill or delivery challan against this movement, and an e-way bill has to name one." }] };
  }
  if ((primary.documentNumber ?? "").trim() === "") {
    problems.push({ field: "docNo", message: "The bill or challan travelling with these goods has no number yet." });
  }
  if (/[^A-Za-z0-9/-]/.test(primary.documentNumber ?? "")) {
    problems.push({ field: "docNo", message: "A document number on an e-way bill may only contain letters, numbers, a slash and a dash." });
  }
  if (primary.lines.length === 0) {
    problems.push({ field: "itemList", message: "There is nothing listed on this movement, so there is nothing to raise an e-way bill for." });
  }

  const route = movementRoute(movement);
  checkParty(movement.dispatchFrom ?? movement.consignor, "sender", "from", problems);
  checkParty(movement.shipTo ?? movement.billTo, "receiver", "to", problems);

  primary.lines.forEach((line, index) => {
    if ((line.hsnCode ?? "").trim() === "") {
      problems.push({ field: `itemList[${index}].hsnCode`, message: `"${line.description}" has no HSN code, and every line on an e-way bill needs one.` });
    }
    if (line.taxableValuePaise < 0n) {
      problems.push({ field: `itemList[${index}].taxableAmount`, message: `"${line.description}" has a value below zero, which the portal will not accept.` });
    }
  });

  const distance = options.distanceKm ?? movement.approximateDistanceKm;
  if (distance !== undefined && (!Number.isFinite(distance) || distance < 0 || distance > 4000)) {
    problems.push({ field: "transDistance", message: "The distance has to be between 0 and 4,000 kilometres. Leave it at zero to let the portal work it out from the pin codes." });
  }

  const transporter = movement.transporter;
  if (transporter !== undefined) {
    const id = (transporter.transporterId ?? "").trim().toUpperCase();
    if (!GSTIN.test(id) && !TRANSPORTER_ID.test(id)) {
      problems.push({ field: "transporterId", message: `"${transporter.transporterId}" is not a transporter ID the portal accepts. It is either the transporter's GST number or the 15-character ID given to transporters without one.` });
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const from = movement.dispatchFrom ?? movement.consignor;
  const to = movement.shipTo ?? movement.billTo;
  const value = consignmentValueOf(movement.documents);
  const totals = totalsOf(movement.documents.flatMap((document) => document.lines));

  return {
    ok: true,
    payload: {
      supplyType: movement.reason === "SALES_RETURN" || movement.reason === "IMPORT" ? "I" : "O",
      subSupplyType: SUB_SUPPLY_CODES[movement.reason],
      docType: DOCUMENT_TYPE_CODES[primary.documentType] ?? "OTH",
      docNo: primary.documentNumber,
      // The portal wants DD/MM/YYYY. Ours are ISO everywhere else; this is the boundary.
      docDate: primary.documentDate.split("-").reverse().join("/"),
      fromGstin: (movement.consignor.gstin ?? "").toUpperCase(),
      fromTrdName: movement.consignor.legalName,
      fromAddr1: from.address1,
      ...(from.address2 === undefined ? {} : { fromAddr2: from.address2 }),
      fromPlace: from.place,
      fromPincode: Number(from.pincode),
      // Where the goods actually start, which is not always the billing address of the sender.
      actFromStateCode: from.stateCode,
      fromStateCode: movement.consignor.stateCode,
      toGstin: (movement.billTo.gstin ?? "").toUpperCase(),
      toTrdName: movement.billTo.legalName,
      toAddr1: to.address1,
      ...(to.address2 === undefined ? {} : { toAddr2: to.address2 }),
      toPlace: to.place,
      toPincode: Number(to.pincode),
      // Likewise: where the goods really go, kept apart from where the bill goes.
      actToStateCode: to.stateCode,
      toStateCode: movement.billTo.stateCode,
      totalValue: toRupees(totals.taxableValuePaise),
      cgstValue: toRupees(totals.cgstPaise),
      sgstValue: toRupees(totals.sgstPaise),
      igstValue: toRupees(totals.igstPaise),
      cessValue: toRupees(totals.cessPaise),
      totInvValue: toRupees(value.valuePaise + value.excludedPaise),
      transactionType: movement.shipTo === undefined ? 1 : 2,
      transDistance: String(distance ?? 0),
      transMode: TRANSPORT_MODE_CODES[movement.transportMode],
      ...(transporter === undefined ? {} : {
        transporterId: transporter.transporterId.toUpperCase(),
        transporterName: transporter.name,
        ...(transporter.documentNumber === undefined ? {} : { transDocNo: transporter.documentNumber }),
        ...(transporter.documentDate === undefined ? {} : { transDocDate: transporter.documentDate.split("-").reverse().join("/") }),
      }),
      itemList: movement.documents.flatMap((document) => document.lines).map((line, index) => ({
        itemNo: index + 1,
        productName: line.description,
        hsnCode: line.hsnCode,
        quantity: Number(line.quantity),
        qtyUnit: line.unit,
        taxableAmount: toRupees(line.taxableValuePaise),
        cgstRate: rateOf(line.cgstPaise, line.taxableValuePaise),
        sgstRate: rateOf(line.sgstPaise, line.taxableValuePaise),
        igstRate: rateOf(line.igstPaise, line.taxableValuePaise),
        cessRate: rateOf(line.cessPaise, line.taxableValuePaise),
      })),
      _route: { fromStateCode: route.fromStateCode, toStateCode: route.toStateCode },
    },
  };
};

/** Part B: the vehicle, and why it is this vehicle rather than the last one. */
export const buildPartB = (
  ewayBillNumber: string,
  vehicle: VehicleAssignment,
  mode: TransportMode,
  options: { readonly transporterDocumentNumber?: string; readonly transporterDocumentDate?: string } = {},
): PayloadResult => {
  const problems: PayloadProblem[] = [];
  checkVehicle(vehicle, mode, problems);
  if (ewayBillNumber.trim() === "") {
    problems.push({ field: "ewbNo", message: "There is no e-way bill number to add a vehicle to." });
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    payload: {
      ewbNo: Number(ewayBillNumber),
      vehicleNo: normaliseVehicleNumber(vehicle.registrationNumber),
      fromPlace: vehicle.fromPlace,
      fromState: vehicle.fromStateCode,
      transMode: TRANSPORT_MODE_CODES[mode],
      vehicleType: vehicle.vehicleType === "ODC" ? "O" : "R",
      reasonCode: VEHICLE_CHANGE_CODES[vehicle.reason ?? "FIRST_TIME"],
      reasonRem: vehicle.reasonNote ?? "",
      ...(options.transporterDocumentNumber === undefined ? {} : { transDocNo: options.transporterDocumentNumber }),
      ...(options.transporterDocumentDate === undefined ? {} : { transDocDate: options.transporterDocumentDate.split("-").reverse().join("/") }),
    },
  };
};

export const VEHICLE_CHANGE_CODES: Readonly<Record<string, string>> = Object.freeze({
  FIRST_TIME: "1",
  BREAKDOWN: "2",
  TRANSSHIPMENT: "3",
  OTHERS: "4",
});

const totalsOf = (lines: readonly ConsignmentLine[]) => lines.reduce(
  (sum, line) => ({
    taxableValuePaise: sum.taxableValuePaise + line.taxableValuePaise,
    cgstPaise: sum.cgstPaise + line.cgstPaise,
    sgstPaise: sum.sgstPaise + line.sgstPaise,
    igstPaise: sum.igstPaise + line.igstPaise,
    cessPaise: sum.cessPaise + line.cessPaise,
  }),
  { taxableValuePaise: 0n, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n, cessPaise: 0n },
);

/** The tax rate a line's tax works out to, as the portal's percentage. Zero taxable, zero rate. */
const rateOf = (taxPaise: Paise, taxableValuePaise: Paise): number => {
  if (taxableValuePaise === 0n) return 0;
  // Basis points first, so the division is integer and the rounding is ours rather than a float's.
  return Number((taxPaise * 10_000n) / taxableValuePaise) / 100;
};

/**
 * Part A as a file, for the day the portal is down and the lorry still has to leave.
 *
 * The file says inside itself that it is not an e-way bill. A JSON file on a desk that looks like a
 * permit is worse than no file at all: goods moved on it would be moving without one.
 */
export const toOfflineJson = (movement: Movement, options: PartABuildOptions = {}): string => {
  const built = buildPartA(movement, options);
  if (!built.ok) throw new Error(`This movement is not ready to send: ${built.problems[0]?.message ?? "something is missing."}`);
  const { _route: _ignored, ...portalFields } = built.payload as Record<string, unknown>;
  return JSON.stringify({
    version: "1.0.0621",
    billLists: [portalFields],
    _karobar: {
      movementId: movement.movementId,
      generatedAt: new Date().toISOString(),
      note: "Prepared for manual upload to the e-way bill portal. This file is not an e-way bill. Goods must not move on it until the portal has given a number.",
    },
  }, null, 2);
};

export { lineValueWithTax };
