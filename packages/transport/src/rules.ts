// Issue #27 [E27] — the money limits, and whose limit each one is.
//
// This file exists so that "does this need an e-way bill?" is answered from a table with dates and
// notification numbers on it, rather than from a number somebody remembers. The distinction that
// matters:
//
//   - **Between two states** the limit is ₹50,000, and it is national. Rule 138(1) of the CGST
//     Rules, in force everywhere since 1 April 2018.
//   - **Inside one state** the limit is that state's own, set by that state's own order — and the
//     orders differ in kind, not only in amount. Some states set ₹1 lakh. Some ask for a bill only
//     for a listed set of goods. Two union territories ask for none at all. One exempts movement
//     inside a city whatever it is worth. Another sets a higher limit inside a city.
//
// So "₹1 lakh a day" is wrong twice over: ₹1 lakh belongs to the states that set it, and nothing
// anywhere is measured per day.
//
// **Every row is effective-dated and a state can have several**, because these orders keep moving:
// West Bengal came down from ₹1 lakh to ₹50,000 on 1 December 2023, Madhya Pradesh went up from
// ₹50,000 to ₹1 lakh in March 2022, and five union territories were exempted on 1 April 2018 and
// three of them un-exempted seven weeks later. A movement is judged under the rule in force on its
// own date, which is the only way an old document can still be explained.
//
// Sources: each row names the state order behind it. They were transcribed in August 2026 from the
// published compilations at cleartax.in and taxguru.in, with the union territory notifications,
// Gujarat's B.19, Chandigarh's 3/2018 and 7/2018, Jammu and Kashmir's 64 and Kerala's gold circular
// checked against the notification texts themselves. `sourceKind` says what kind of thing each
// citation is, because a press release is not a notification and should not be shown as one.

import type { ValueThreshold } from "./types.ts";

export const EWAY_RULE_SET_VERSION = "in.gst.ewaybill.2026.3";

/** ₹50,000. The national limit for goods crossing a state border. */
export const INTER_STATE_THRESHOLD: ValueThreshold = Object.freeze({
  scope: "IN",
  thresholdPaise: 50_000_00n,
  effectiveFrom: "2018-04-01",
  sourceRef: "Rule 138(1), CGST Rules 2017; Notification 12/2018 - Central Tax, 7 March 2018",
  ruleId: "EWB.THRESHOLD.INTER_STATE",
});

/**
 * What a GST state code actually is.
 *
 * India has 28 states and 8 union territories, and the codes do not stop there: two belong to
 * jurisdictions that no longer exist, and one is not a place people live in at all.
 */
export type JurisdictionKind = "STATE" | "UNION_TERRITORY" | "RETIRED" | "OTHER_TERRITORY";

/**
 * What kind of thing the citation is.
 *
 * Several states rolled the e-way bill out by press release and never issued a numbered
 * notification for it, and a few we simply do not hold. Saying which is which on the screen stops
 * a press release from being read as a gazette reference.
 */
export type SourceKind = "NOTIFICATION" | "PRESS_RELEASE" | "NOT_HELD";

/** One state's rule as it stood from one date until the next row replaced it. */
export interface StateIntraStateRule extends ValueThreshold {
  readonly stateName: string;
  readonly kind: JurisdictionKind;
  readonly sourceKind: SourceKind;
  /** No e-way bill at all inside this jurisdiction, whatever the consignment is worth. */
  readonly exemptAnyValue?: boolean;
  /** No e-way bill when the goods stay inside one city, whatever they are worth. Gujarat. */
  readonly intraCityExemptAnyValue?: boolean;
  /** A different, higher limit when the goods stay inside one city. Rajasthan. */
  readonly intraCityThresholdPaise?: bigint;
  /** The state asks for a bill only for goods on its own notified list. */
  readonly notifiedGoodsOnly?: boolean;
  /** The state's limit applies to everything except a listed set of goods. */
  readonly excludedGoodsNote?: string;
  /** Set where the state requires a bill for goods the national annexure exempts. Kerala's gold. */
  readonly overridesExemptGoods?: string;
  /** The value from which that state wants a bill for those goods. Kerala's ₹10 lakh on gold. */
  readonly preciousGoodsThresholdPaise?: bigint;
}

/** Every GST state code, so a code on a screen always has a name behind it. */
export const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "25": "Daman and Diu", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
  "28": "Andhra Pradesh (before division)", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep",
  "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
  // Not a state. The portal uses it for a party outside India, and no intra-state rule can apply.
  "96": "Outside India",
});

const UNION_TERRITORIES = new Set(["01", "04", "07", "26", "31", "34", "35", "38"]);
const RETIRED = new Set(["25", "28"]);

/** The name for a code, or the code itself when it is one we do not know. */
export const stateName = (code: string): string => STATE_NAMES[code] ?? `state ${code}`;

const kindOf = (code: string): JurisdictionKind =>
  code === "97" ? "OTHER_TERRITORY" : RETIRED.has(code) ? "RETIRED" : UNION_TERRITORIES.has(code) ? "UNION_TERRITORY" : "STATE";

const FIFTY_THOUSAND = 50_000_00n;
const ONE_LAKH = 1_00_000_00n;
const TWO_LAKH = 2_00_000_00n;

type RuleInput = Omit<StateIntraStateRule, "scope" | "stateName" | "kind" | "ruleId" | "thresholdPaise"> & {
  readonly thresholdPaise?: bigint;
};

const rule = (code: string, input: RuleInput): StateIntraStateRule => Object.freeze({
  scope: code,
  stateName: stateName(code),
  kind: kindOf(code),
  ruleId: `EWB.THRESHOLD.INTRA_STATE.${code}.${input.effectiveFrom}`,
  // An exemption has no threshold to compare against; ₹50,000 is carried only so the shape holds.
  thresholdPaise: input.thresholdPaise ?? FIFTY_THOUSAND,
  ...input,
});

const NOTIFIED_GOODS_NOTE = "This state asks for an e-way bill only for the goods on its own notified list. Check that list before deciding these particular goods need one.";

/**
 * Every state and union territory, newest rule first.
 *
 * Read `intraStateRuleFor(code, date)` rather than this map: it picks the row that was in force on
 * the day the goods moved.
 */
export const INTRA_STATE_RULES: Readonly<Record<string, readonly StateIntraStateRule[]>> = Object.freeze({
  // No e-way bill at all inside the union territory, at any value.
  "01": [rule("01", {
    effectiveFrom: "2019-12-01", exemptAnyValue: true, sourceKind: "NOTIFICATION",
    sourceRef: "Jammu and Kashmir Notification 64, 30 November 2019",
    note: "Jammu and Kashmir asks for no e-way bill at all when the goods start and finish inside the union territory. Goods crossing its border still need one.",
  })],
  "02": [rule("02", {
    effectiveFrom: "2018-06-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Himachal Pradesh Notification 12-4/78-EXN-TAX-17408, 31 May 2018",
  })],
  "03": [rule("03", {
    effectiveFrom: "2018-09-13", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
    sourceRef: "Punjab Notification PA/ETC/2018/175, 13 September 2018",
  })],
  "04": [
    rule("04", {
      effectiveFrom: "2018-05-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "Notification 7/2018 - Union Territory Tax, 18 May 2018",
      note: "Chandigarh's blanket exemption of 1 April 2018 was withdrawn seven weeks later and the ordinary ₹50,000 limit put back.",
    }),
    rule("04", {
      effectiveFrom: "2018-04-01", exemptAnyValue: true, sourceKind: "NOTIFICATION",
      sourceRef: "Notification 3/2018 - Union Territory Tax, 31 March 2018",
    }),
  ],
  "05": [rule("05", {
    effectiveFrom: "2018-04-17", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Uttarakhand Notification 239/CSTUK/GST-Vidhi/2018-19, 17 April 2018",
  })],
  "06": [rule("06", {
    effectiveFrom: "2018-04-20", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Haryana Notification 49/ST-2, 19 April 2018",
  })],
  "07": [rule("07", {
    effectiveFrom: "2018-06-16", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
    sourceRef: "Delhi Notification 03, 15 June 2018",
  })],
  "08": [rule("08", {
    effectiveFrom: "2022-02-24", thresholdPaise: ONE_LAKH, intraCityThresholdPaise: TWO_LAKH,
    sourceKind: "NOTIFICATION", sourceRef: "Rajasthan Notification 02/2022, 24 February 2022",
    note: "Rajasthan sets ₹1,00,000 inside the state and a higher ₹2,00,000 when the goods stay inside one city.",
    excludedGoodsNote: "Rajasthan's higher limits do not cover the goods its order lists separately; check that list for these goods.",
  })],
  "09": [rule("09", {
    effectiveFrom: "2018-04-15", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Uttar Pradesh Notification 38, 11 April 2018",
  })],
  "10": [rule("10", {
    effectiveFrom: "2019-01-14", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
    sourceRef: "Bihar Notification S.O. 14, 14 January 2019",
    excludedGoodsNote: "Bihar's ₹1,00,000 limit does not cover the goods its order lists separately; check that list for these goods.",
  })],
  "11": [rule("11", {
    effectiveFrom: "2018-04-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "PRESS_RELEASE",
    sourceRef: "Sikkim rolled the e-way bill out by press release dated 23 April 2018; no numbered state notification is held for it.",
  })],
  "12": [rule("12", {
    effectiveFrom: "2018-04-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Arunachal Pradesh Notification 14/2018, 23 March 2018",
  })],
  "13": [rule("13", {
    effectiveFrom: "2018-05-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Nagaland Notification 6/2018, 19 April 2018",
  })],
  "14": [rule("14", {
    effectiveFrom: "2018-05-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "PRESS_RELEASE",
    sourceRef: "Manipur rolled the e-way bill out by CBIC press release dated 24 May 2018; no numbered state notification is held for it.",
  })],
  "15": [rule("15", {
    effectiveFrom: "2018-07-02", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Mizoram Notification J.21011/2(iii)/2018-TAX/Pt, 2 July 2018",
  })],
  "16": [rule("16", {
    effectiveFrom: "2018-04-20", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Tripura Notification F.1-11(91)-TAX/GST/2018, 17 April 2018",
  })],
  "17": [rule("17", {
    effectiveFrom: "2018-04-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Meghalaya Notification ERTS(T) 84/2017/20, 20 April 2018",
  })],
  "18": [rule("18", {
    effectiveFrom: "2019-12-16", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Assam Notification 30/2019-GST, 16 December 2019",
  })],
  "19": [
    rule("19", {
      effectiveFrom: "2023-12-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "West Bengal Notification 2/2023, 10 November 2023",
      note: "West Bengal brought its intra-state limit down from ₹1,00,000 to ₹50,000 on 1 December 2023. A movement before that date is judged under the old ₹1,00,000.",
    }),
    rule("19", {
      effectiveFrom: "2018-06-06", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
      sourceRef: "West Bengal Notification 13/2018 - C.T./GST, 6 June 2018",
    }),
  ],
  "20": [rule("20", {
    effectiveFrom: "2018-09-26", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
    sourceRef: "Jharkhand Notification S.O. 66, 26 September 2018",
    excludedGoodsNote: "Jharkhand's ₹1,00,000 limit does not cover the goods its order lists separately; those need a bill at the ordinary ₹50,000. Check that list for these goods.",
  })],
  "21": [rule("21", {
    effectiveFrom: "2018-06-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "PRESS_RELEASE",
    sourceRef: "Odisha rolled the e-way bill out by press release dated 31 May 2018; no numbered state notification is held for it.",
  })],
  "22": [rule("22", {
    effectiveFrom: "2018-06-19", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Chhattisgarh Notification F-10-31/2018/CT/V(46), 19 June 2018",
    notifiedGoodsOnly: true,
    note: "Chhattisgarh asks for an intra-state e-way bill only for the fifteen goods its order lists. Check that list before deciding these particular goods need one.",
  })],
  "23": [
    rule("23", {
      effectiveFrom: "2022-03-23", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
      sourceRef: "Madhya Pradesh Notification FA3-08/2018/1/V(18), 23 March 2022",
      excludedGoodsNote: "Madhya Pradesh's ₹1,00,000 limit does not cover tobacco and its products, pan masala, or medicines and pharmaceuticals; those need a bill at the ordinary ₹50,000.",
      note: "Madhya Pradesh raised its limit from ₹50,000 to ₹1,00,000 in March 2022. Before that it asked for a bill only for eleven listed goods.",
    }),
    rule("23", {
      effectiveFrom: "2018-04-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "Madhya Pradesh Notification F-A-3-08-2018-1-V(43), 24 April 2018",
      notifiedGoodsOnly: true, note: NOTIFIED_GOODS_NOTE,
    }),
  ],
  "24": [
    rule("24", {
      effectiveFrom: "2018-10-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "Gujarat Notification GSL/GST/RULE-138(14)/B.19, 19 September 2018",
      intraCityExemptAnyValue: true,
      note: "Gujarat asks for no e-way bill at all when the goods stay inside one city, whatever they are worth. Hank, yarn, fabric and garments moving anywhere in the state for job work are exempt too.",
    }),
    rule("24", {
      effectiveFrom: "2018-04-15", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "Gujarat Notification GSL/GST/RULE-138(14)/B.12, 11 April 2018",
    }),
  ],
  "25": [
    rule("25", {
      effectiveFrom: "2018-05-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "Notification 9/2018 - Union Territory Tax, 18 May 2018",
      note: "This code belongs to the old Daman and Diu. Since 26 January 2020 the union territory uses code 26.",
    }),
    rule("25", {
      effectiveFrom: "2018-04-01", exemptAnyValue: true, sourceKind: "NOTIFICATION",
      sourceRef: "Notification 5/2018 - Union Territory Tax, 31 March 2018",
    }),
  ],
  "26": [
    rule("26", {
      effectiveFrom: "2018-05-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
      sourceRef: "Notification 8/2018 - Union Territory Tax, 18 May 2018",
      note: "The blanket exemption of 1 April 2018 was withdrawn seven weeks later and the ordinary ₹50,000 limit put back.",
    }),
    rule("26", {
      effectiveFrom: "2018-04-01", exemptAnyValue: true, sourceKind: "NOTIFICATION",
      sourceRef: "Notification 4/2018 - Union Territory Tax, 31 March 2018",
    }),
  ],
  "27": [rule("27", {
    effectiveFrom: "2018-07-01", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
    sourceRef: "Maharashtra Notification 15E/2018 - State Tax, 29 June 2018",
    note: "Maharashtra also exempts hank, yarn, fabric and garments moved up to 50 km inside the state.",
  })],
  "28": [rule("28", {
    effectiveFrom: "2018-04-15", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOT_HELD",
    sourceRef: "No order is held for this code; the national ₹50,000 has been used.",
    note: "This code belongs to undivided Andhra Pradesh and is no longer issued. Andhra Pradesh is 37 and Telangana is 36.",
  })],
  "29": [rule("29", {
    effectiveFrom: "2018-04-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "PRESS_RELEASE",
    sourceRef: "Karnataka was the first state to start intra-state e-way bills, by press release dated 29 March 2018; it is also cited as Notification 01/2018 - State Tax of 25 March 2018.",
  })],
  "30": [rule("30", {
    effectiveFrom: "2018-05-28", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Goa Notification CCT/26-2/2018-19/36, 28 May 2018",
    notifiedGoodsOnly: true,
    note: "Goa asks for an intra-state e-way bill only for the twenty-two goods its order lists. Check that list before deciding these particular goods need one.",
  })],
  "31": [rule("31", {
    effectiveFrom: "2018-04-01", exemptAnyValue: true, sourceKind: "NOTIFICATION",
    sourceRef: "Notification 6/2018 - Union Territory Tax, 31 March 2018",
    note: "Lakshadweep asks for no e-way bill at all when the goods start and finish inside the union territory.",
  })],
  "32": [rule("32", {
    effectiveFrom: "2018-04-15", thresholdPaise: FIFTY_THOUSAND, sourceKind: "PRESS_RELEASE",
    sourceRef: "Kerala rolled the e-way bill out by press release dated 10 April 2018; no numbered state notification is held for it.",
    overridesExemptGoods: "In Kerala, gold and precious stones need an e-way bill from ₹10,00,000 upwards, even though those goods are exempt elsewhere in the country (Kerala GST Trade Circular 1/2025, in force from 20 January 2025).",
    preciousGoodsThresholdPaise: 10_00_000_00n,
  })],
  "33": [rule("33", {
    effectiveFrom: "2018-06-02", thresholdPaise: ONE_LAKH, sourceKind: "NOTIFICATION",
    sourceRef: "Tamil Nadu Notification 09, 31 May 2018",
  })],
  "34": [rule("34", {
    effectiveFrom: "2018-04-25", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Puducherry Notification F.No. 3240/CTD/GST/2018/3, 24 April 2018",
  })],
  "35": [rule("35", {
    effectiveFrom: "2018-04-01", exemptAnyValue: true, sourceKind: "NOTIFICATION",
    sourceRef: "Notification 2/2018 - Union Territory Tax, 31 March 2018",
    note: "The Andaman and Nicobar Islands ask for no e-way bill at all when the goods start and finish inside the union territory.",
  })],
  "36": [rule("36", {
    effectiveFrom: "2018-04-15", thresholdPaise: FIFTY_THOUSAND, sourceKind: "PRESS_RELEASE",
    sourceRef: "Telangana rolled the e-way bill out by press release dated 10 April 2018; no numbered state notification is held for it.",
  })],
  "37": [rule("37", {
    effectiveFrom: "2018-04-15", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOTIFICATION",
    sourceRef: "Andhra Pradesh CCT's Ref. in CCW/GST/74/2015, 11 April 2018",
  })],
  "38": [rule("38", {
    effectiveFrom: "2019-10-31", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOT_HELD",
    sourceRef: "No separate Ladakh order is held; the national ₹50,000 has been used since the union territory was formed.",
    note: "Ladakh was separated from Jammu and Kashmir on 31 October 2019. Jammu and Kashmir's own exemption does not extend to it.",
  })],
  "97": [rule("97", {
    effectiveFrom: "2018-04-01", thresholdPaise: FIFTY_THOUSAND, sourceKind: "NOT_HELD",
    sourceRef: "No separate order is held for other territory; the national ₹50,000 has been used.",
  })],
});

/** Every row in the table, newest first within each code, in code order. */
export const ALL_STATE_RULES: readonly StateIntraStateRule[] = Object.freeze(
  Object.keys(INTRA_STATE_RULES).sort().flatMap((code) => INTRA_STATE_RULES[code] ?? []),
);

/** The rule in force today for each code, in code order. What a screen shows. */
export const CURRENT_STATE_RULES: readonly StateIntraStateRule[] = Object.freeze(
  Object.keys(INTRA_STATE_RULES).sort().map((code) => INTRA_STATE_RULES[code]?.[0] as StateIntraStateRule),
);

/** The 36 places that exist today — 28 states and 8 union territories. What a picker offers. */
export const LIVE_JURISDICTIONS: readonly StateIntraStateRule[] = Object.freeze(
  CURRENT_STATE_RULES.filter((row) => row.kind === "STATE" || row.kind === "UNION_TERRITORY"),
);

/** Codes that are no longer issued, kept so an old document still resolves. */
export const RETIRED_CODES: readonly StateIntraStateRule[] = Object.freeze(
  CURRENT_STATE_RULES.filter((row) => row.kind === "RETIRED"),
);

/** How many of each kind the table holds, for anything that wants to say so out loud. */
export const jurisdictionCounts = (): Readonly<Record<"states" | "unionTerritories" | "retired" | "otherTerritory", number>> => ({
  states: CURRENT_STATE_RULES.filter((row) => row.kind === "STATE").length,
  unionTerritories: CURRENT_STATE_RULES.filter((row) => row.kind === "UNION_TERRITORY").length,
  retired: RETIRED_CODES.length,
  otherTerritory: CURRENT_STATE_RULES.filter((row) => row.kind === "OTHER_TERRITORY").length,
});

/**
 * The intra-state rule for a state on a date.
 *
 * Rows are newest first, so this is the first one that had come into force by then. Before a state
 * had any rule of its own, the national ₹50,000 is what stood, and the answer says so rather than
 * pretending the state set it.
 */
export const intraStateRuleFor = (
  stateCode: string,
  on: string,
): ValueThreshold & Partial<Omit<StateIntraStateRule, keyof ValueThreshold>> => {
  const rows = INTRA_STATE_RULES[stateCode];
  if (rows === undefined) {
    return {
      ...INTER_STATE_THRESHOLD,
      scope: stateCode,
      ruleId: "EWB.THRESHOLD.INTRA_STATE.UNKNOWN_STATE",
      note: `"${stateCode}" is not a GST state code we know, so the national ₹50,000 limit has been used. Check the state code on the movement.`,
    };
  }
  const inForce = rows.find((row) => row.effectiveFrom <= on);
  if (inForce === undefined) {
    const earliest = rows[rows.length - 1] as StateIntraStateRule;
    return {
      ...INTER_STATE_THRESHOLD,
      scope: stateCode,
      ruleId: "EWB.THRESHOLD.INTRA_STATE.BEFORE_STATE_RULE",
      note: `${earliest.stateName} had no e-way bill rule of its own until ${earliest.effectiveFrom}, so the national ₹50,000 limit applied on this date.`,
    };
  }
  return inForce;
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
