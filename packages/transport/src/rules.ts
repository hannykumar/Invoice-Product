// Issue #27 [E27] — the money limits, and whose limit each one is.
//
// This file exists so that "does this need an e-way bill?" is answered from a table with dates and
// sources on it, rather than from a number somebody remembers. The distinction that matters:
//
//   - **Between two states** the limit is ₹50,000, and it is national. Rule 138(1) of the CGST
//     Rules, in force everywhere since 1 April 2018.
//   - **Inside one state** the limit is that state's own. Several states set ₹1 lakh, which is
//     where the "₹1 lakh" belief comes from — but it belongs to Maharashtra, Delhi, West Bengal,
//     Tamil Nadu, Bihar, Punjab and Rajasthan, not to the country, and never to a *day*.
//
// Assumption recorded on purpose: the state figures and dates below are transcribed from the state
// notifications named against each one. They are the values this product ships with, not values it
// discovered — before a business in a state relies on it, the entry should be checked against that
// state's current order. Every entry carries its `sourceRef` so that check is a lookup rather than
// an investigation, and a change is a change to this table rather than to any code.

import type { ValueThreshold } from "./types.ts";

export const EWAY_RULE_SET_VERSION = "in.gst.ewaybill.2026.1";

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
 * `intraCityExemptAnyValue` is not a flourish: Gujarat exempts movement within one city whatever
 * it is worth, so in Gujarat the question "is this within one city?" decides the answer before the
 * money does. Where that fact is missing, the decision says so instead of assuming.
 */
export interface StateIntraStateRule extends ValueThreshold {
  readonly stateName: string;
  readonly intraCityExemptAnyValue?: boolean;
}

const state = (
  code: string,
  stateName: string,
  thresholdPaise: bigint,
  effectiveFrom: string,
  sourceRef: string,
  extra: { readonly note?: string; readonly intraCityExemptAnyValue?: boolean } = {},
): StateIntraStateRule => Object.freeze({
  scope: code,
  stateName,
  thresholdPaise,
  effectiveFrom,
  sourceRef,
  ruleId: `EWB.THRESHOLD.INTRA_STATE.${code}`,
  ...extra,
});

/**
 * State-by-state limits for movement inside one state, by GST state code.
 *
 * A state that is not in this list falls back to ₹50,000 — the national figure — and the decision
 * says plainly that it used the national figure because we hold no separate order for that state.
 * That is different from claiming the state has set ₹50,000, and it is written differently.
 */
export const INTRA_STATE_RULES: Readonly<Record<string, StateIntraStateRule>> = Object.freeze({
  "03": state("03", "Punjab", 1_00_000_00n, "2018-06-01", "Punjab Notification GST-I-2018/3, 19 April 2018"),
  "06": state("06", "Haryana", 50_000_00n, "2018-04-20", "Haryana Notification 49/ST-2, 19 April 2018"),
  "07": state("07", "Delhi", 1_00_000_00n, "2018-06-16", "Delhi Notification F.3(46)/Fin(Rev-I)/2017-18, 15 June 2018"),
  "08": state("08", "Rajasthan", 1_00_000_00n, "2019-04-01", "Rajasthan Notification F.17(131)ACCT/GST/2017/3743, 6 August 2018 as amended"),
  "09": state("09", "Uttar Pradesh", 50_000_00n, "2018-04-15", "Uttar Pradesh Notification 38/2018, 11 April 2018"),
  "10": state("10", "Bihar", 1_00_000_00n, "2018-04-20", "Bihar Notification S.O. 130, 19 April 2018"),
  "19": state("19", "West Bengal", 1_00_000_00n, "2018-06-06", "West Bengal Notification 13/2018 - C.T./GST, 6 June 2018"),
  "21": state("21", "Odisha", 50_000_00n, "2018-06-01", "Odisha Notification 15918-FIN-CT1-TAX-0022/2017, 31 May 2018"),
  "24": state("24", "Gujarat", 50_000_00n, "2018-04-15", "Gujarat Notification GSL/GST/RULE-138(14)/B.12, 11 April 2018", {
    intraCityExemptAnyValue: true,
    note: "Gujarat asks for no e-way bill at all when the goods stay inside one city, whatever they are worth.",
  }),
  "27": state("27", "Maharashtra", 1_00_000_00n, "2018-07-01", "Maharashtra Notification 15E/2018 - State Tax, 29 June 2018"),
  "29": state("29", "Karnataka", 50_000_00n, "2018-04-01", "Karnataka Notification 01/2018 - State Tax, 25 March 2018"),
  "32": state("32", "Kerala", 50_000_00n, "2018-04-15", "Kerala Notification 3/2018 - State Tax, 12 April 2018"),
  "33": state("33", "Tamil Nadu", 1_00_000_00n, "2018-06-02", "Tamil Nadu Notification 09/2018 - (Rate)/G.O. (Ms) No. 72, 31 May 2018"),
});

/**
 * The intra-state rule for a state on a date, or the national fallback.
 *
 * A state order that has not come into force yet on the movement's date does not apply to it, so a
 * back-dated movement is judged by the rules that were actually in force when the lorry left.
 */
export const intraStateRuleFor = (stateCode: string, on: string): ValueThreshold & { readonly stateName?: string; readonly intraCityExemptAnyValue?: boolean } => {
  const rule = INTRA_STATE_RULES[stateCode];
  if (rule === undefined || rule.effectiveFrom > on) {
    return {
      ...INTER_STATE_THRESHOLD,
      scope: stateCode,
      ruleId: "EWB.THRESHOLD.INTRA_STATE.NATIONAL_FALLBACK",
      note: "We hold no separate order for this state, so the national ₹50,000 limit has been used.",
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
  return found === null || found === undefined ? null : { label: found.label, sourceRef: found.sourceRef };
};
