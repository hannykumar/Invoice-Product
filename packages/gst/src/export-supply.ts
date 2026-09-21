// Issue #143 — exports and supplies to SEZ, as the paper bill has to say them.
//
// The e-invoice payload already classified these five kinds; the printed bill knew nothing about
// them. Both now read this one table, so the supply type the government is told and the title,
// endorsement and tax treatment the customer is handed cannot disagree. GSTR-1's treatment for the
// same sale is in the table too, so the return reads it from here as well.
//
// The endorsement wording is the one CGST Rule 46 prescribes for exports and SEZ supplies. It is
// printed as the law words it, not paraphrased.

import type { SupplyTreatment } from "@invoice/gst-returns";
import type { IsoDate, Paise } from "../../masters/src/types.ts";
import type { EInvoiceRecipientKind } from "./einvoice-types.ts";

export type ExportSupplyKind = Exclude<EInvoiceRecipientKind, "B2B" | "B2C">;

export interface ExportSupplyClass {
  /** `SupTyp` on the e-invoice. */
  readonly eInvoiceSupplyType: "EXPWP" | "EXPWOP" | "SEZWP" | "SEZWOP" | "DEXP";
  /** How GSTR-1 reports the same sale. */
  readonly returnTreatment: SupplyTreatment;
  readonly title: { readonly "en-IN": string; readonly "hi-IN": string };
  readonly endorsement: string;
  /**
   * Zero-rated under section 16 of the IGST Act: always integrated tax, and without payment when
   * made under bond or a letter of undertaking (LUT). A deemed export is not zero-rated; it is
   * taxed like any other sale and the buyer claims the refund.
   */
  readonly zeroRated: boolean;
  /** False only for a zero-rated supply made under bond or LUT, which carries no tax at all. */
  readonly taxPaid: boolean;
  /** The goods leave India, so a country of destination and a foreign currency can apply. */
  readonly abroad: boolean;
}

const WITH_TAX = "ON PAYMENT OF INTEGRATED TAX";
const UNDER_LUT = "UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";
const EXPORT_TITLE = { "en-IN": "Tax Invoice — Export", "hi-IN": "Tax invoice — Export (niryat)" } as const;
const SEZ_TITLE = { "en-IN": "Tax Invoice — Supply to SEZ", "hi-IN": "Tax invoice — SEZ ko supply" } as const;

export const EXPORT_SUPPLIES: Readonly<Record<ExportSupplyKind, ExportSupplyClass>> = {
  EXPORT_WITH_PAYMENT: {
    eInvoiceSupplyType: "EXPWP", returnTreatment: "EXPORT_WITH_TAX", title: EXPORT_TITLE,
    endorsement: `SUPPLY MEANT FOR EXPORT ${WITH_TAX}`, zeroRated: true, taxPaid: true, abroad: true,
  },
  EXPORT_WITHOUT_PAYMENT: {
    eInvoiceSupplyType: "EXPWOP", returnTreatment: "EXPORT_WITHOUT_TAX", title: EXPORT_TITLE,
    endorsement: `SUPPLY MEANT FOR EXPORT ${UNDER_LUT}`, zeroRated: true, taxPaid: false, abroad: true,
  },
  SEZ_WITH_PAYMENT: {
    eInvoiceSupplyType: "SEZWP", returnTreatment: "SEZ_WITH_TAX", title: SEZ_TITLE,
    endorsement: `SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ${WITH_TAX}`, zeroRated: true, taxPaid: true, abroad: false,
  },
  SEZ_WITHOUT_PAYMENT: {
    eInvoiceSupplyType: "SEZWOP", returnTreatment: "SEZ_WITHOUT_TAX", title: SEZ_TITLE,
    endorsement: `SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ${UNDER_LUT}`, zeroRated: true, taxPaid: false, abroad: false,
  },
  DEEMED_EXPORT: {
    eInvoiceSupplyType: "DEXP", returnTreatment: "DEEMED_EXPORT",
    title: { "en-IN": "Tax Invoice — Deemed Export", "hi-IN": "Tax invoice — Deemed export" },
    endorsement: "SUPPLY REGARDED AS DEEMED EXPORT UNDER NOTIFICATION 48/2017-CENTRAL TAX",
    zeroRated: false, taxPaid: true, abroad: false,
  },
};

export const isExportSupplyKind = (kind: string): kind is ExportSupplyKind => Object.hasOwn(EXPORT_SUPPLIES, kind);

/**
 * The kind of supply a customer's master record implies (#5's registration types).
 *
 * An SEZ customer's record already says whether the business supplies it under LUT. A customer
 * overseas does not: that is the seller's choice for each sale, so it is asked for. `null` means an
 * ordinary domestic sale.
 */
export const exportSupplyKindFor = (registration: string, underLut: boolean): ExportSupplyKind | null => {
  switch (registration) {
    case "overseas": return underLut ? "EXPORT_WITHOUT_PAYMENT" : "EXPORT_WITH_PAYMENT";
    case "sez_with_payment": return "SEZ_WITH_PAYMENT";
    case "sez_without_payment": return "SEZ_WITHOUT_PAYMENT";
    case "deemed_export": return "DEEMED_EXPORT";
    default: return null;
  }
};

/** The facts about one export or SEZ sale that the bill and the e-invoice both carry. */
export interface ExportParticulars {
  readonly kind: ExportSupplyKind;
  /** ISO 3166 two-letter code, e.g. "AE". Exports only. */
  readonly countryCode?: string;
  /** ISO 4217 code, e.g. "USD". Exports only; absent means the sale was in rupees. */
  readonly currency?: string;
  /** Rupees for one unit of `currency`, as typed: "83.25". Never a float. */
  readonly exchangeRate?: string;
  /** Usually filed after the bill, so it is optional; when given, all three parts are needed. */
  readonly shippingBill?: { readonly number: string; readonly date: IsoDate; readonly portCode: string };
}

export interface ExportProblem {
  readonly field: string;
  /** Written for a shopkeeper. */
  readonly message: string;
}

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const RATE = /^(\d{1,6})(?:\.(\d{1,4}))?$/;

/** The country's name, or `null` when the code is not a country. */
export const countryName = (code: string): string | null => {
  if (!/^[A-Z]{2}$/.test(code) || code === "IN") return null;
  const name = COUNTRY_NAMES.of(code);
  return name === undefined || name === code || name === "Unknown Region" ? null : name;
};

/** Every problem at once, so a person filling the form sees them all together. */
export const checkExportParticulars = (particulars: ExportParticulars): ExportProblem[] => {
  const problems: ExportProblem[] = [];
  const supply = EXPORT_SUPPLIES[particulars.kind];
  const currency = particulars.currency ?? "INR";
  if (supply.abroad) {
    if (countryName(particulars.countryCode ?? "") === null) {
      problems.push({ field: "countryCode", message: "Say which country the goods are going to, as its two-letter code — AE for the United Arab Emirates, US for the United States." });
    }
    if (!CURRENCIES.has(currency)) {
      problems.push({ field: "currency", message: `${currency} is not a currency code. Use the three letters the bank uses, such as USD or AED.` });
    }
    if (currency !== "INR" && !exchangeRateIsValid(particulars.exchangeRate)) {
      problems.push({ field: "exchangeRate", message: `Type how many rupees one ${currency} was worth for this sale, such as 83.25.` });
    }
  } else if (particulars.countryCode !== undefined || currency !== "INR") {
    problems.push({ field: "currency", message: "A supply to an SEZ or a deemed export is billed in rupees inside India, so it has no foreign currency or country." });
  }
  const bill = particulars.shippingBill;
  if (bill !== undefined) {
    if (!/^[A-Za-z0-9/-]{1,20}$/.test(bill.number)) {
      problems.push({ field: "shippingBill.number", message: "The shipping bill number may only have letters, numbers, a slash and a dash, and at most 20 of them." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bill.date)) {
      problems.push({ field: "shippingBill.date", message: "Give the date on the shipping bill." });
    }
    if (!/^[A-Z]{2}[A-Z0-9]{4}$/.test(bill.portCode)) {
      problems.push({ field: "shippingBill.portCode", message: "The port code is the six letters and numbers customs uses for the port, such as INNSA1 for Nhava Sheva." });
    }
  }
  return problems;
};

const exchangeRateIsValid = (rate: string | undefined): boolean => rate !== undefined && RATE.test(rate) && exchangeRateTimes10000(rate) > 0n;

/** "83.25" as 832500n: exact to four places, never through a float. */
const exchangeRateTimes10000 = (rate: string): bigint => {
  const [, whole = "0", fraction = ""] = RATE.exec(rate) ?? [];
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
};

/** The invoice value in the foreign currency, to the cent, rounded half up. */
export const foreignValue = (invoiceValuePaise: Paise, exchangeRate: string): string => {
  const rate = exchangeRateTimes10000(exchangeRate);
  const cents = (invoiceValuePaise * 10000n * 2n + rate) / (rate * 2n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

/** What the printed bill carries. Built only from the table and the checked particulars. */
export interface PrintedExportSupply {
  readonly kind: ExportSupplyKind;
  readonly title: { readonly "en-IN": string; readonly "hi-IN": string };
  readonly endorsement: string;
  readonly zeroRated: boolean;
  readonly taxPaid: boolean;
  readonly country: string | null;
  readonly currency: { readonly code: string; readonly exchangeRate: string; readonly invoiceValue: string } | null;
  readonly shippingBill: { readonly number: string; readonly date: IsoDate; readonly portCode: string } | null;
}

export const printedExportSupply = (particulars: ExportParticulars, invoiceValuePaise: Paise): PrintedExportSupply => {
  const problems = checkExportParticulars(particulars);
  if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(" "));
  const supply = EXPORT_SUPPLIES[particulars.kind];
  const code = particulars.currency ?? "INR";
  return {
    kind: particulars.kind,
    title: supply.title,
    endorsement: supply.endorsement,
    zeroRated: supply.zeroRated,
    taxPaid: supply.taxPaid,
    country: supply.abroad ? countryName(particulars.countryCode ?? "") : null,
    currency: code === "INR" || particulars.exchangeRate === undefined
      ? null
      : { code, exchangeRate: particulars.exchangeRate, invoiceValue: foreignValue(invoiceValuePaise, particulars.exchangeRate) },
    shippingBill: particulars.shippingBill ?? null,
  };
};
