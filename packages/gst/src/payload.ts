// Issue #26 [E26] — building the government's schema, and refusing to guess at it.
//
// The payload is where a small omission becomes a rejection three seconds later, so every
// required field is checked here, before the call, and a missing one is reported in the words a
// shopkeeper would use rather than as a schema path. Nothing is defaulted: a missing pin code is
// a question, not a zero.
//
// Money in the government's schema is rupees with two decimals, while everything inside this
// product is `bigint` paise. The conversion happens here, at the boundary, and only here.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";
import { DOCUMENT_TYPE_CODES, financialYearOf } from "./irn.ts";
import type { EInvoiceDocumentType, EInvoiceRecipientKind } from "./einvoice-types.ts";

/** One party as the schema needs it. */
export interface PartyDetails {
  readonly gstin: string;
  readonly legalName: string;
  readonly tradeName?: string;
  readonly address1: string;
  readonly address2?: string;
  readonly location: string;
  readonly pincode: string;
  /** GST state code, "29" for Karnataka. "96" for outside India. */
  readonly stateCode: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface EInvoiceLine {
  readonly lineNumber: number;
  readonly description: string;
  readonly isService: boolean;
  readonly hsnOrSac: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPricePaise: Paise;
  readonly grossAmountPaise: Paise;
  readonly discountPaise: Paise;
  readonly taxableValuePaise: Paise;
  readonly gstRatePercentTimes100: bigint;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
  readonly lineTotalPaise: Paise;
}

export interface EInvoiceDocument {
  readonly documentId: Id;
  readonly documentType: EInvoiceDocumentType;
  readonly documentNumber: string;
  readonly documentDate: IsoDate;
  readonly recipientKind: EInvoiceRecipientKind;
  readonly supplier: PartyDetails;
  readonly recipient: PartyDetails;
  /** Where the goods are actually going, when that differs from the buyer's address. */
  readonly shipTo?: PartyDetails;
  readonly placeOfSupplyStateCode: string;
  readonly reverseCharge: boolean;
  readonly lines: readonly EInvoiceLine[];
  readonly totalTaxableValuePaise: Paise;
  readonly totalCgstPaise: Paise;
  readonly totalSgstPaise: Paise;
  readonly totalIgstPaise: Paise;
  readonly totalCessPaise: Paise;
  readonly roundOffPaise: Paise;
  readonly invoiceValuePaise: Paise;
  /** Only for exports. */
  readonly currency?: string;
  readonly countryCode?: string;
}

/** Paise to the rupee string the schema expects. Exact: no float ever touches this. */
export const toRupees = (paise: Paise): number => {
  const negative = paise < 0n;
  const size = negative ? -paise : paise;
  const whole = size / 100n;
  const fraction = size % 100n;
  return Number(`${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`);
};

export interface PayloadProblem {
  /** The field, in the government's own naming, so a provider error can be matched to it. */
  readonly field: string;
  /** Written for a shopkeeper. */
  readonly message: string;
}

export type PayloadResult =
  | { readonly ok: true; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problems: readonly PayloadProblem[] };

const PINCODE = /^\d{6}$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

const checkParty = (party: PartyDetails | undefined, role: string, prefix: string, problems: PayloadProblem[], needGstin: boolean): void => {
  if (party === undefined) {
    problems.push({ field: prefix, message: `We do not have the ${role}'s details, so this bill cannot be sent to the government.` });
    return;
  }
  if (needGstin && !GSTIN.test((party.gstin ?? "").toUpperCase())) {
    problems.push({ field: `${prefix}.Gstin`, message: `The ${role}'s GST number is missing or is not a valid one.` });
  }
  if ((party.legalName ?? "").trim() === "") {
    problems.push({ field: `${prefix}.LglNm`, message: `The ${role}'s registered name is missing.` });
  }
  if ((party.address1 ?? "").trim() === "") {
    problems.push({ field: `${prefix}.Addr1`, message: `The ${role}'s address is missing.` });
  }
  if ((party.location ?? "").trim() === "") {
    problems.push({ field: `${prefix}.Loc`, message: `The ${role}'s town or city is missing.` });
  }
  // Overseas parties use pin code 999999 and state code 96; everyone else needs a real one.
  if (party.stateCode !== "96" && !PINCODE.test(party.pincode ?? "")) {
    problems.push({ field: `${prefix}.Pin`, message: `The ${role}'s pin code is missing or is not six digits.` });
  }
  if ((party.stateCode ?? "").trim() === "") {
    problems.push({ field: `${prefix}.Stcd`, message: `We do not know which state the ${role} is in, and the tax on this bill depends on it.` });
  }
};

/**
 * Builds the payload, or says exactly what is missing.
 *
 * Every problem is returned at once rather than one per attempt, because a person filling gaps in
 * a form should see all of them, not discover a new one on each submission.
 */
export const buildEInvoicePayload = (document: EInvoiceDocument): PayloadResult => {
  const problems: PayloadProblem[] = [];

  if ((document.documentNumber ?? "").trim() === "") {
    problems.push({ field: "DocDtls.No", message: "This bill has no number yet, and the government will not accept one without it." });
  }
  // The portal rejects a document number with these characters outright.
  if (/[^A-Za-z0-9/-]/.test(document.documentNumber ?? "")) {
    problems.push({ field: "DocDtls.No", message: "A bill number sent to the government may only contain letters, numbers, a slash and a dash." });
  }
  if (document.lines.length === 0) {
    problems.push({ field: "ItemList", message: "There is nothing on this bill, so there is nothing to report." });
  }
  if ((document.placeOfSupplyStateCode ?? "").trim() === "") {
    problems.push({ field: "ValDtls.PosStateCd", message: "We could not work out which state this sale counts as being made in, and the government needs it." });
  }

  checkParty(document.supplier, "your business", "SellerDtls", problems, true);
  const buyerNeedsGstin = document.recipientKind === "B2B" || document.recipientKind === "SEZ_WITH_PAYMENT"
    || document.recipientKind === "SEZ_WITHOUT_PAYMENT" || document.recipientKind === "DEEMED_EXPORT";
  checkParty(document.recipient, "customer", "BuyerDtls", problems, buyerNeedsGstin);

  document.lines.forEach((line, index) => {
    if ((line.hsnOrSac ?? "").trim() === "") {
      problems.push({ field: `ItemList[${index}].HsnCd`, message: `"${line.description}" has no HSN code, and every line sent to the government needs one.` });
    }
    if (line.taxableValuePaise < 0n) {
      problems.push({ field: `ItemList[${index}].AssAmt`, message: `"${line.description}" has a value below zero, which the government will not accept.` });
    }
  });

  if (problems.length > 0) return { ok: false, problems };

  const supplier = document.supplier;
  const recipient = document.recipient;
  const item = (line: EInvoiceLine, index: number): Record<string, unknown> => ({
    SlNo: String(index + 1),
    PrdDesc: line.description,
    IsServc: line.isService ? "Y" : "N",
    HsnCd: line.hsnOrSac,
    Qty: Number(line.quantity),
    Unit: line.unit,
    UnitPrice: toRupees(line.unitPricePaise),
    TotAmt: toRupees(line.grossAmountPaise),
    Discount: toRupees(line.discountPaise),
    AssAmt: toRupees(line.taxableValuePaise),
    GstRt: Number(line.gstRatePercentTimes100) / 100,
    CgstAmt: toRupees(line.cgstPaise),
    SgstAmt: toRupees(line.sgstPaise),
    IgstAmt: toRupees(line.igstPaise),
    CesAmt: toRupees(line.cessPaise),
    TotItemVal: toRupees(line.lineTotalPaise),
  });

  const party = (details: PartyDetails): Record<string, unknown> => ({
    Gstin: details.gstin.toUpperCase(),
    LglNm: details.legalName,
    ...(details.tradeName === undefined ? {} : { TrdNm: details.tradeName }),
    Addr1: details.address1,
    ...(details.address2 === undefined ? {} : { Addr2: details.address2 }),
    Loc: details.location,
    Pin: Number(details.pincode),
    Stcd: details.stateCode,
    ...(details.phone === undefined ? {} : { Ph: details.phone }),
    ...(details.email === undefined ? {} : { Em: details.email }),
  });

  return {
    ok: true,
    payload: {
      Version: "1.1",
      TranDtls: {
        TaxSch: "GST",
        SupTyp: supplyType(document.recipientKind),
        RegRev: document.reverseCharge ? "Y" : "N",
      },
      DocDtls: {
        Typ: DOCUMENT_TYPE_CODES[document.documentType],
        No: document.documentNumber,
        // The portal wants DD/MM/YYYY. Ours are ISO everywhere else; this is the boundary.
        Dt: document.documentDate.split("-").reverse().join("/"),
      },
      SellerDtls: party(supplier),
      BuyerDtls: { ...party(recipient), Pos: document.placeOfSupplyStateCode },
      ...(document.shipTo === undefined ? {} : { ShipDtls: party(document.shipTo) }),
      ItemList: document.lines.map(item),
      ValDtls: {
        AssVal: toRupees(document.totalTaxableValuePaise),
        CgstVal: toRupees(document.totalCgstPaise),
        SgstVal: toRupees(document.totalSgstPaise),
        IgstVal: toRupees(document.totalIgstPaise),
        CesVal: toRupees(document.totalCessPaise),
        RndOffAmt: toRupees(document.roundOffPaise),
        TotInvVal: toRupees(document.invoiceValuePaise),
      },
      ...(document.currency === undefined ? {} : {
        ExpDtls: { CntCode: document.countryCode ?? "", ForCur: document.currency },
      }),
    },
  };
};

/** How the government classifies the sale. Exports and SEZ are their own supply types. */
const supplyType = (kind: EInvoiceRecipientKind): string => {
  switch (kind) {
    case "SEZ_WITH_PAYMENT": return "SEZWP";
    case "SEZ_WITHOUT_PAYMENT": return "SEZWOP";
    case "EXPORT_WITH_PAYMENT": return "EXPWP";
    case "EXPORT_WITHOUT_PAYMENT": return "EXPWOP";
    case "DEEMED_EXPORT": return "DEXP";
    default: return "B2B";
  }
};

/**
 * The same payload as a file a person can keep or upload by hand.
 *
 * The offline route matters more than it looks: when the IRP is down for a day, a business still
 * has to invoice, and a file it can upload later is the difference between working and stopping.
 */
export const toOfflineJson = (document: EInvoiceDocument): string => {
  const built = buildEInvoicePayload(document);
  if (!built.ok) {
    throw new Error(`This bill is not ready to send: ${built.problems[0]?.message ?? "something is missing."}`);
  }
  return JSON.stringify(
    {
      Version: "1.1",
      // The bulk-upload shape the offline utility expects: a list, even for one invoice.
      InvoiceList: [built.payload],
      // Ours, not the government's — so a file found on a desktop can be traced back.
      _karobar: {
        documentId: document.documentId,
        financialYear: financialYearOf(document.documentDate),
        generatedAt: new Date().toISOString(),
        note: "Generated for manual upload. This file is not an e-invoice until the government returns an IRN for it.",
      },
    },
    null,
    2,
  );
};
