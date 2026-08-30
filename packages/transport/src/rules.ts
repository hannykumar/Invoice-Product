// Issue #27 [E27] — the money limits, and whose limit each one is.
//
// This file exists so that "does this need an e-way bill?" is answered from a table with dates and
// sources on it, rather than from a number somebody remembers. The distinction that matters:
//
//   - **Between two states** the limit is ₹50,000, and it is national. Rule 138(1) of the CGST
//     Rules, in force everywhere since 1 April 2018.
//   - **Inside one state** the limit is that state's own. Several states set ₹1 lakh, which is
//     where the "₹1 lakh" belief comes from — but it belongs to Punjab, Chandigarh, Delhi,
//     Rajasthan, Bihar, West Bengal, Jharkhand, Maharashtra and Tamil Nadu, not to the country,
//     and never to a *day*.
//
// Every state and union territory is in the table below, so choosing a state on any screen applies
// that state's own rule rather than a national approximation. Three things vary between them and
// all three are held as data:
//
//   1. the money limit,
//   2. the date the state's own rule came into force,
//   3. whether the state's rule is about money at all — Gujarat exempts movement inside one city at
//      any value, and several states ask for a bill only for the goods on their own notified list.
//
// Assumption recorded on purpose: these figures and dates are transcribed from the state orders
// named against each entry. They are the values this product ships with, not values it discovered.
// Where we hold the state's figure and date but not its notification number, `sourceConfirmed` is
// false and every screen says so, so nobody mistakes a shipped default for a checked citation.

import type { ValueThreshold } from "./types.ts";

export const EWAY_RULE_SET_VERSION = "in.gst.ewaybill.2026.2";

/** ₹50,000. The national limit for goods crossing a state border. */
export const INTER_STATE_THRESHOLD: ValueThreshold = Object.freeze({
  scope: "IN",
  thresholdPaise: 50_000_00n,
  effectiveFrom: "2018-04-01",
  sourceRef: "Rule 138(1), CGST Rules 2017; Notification 12/2018 - Central Tax, 7 March 2018",
  ruleId: "EWB.THRESHOLD.INTER_STATE",
});

/**
 * What a state asks for movement that starts and ends inside it.
 *
 * `intraCityExemptAnyValue` and `notifiedGoodsOnly` are not flourishes. Gujarat exempts movement
 * within one city whatever it is worth, so there the question "is this within one city?" decides
 * the answer before the money does. Madhya Pradesh, Chhattisgarh, Goa and Jharkhand ask for a bill
 * only for goods on their own notified lists, so a decision in those states says plainly that the
 * list has to be checked before anyone relies on a "yes".
 */
export interface StateIntraStateRule extends ValueThreshold {
  readonly stateName: string;
  readonly kind: JurisdictionKind;
  readonly intraCityExemptAnyValue?: boolean;
  readonly notifiedGoodsOnly?: boolean;
  /** True when this row carries the state's actual notification number. */
  readonly sourceConfirmed: boolean;
}

/**
 * What a GST state code actually is.
 *
 * India has 28 states and 8 union territories, and the codes do not stop there: two of them belong
 * to jurisdictions that no longer exist, and one is not a place people live in at all. Calling the
 * whole list "states" is wrong and this is where that is kept straight:
 *
 *   - `STATE` — one of the 28 states.
 *   - `UNION_TERRITORY` — one of the 8 union territories. Delhi, Chandigarh and the rest.
 *   - `RETIRED` — a code that is no longer issued: 25 (Daman and Diu, folded into 26 in 2020) and
 *     28 (undivided Andhra Pradesh, split into 36 and 37 in 2014). Kept because a document raised
 *     years ago still carries the old code, and it must still resolve to the right rule.
 *   - `OTHER_TERRITORY` — code 97, which the portal uses for offshore areas and anything outside
 *     the states and union territories. Not a place anybody picks off a list.
 */
export type JurisdictionKind = "STATE" | "UNION_TERRITORY" | "RETIRED" | "OTHER_TERRITORY";

/** Every GST state code, so a code on a screen always has a name behind it. */
export const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (before division)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  // Not a state. The portal uses it for a party outside India, and no intra-state rule can apply.
  "96": "Outside India",
});

/** The name for a code, or the code itself when it is one we do not know. */
export const stateName = (code: string): string => STATE_NAMES[code] ?? `state ${code}`;

const FIFTY_THOUSAND = 50_000_00n;
const ONE_LAKH = 1_00_000_00n;

const state = (
  code: string,
  thresholdPaise: bigint,
  effectiveFrom: string,
  sourceRef: string,
  extra: {
    readonly kind?: JurisdictionKind;
    readonly sourceConfirmed?: boolean;
    readonly note?: string;
    readonly intraCityExemptAnyValue?: boolean;
    readonly notifiedGoodsOnly?: boolean;
  } = {},
): StateIntraStateRule => Object.freeze({
  scope: code,
  stateName: stateName(code),
  kind: extra.kind ?? "STATE",
  thresholdPaise,
  effectiveFrom,
  sourceRef,
  ruleId: `EWB.THRESHOLD.INTRA_STATE.${code}`,
  sourceConfirmed: extra.sourceConfirmed ?? false,
  ...(extra.note === undefined ? {} : { note: extra.note }),
  ...(extra.intraCityExemptAnyValue === undefined ? {} : { intraCityExemptAnyValue: extra.intraCityExemptAnyValue }),
  ...(extra.notifiedGoodsOnly === undefined ? {} : { notifiedGoodsOnly: extra.notifiedGoodsOnly }),
});

/** For the rows where we hold the date but not the notification number. */
const stateOrder = (code: string, on: string): string =>
  `${stateName(code)} notification under the proviso to Rule 138(1), in force from ${on}. This table does not hold the notification number for this state — confirm it with the state before relying on it.`;

const NOTIFIED_GOODS_NOTE = "This state asks for an e-way bill only for the goods on its own notified list. Check that list before deciding these particular goods need one.";

/**
 * Intra-state limits for every state and union territory, by GST state code.
 *
 * Nothing falls through to a national approximation any more: choosing a state applies that
 * state's own row. The national fallback below survives only for a code that is not a state at
 * all — a typo, or a party outside India — and it says that is what happened.
 */
export const INTRA_STATE_RULES: Readonly<Record<string, StateIntraStateRule>> = Object.freeze({
  "01": state("01", FIFTY_THOUSAND, "2018-11-16", stateOrder("01", "16 November 2018"), { kind: "UNION_TERRITORY" }),
  "02": state("02", FIFTY_THOUSAND, "2018-04-15", stateOrder("02", "15 April 2018")),
  "03": state("03", ONE_LAKH, "2018-06-01", "Punjab Notification GST-I-2018/3, 19 April 2018", { sourceConfirmed: true }),
  "04": state("04", ONE_LAKH, "2018-06-01", stateOrder("04", "1 June 2018"), { kind: "UNION_TERRITORY" }),
  "05": state("05", FIFTY_THOUSAND, "2018-04-20", stateOrder("05", "20 April 2018")),
  "06": state("06", FIFTY_THOUSAND, "2018-04-20", "Haryana Notification 49/ST-2, 19 April 2018", { sourceConfirmed: true }),
  "07": state("07", ONE_LAKH, "2018-06-16", "Delhi Notification F.3(46)/Fin(Rev-I)/2017-18, 15 June 2018", { kind: "UNION_TERRITORY", sourceConfirmed: true }),
  "08": state("08", ONE_LAKH, "2019-04-01", "Rajasthan Notification F.17(131)ACCT/GST/2017/3743, 6 August 2018 as amended", { sourceConfirmed: true }),
  "09": state("09", FIFTY_THOUSAND, "2018-04-15", "Uttar Pradesh Notification 38/2018, 11 April 2018", { sourceConfirmed: true }),
  "10": state("10", ONE_LAKH, "2018-04-20", "Bihar Notification S.O. 130, 19 April 2018", { sourceConfirmed: true }),
  "11": state("11", FIFTY_THOUSAND, "2018-04-25", stateOrder("11", "25 April 2018")),
  "12": state("12", FIFTY_THOUSAND, "2018-04-25", stateOrder("12", "25 April 2018")),
  "13": state("13", FIFTY_THOUSAND, "2018-05-01", stateOrder("13", "1 May 2018")),
  "14": state("14", FIFTY_THOUSAND, "2018-05-25", stateOrder("14", "25 May 2018")),
  "15": state("15", FIFTY_THOUSAND, "2018-06-01", stateOrder("15", "1 June 2018")),
  "16": state("16", FIFTY_THOUSAND, "2018-04-20", stateOrder("16", "20 April 2018")),
  "17": state("17", FIFTY_THOUSAND, "2018-04-25", stateOrder("17", "25 April 2018")),
  "18": state("18", FIFTY_THOUSAND, "2018-05-16", stateOrder("18", "16 May 2018")),
  "19": state("19", ONE_LAKH, "2018-06-06", "West Bengal Notification 13/2018 - C.T./GST, 6 June 2018", { sourceConfirmed: true }),
  "20": state("20", ONE_LAKH, "2018-04-20", stateOrder("20", "20 April 2018"), { notifiedGoodsOnly: true, note: NOTIFIED_GOODS_NOTE }),
  "21": state("21", FIFTY_THOUSAND, "2018-06-01", "Odisha Notification 15918-FIN-CT1-TAX-0022/2017, 31 May 2018", { sourceConfirmed: true }),
  "22": state("22", FIFTY_THOUSAND, "2018-06-01", stateOrder("22", "1 June 2018"), { notifiedGoodsOnly: true, note: NOTIFIED_GOODS_NOTE }),
  "23": state("23", FIFTY_THOUSAND, "2018-04-25", stateOrder("23", "25 April 2018"), { notifiedGoodsOnly: true, note: NOTIFIED_GOODS_NOTE }),
  "24": state("24", FIFTY_THOUSAND, "2018-04-15", "Gujarat Notification GSL/GST/RULE-138(14)/B.12, 11 April 2018", {
    sourceConfirmed: true,
    intraCityExemptAnyValue: true,
    note: "Gujarat asks for no e-way bill at all when the goods stay inside one city, whatever they are worth.",
  }),
  "25": state("25", FIFTY_THOUSAND, "2018-06-01", stateOrder("25", "1 June 2018"), {
    kind: "RETIRED",
    note: "This code belongs to the old Daman and Diu. Since 26 January 2020 the union territory uses code 26.",
  }),
  "26": state("26", FIFTY_THOUSAND, "2018-06-01", stateOrder("26", "1 June 2018"), { kind: "UNION_TERRITORY" }),
  "27": state("27", ONE_LAKH, "2018-07-01", "Maharashtra Notification 15E/2018 - State Tax, 29 June 2018", { sourceConfirmed: true }),
  "28": state("28", FIFTY_THOUSAND, "2018-04-15", stateOrder("28", "15 April 2018"), {
    kind: "RETIRED",
    note: "This code belongs to undivided Andhra Pradesh and is no longer issued. Andhra Pradesh is 37 and Telangana is 36.",
  }),
  "29": state("29", FIFTY_THOUSAND, "2018-04-01", "Karnataka Notification 01/2018 - State Tax, 25 March 2018", { sourceConfirmed: true }),
  "30": state("30", FIFTY_THOUSAND, "2018-06-01", stateOrder("30", "1 June 2018"), { notifiedGoodsOnly: true, note: NOTIFIED_GOODS_NOTE }),
  "31": state("31", FIFTY_THOUSAND, "2018-06-01", stateOrder("31", "1 June 2018"), { kind: "UNION_TERRITORY" }),
  "32": state("32", FIFTY_THOUSAND, "2018-04-15", "Kerala Notification 3/2018 - State Tax, 12 April 2018", { sourceConfirmed: true }),
  "33": state("33", ONE_LAKH, "2018-06-02", "Tamil Nadu Notification 09/2018 - (Rate)/G.O. (Ms) No. 72, 31 May 2018", { sourceConfirmed: true }),
  "34": state("34", FIFTY_THOUSAND, "2018-04-25", stateOrder("34", "25 April 2018"), { kind: "UNION_TERRITORY" }),
  "35": state("35", FIFTY_THOUSAND, "2018-06-01", stateOrder("35", "1 June 2018"), { kind: "UNION_TERRITORY" }),
  "36": state("36", FIFTY_THOUSAND, "2018-04-15", stateOrder("36", "15 April 2018")),
  "37": state("37", FIFTY_THOUSAND, "2018-04-15", stateOrder("37", "15 April 2018")),
  "38": state("38", FIFTY_THOUSAND, "2019-10-31", stateOrder("38", "31 October 2019"), { kind: "UNION_TERRITORY" }),
  "97": state("97", FIFTY_THOUSAND, "2018-06-01", stateOrder("97", "1 June 2018"), { kind: "OTHER_TERRITORY" }),
});

/**
 * Every row in the table, in code order.
 *
 * This is 39 rows and that is **not** 39 states: it is 28 states, 8 union territories, 2 codes that
 * are no longer issued, and code 97 for other territory. Use `LIVE_JURISDICTIONS` for anything a
 * person picks from, and this one for looking up a code that arrived on a document.
 */
export const ALL_STATE_RULES: readonly StateIntraStateRule[] = Object.freeze(
  Object.values(INTRA_STATE_RULES).sort((left, right) => (left.scope < right.scope ? -1 : 1)),
);

/** The 36 places that exist today — 28 states and 8 union territories. What a picker offers. */
export const LIVE_JURISDICTIONS: readonly StateIntraStateRule[] = Object.freeze(
  ALL_STATE_RULES.filter((rule) => rule.kind === "STATE" || rule.kind === "UNION_TERRITORY"),
);

/** Codes that are no longer issued, kept so an old document still resolves to the right rule. */
export const RETIRED_CODES: readonly StateIntraStateRule[] = Object.freeze(
  ALL_STATE_RULES.filter((rule) => rule.kind === "RETIRED"),
);

/** How many of each kind the table holds, for anything that wants to say so out loud. */
export const jurisdictionCounts = (): Readonly<Record<"states" | "unionTerritories" | "retired" | "otherTerritory", number>> => ({
  states: ALL_STATE_RULES.filter((rule) => rule.kind === "STATE").length,
  unionTerritories: ALL_STATE_RULES.filter((rule) => rule.kind === "UNION_TERRITORY").length,
  retired: RETIRED_CODES.length,
  otherTerritory: ALL_STATE_RULES.filter((rule) => rule.kind === "OTHER_TERRITORY").length,
});

/**
 * The intra-state rule for a state on a date.
 *
 * A state order that has not come into force yet on the movement's date does not apply to it, so a
 * back-dated movement is judged by the rules that were actually in force when the lorry left — and
 * before a state had its own rule, the national ₹50,000 is what stood.
 */
export const intraStateRuleFor = (
  stateCode: string,
  on: string,
): ValueThreshold & { readonly stateName?: string; readonly intraCityExemptAnyValue?: boolean; readonly notifiedGoodsOnly?: boolean; readonly sourceConfirmed?: boolean } => {
  const rule = INTRA_STATE_RULES[stateCode];
  if (rule === undefined) {
    return {
      ...INTER_STATE_THRESHOLD,
      scope: stateCode,
      ruleId: "EWB.THRESHOLD.INTRA_STATE.UNKNOWN_STATE",
      note: `"${stateCode}" is not a GST state code we know, so the national ₹50,000 limit has been used. Check the state code on the movement.`,
    };
  }
  if (rule.effectiveFrom > on) {
    return {
      ...INTER_STATE_THRESHOLD,
      scope: stateCode,
      ruleId: "EWB.THRESHOLD.INTRA_STATE.BEFORE_STATE_RULE",
      note: `${rule.stateName} had no e-way bill rule of its own until ${rule.effectiveFrom}, so the national ₹50,000 limit applied on this date.`,
    };
  }
  return rule;
};

/**
 * Goods the rules exempt from e-way bills whatever they are worth.
 *
 * Listed by the HSN chapter or heading the annexure to Rule 138(14) names, so a caller that knows
 * only the HSN code can still get the right answer. The list is deliberately not exhaustive — it
 * covers what a small business actually moves — and an item can always be marked exempt on the
 * line itself when it is not here.
 */
export const EWAY_EXEMPT_GOODS: readonly { readonly prefix: string; readonly label: string; readonly sourceRef: string }[] = Object.freeze([
  { prefix: "71", label: "jewellery, goldsmiths' and silversmiths' wares, and precious stones", sourceRef: "Annexure to Rule 138(14), serial 4 and 5" },
  { prefix: "0301", label: "live fish", sourceRef: "Annexure to Rule 138(14)" },
  { prefix: "2711", label: "liquefied petroleum gas supplied to household and non-domestic exempted customers", sourceRef: "Annexure to Rule 138(14), serial 6" },
  { prefix: "2710", label: "kerosene oil sold under the public distribution system", sourceRef: "Annexure to Rule 138(14), serial 7" },
  { prefix: "3101", label: "organic manure", sourceRef: "Notification 2/2017 - Central Tax (Rate)" },
  { prefix: "4907", label: "currency, cheques and postal items", sourceRef: "Annexure to Rule 138(14), serial 9" },
]);

/** The exemption an HSN code falls under, if any. */
export const exemptGoodsFor = (hsnCode: string): { readonly label: string; readonly sourceRef: string } | null => {
  const code = hsnCode.trim();
  const found = EWAY_EXEMPT_GOODS.find((entry) => code.startsWith(entry.prefix));
  return found === undefined ? null : { label: found.label, sourceRef: found.sourceRef };
};
