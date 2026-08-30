// Issue #27 [E27] — deciding whether a lorry may leave without an e-way bill.
//
// Two acceptance criteria shape this file. The first is that every decision lists the facts it
// applied and the source of the rule, so it can be defended to an officer at a check post months
// later. The second is that ₹1 lakh a day is not treated as a universal rule — see `rules.ts` for
// where that number really comes from.
//
// Nothing here reads or writes anything. The same facts always give the same answer, which is what
// makes a decision re-runnable and arguable rather than a moment in a log.

import { formatPaise } from "../../purchasing/src/money.ts";
import { EWAY_RULE_SET_VERSION, INTER_STATE_THRESHOLD, exemptGoodsFor, intraStateRuleFor, stateName } from "./rules.ts";
import type {
  AppliedFact, ConsignmentDocument, ConsignmentLine, EwayApplicabilityDecision, Movement,
  ValueThreshold,
} from "./types.ts";
import type { Paise } from "../../masters/src/types.ts";

/** Where the goods start and where they finish, which is not always where the bill goes. */
export const movementRoute = (movement: Movement): { readonly fromStateCode: string; readonly toStateCode: string; readonly fromPlace: string; readonly toPlace: string } => {
  const from = movement.dispatchFrom ?? movement.consignor;
  const to = movement.shipTo ?? movement.billTo;
  return {
    fromStateCode: (from.stateCode ?? "").trim(),
    toStateCode: (to.stateCode ?? "").trim(),
    fromPlace: from.place,
    toPlace: to.place,
  };
};

/** A line's value including the tax on it. The portal's "consignment value" is tax-inclusive. */
export const lineValueWithTax = (line: ConsignmentLine): Paise =>
  line.taxableValuePaise + line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise;

export interface ConsignmentValue {
  /** What the threshold is compared against. */
  readonly valuePaise: Paise;
  /** Value left out because it is an exempt supply or exempted goods, with why. */
  readonly excludedPaise: Paise;
  readonly excludedReasons: readonly string[];
  /** True when nothing on the lorry counts towards the limit. */
  readonly everythingExcluded: boolean;
  /**
   * Of the excluded value, the part that is jewellery, gold and precious stones.
   *
   * Kept apart because one state has its own rule about exactly these goods: Kerala wants an e-way
   * bill for them from ₹10 lakh upwards even though the national annexure exempts them. Without
   * this figure a Kerala jeweller would be told "no bill needed" for a ₹15 lakh consignment.
   */
  readonly excludedPreciousPaise: Paise;
}

/**
 * The consignment value, computed the way Explanation 2 to Rule 138(1) defines it.
 *
 * Tax included, and the value of an exempt supply on the same invoice left out. Both halves matter:
 * adding tax can push a ₹48,000 bill over ₹50,000, and forgetting to drop the exempt lines can push
 * a bill over the limit that was never near it.
 */
export const consignmentValueOf = (documents: readonly ConsignmentDocument[]): ConsignmentValue => {
  let value = 0n;
  let excluded = 0n;
  let precious = 0n;
  const reasons = new Set<string>();
  let counted = 0;

  for (const document of documents) {
    for (const line of document.lines) {
      const amount = lineValueWithTax(line);
      const goodsExemption = line.exemptFromEwayBill === true ? { label: "goods marked as exempt from e-way bills", sourceRef: "line" } : exemptGoodsFor(line.hsnCode);
      if (line.isExemptSupply === true) {
        excluded += amount;
        reasons.add(`"${line.description}" is an exempt or nil-rated supply, so its value is left out of the limit.`);
        continue;
      }
      if (goodsExemption !== null) {
        excluded += amount;
        if (line.hsnCode.trim().startsWith("71")) precious += amount;
        reasons.add(`"${line.description}" is ${goodsExemption.label}, which needs no e-way bill at any value.`);
        continue;
      }
      value += amount;
      counted += 1;
    }
  }

  return {
    valuePaise: value,
    excludedPaise: excluded,
    excludedReasons: [...reasons],
    everythingExcluded: counted === 0 && excluded > 0n,
    excludedPreciousPaise: precious,
  };
};

const fact = (label: string, value: string): AppliedFact => ({ label, value });

const MOVEMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  SUPPLY: "a sale",
  EXPORT: "an export",
  IMPORT: "an import",
  JOB_WORK: "goods going out for job work",
  BRANCH_TRANSFER: "your own goods moving between your own places",
  SALES_RETURN: "goods coming back from a customer",
  EXHIBITION_OR_FAIRS: "goods going to an exhibition",
  FOR_OWN_USE: "goods for your own use",
  SKD_CKD: "goods sent in parts across more than one vehicle",
  LINE_SALES: "goods going out on a van to be sold on the way",
  OTHERS: "another kind of movement",
});

/**
 * Whether this movement needs an e-way bill.
 *
 * The order below is the order the rules actually override each other in. An exemption beats a
 * value, a value-free obligation beats an exemption on value, and a missing fact beats everything —
 * because the one answer this must never give is a confident wrong one.
 */
export const decideEwayApplicability = (
  movement: Movement,
  options: { readonly on?: string } = {},
): EwayApplicabilityDecision => {
  const route = movementRoute(movement);
  const on = options.on ?? movement.documents[0]?.documentDate ?? "";
  const value = consignmentValueOf(movement.documents);
  const interState = route.fromStateCode !== "" && route.toStateCode !== "" && route.fromStateCode !== route.toStateCode;

  const facts: AppliedFact[] = [
    fact("Why the goods are moving", MOVEMENT_LABELS[movement.reason] ?? movement.reason),
    fact("From", `${route.fromPlace || "—"}${route.fromStateCode === "" ? " (state not known)" : ` (${stateName(route.fromStateCode)})`}`),
    fact("To", `${route.toPlace || "—"}${route.toStateCode === "" ? " (state not known)" : ` (${stateName(route.toStateCode)})`}`),
    fact("Consignment value, tax included", formatPaise(value.valuePaise)),
    fact("How the goods travel", movement.transportMode.toLowerCase().replace(/_/g, " ")),
  ];
  if (value.excludedPaise > 0n) {
    facts.push(fact("Value left out of the limit", formatPaise(value.excludedPaise)));
  }

  const base = { ruleSetVersion: EWAY_RULE_SET_VERSION, appliedFacts: facts, consignmentValuePaise: value.valuePaise } as const;

  // A hand cart or a bullock cart is exempt outright, whatever it is carrying.
  if (movement.transportMode === "NON_MOTORISED") {
    return {
      ...base, outcome: "NOT_REQUIRED", ruleId: "EWB.EXEMPT.NON_MOTORISED",
      sourceRef: "Rule 138(14)(a), CGST Rules 2017", effectiveFrom: "2018-04-01",
      reason: "These goods are going by a non-motorised vehicle — a hand cart or a bullock cart — and that needs no e-way bill, whatever the goods are worth.",
    };
  }

  // The leg between a port or airport and an inland depot for customs clearance is exempt.
  if (movement.customsClearanceLeg === true) {
    return {
      ...base, outcome: "NOT_REQUIRED", ruleId: "EWB.EXEMPT.CUSTOMS_CLEARANCE_LEG",
      sourceRef: "Rule 138(14)(g), CGST Rules 2017", effectiveFrom: "2018-04-01",
      reason: "This is the leg between the port or airport and the container depot for customs clearance, and no e-way bill is needed for it.",
    };
  }

  if (movement.underCustomsBond === true) {
    return {
      ...base, outcome: "NOT_REQUIRED", ruleId: "EWB.EXEMPT.CUSTOMS_BOND",
      sourceRef: "Rule 138(14)(h), CGST Rules 2017", effectiveFrom: "2018-04-01",
      reason: "These goods are moving under a customs bond, and goods under customs bond need no e-way bill.",
    };
  }

  if (movement.documents.length === 0) {
    return {
      ...base, outcome: "CANNOT_DECIDE", ruleId: "EWB.DOCUMENT.MISSING",
      reason: "We have not been told which bill or delivery challan is travelling with these goods, so we cannot work out what the consignment is worth.",
      missingFacts: ["documents"],
    };
  }

  // Everything on the lorry is exempted goods: nothing is left to compare against a limit — unless
  // the state the goods are moving inside has its own rule about exactly those goods.
  if (value.everythingExcluded) {
    const homeRule = route.fromStateCode !== "" && route.fromStateCode === route.toStateCode
      ? intraStateRuleFor(route.fromStateCode, on)
      : null;
    const preciousLimit = homeRule?.preciousGoodsThresholdPaise;
    if (preciousLimit !== undefined && value.excludedPreciousPaise > 0n) {
      const required = value.excludedPreciousPaise >= preciousLimit;
      return {
        ...base,
        outcome: required ? "REQUIRED" : "NOT_REQUIRED",
        ruleId: `EWB.STATE_OVERRIDE.PRECIOUS.${route.fromStateCode}`,
        ...(homeRule?.sourceRef === undefined ? {} : { sourceRef: homeRule.sourceRef }),
        ...(homeRule?.effectiveFrom === undefined ? {} : { effectiveFrom: homeRule.effectiveFrom }),
        reason: required
          ? `${homeRule?.overridesExemptGoods ?? ""} This consignment of ${formatPaise(value.excludedPreciousPaise)} is at or above that, so it needs an e-way bill even though these goods need none elsewhere in the country.`
          : `${homeRule?.overridesExemptGoods ?? ""} This consignment of ${formatPaise(value.excludedPreciousPaise)} is below that, so no e-way bill is needed.`,
      };
    }
    return {
      ...base, outcome: "NOT_REQUIRED", ruleId: "EWB.EXEMPT.GOODS",
      sourceRef: "Annexure to Rule 138(14), CGST Rules 2017", effectiveFrom: "2018-04-01",
      reason: `Everything on this vehicle is goods that need no e-way bill at any value. ${value.excludedReasons.join(" ")}`,
    };
  }

  // Sent to another state to be worked on: a bill is needed however small the consignment.
  if (movement.reason === "JOB_WORK" && interState) {
    return {
      ...base, outcome: "REQUIRED", ruleId: "EWB.ANY_VALUE.INTER_STATE_JOB_WORK",
      sourceRef: "First proviso to Rule 138(1), CGST Rules 2017", effectiveFrom: "2018-04-01",
      reason: `These goods are going to ${route.toStateCode === "" ? "another state" : stateName(route.toStateCode)} for job work. Goods sent to another state for job work need an e-way bill however little they are worth, so ${formatPaise(value.valuePaise)} does not matter here.`,
    };
  }

  // Handicrafts moved by somebody the rules excuse from registering: also at any value.
  if (movement.handicraftsByExemptPerson === true) {
    return {
      ...base, outcome: "REQUIRED", ruleId: "EWB.ANY_VALUE.HANDICRAFTS",
      sourceRef: "Second proviso to Rule 138(1) read with Notification 56/2018 - Central Tax", effectiveFrom: "2018-04-01",
      reason: "These are handicraft goods moved by a person who does not have to register for GST, and that needs an e-way bill however little the goods are worth.",
    };
  }

  if (route.fromStateCode === "" || route.toStateCode === "") {
    return {
      ...base, outcome: "CANNOT_DECIDE", ruleId: "EWB.ROUTE.STATE_UNKNOWN",
      reason: "We do not know which state these goods are starting from or going to, and the limit that applies depends on it. Two states means ₹50,000; inside one state it is that state's own limit.",
      missingFacts: [route.fromStateCode === "" ? "consignor.stateCode" : "shipTo.stateCode"],
    };
  }

  if (interState) {
    const crossing = `These goods are going from ${stateName(route.fromStateCode)} to ${stateName(route.toStateCode)}, so the ₹50,000 limit for goods crossing a state border applies`;
    return decideAgainst(base, INTER_STATE_THRESHOLD, value.valuePaise, {
      required: `${crossing}. This consignment is worth ${formatPaise(value.valuePaise)} including tax, which is above it, so it needs an e-way bill before the vehicle leaves.`,
      notRequired: `${crossing}. This consignment is worth ${formatPaise(value.valuePaise)} including tax, which is not above it, so no e-way bill is needed.`,
    });
  }

  const rule = intraStateRuleFor(route.fromStateCode, on);
  // A row from the state table, as against the national figure standing in for a state that had no
  // rule of its own yet or a code that is not a state at all.
  const ownRule = rule.stateName !== undefined;

  // Two union territories, and three more for seven weeks in 2018, ask for nothing at all inside
  // their own borders. That beats every money limit, so it is answered before one is applied.
  if (rule.exemptAnyValue === true) {
    return {
      ...base, outcome: "NOT_REQUIRED", ruleId: rule.ruleId,
      sourceRef: rule.sourceRef, effectiveFrom: rule.effectiveFrom,
      reason: `${rule.note ?? `${rule.stateName} asks for no e-way bill when the goods start and finish inside it.`} These goods are worth ${formatPaise(value.valuePaise)} and are staying inside ${rule.stateName}, so no e-way bill is needed. Goods crossing the border still need one.`,
    };
  }

  // Some states ask a question about the route before they ask one about the money: Gujarat exempts
  // movement inside one city outright, and Rajasthan sets a higher limit for it.
  const cityRuleApplies = rule.intraCityExemptAnyValue === true || rule.intraCityThresholdPaise !== undefined;
  if (cityRuleApplies && movement.withinSameCity === undefined) {
    return {
      ...base, outcome: "CANNOT_DECIDE", ruleId: `EWB.INTRA_CITY_UNKNOWN.${route.fromStateCode}`,
      sourceRef: rule.sourceRef, effectiveFrom: rule.effectiveFrom,
      reason: `${rule.note ?? `${rule.stateName} has its own rule for goods that stay inside one city.`} We have not been told whether this delivery stays inside one city, so we cannot say yet whether an e-way bill is needed.`,
      missingFacts: ["withinSameCity"],
      thresholdApplied: rule,
    };
  }
  if (rule.intraCityExemptAnyValue === true && movement.withinSameCity === true) {
    return {
      ...base, outcome: "NOT_REQUIRED", ruleId: `EWB.EXEMPT.INTRA_CITY.${route.fromStateCode}`,
      sourceRef: rule.sourceRef, effectiveFrom: rule.effectiveFrom,
      reason: `${rule.note ?? `${rule.stateName} exempts movement within one city.`} This delivery stays inside ${route.fromPlace || "one city"}, so no e-way bill is needed even though the goods are worth ${formatPaise(value.valuePaise)}.`,
      thresholdApplied: rule,
    };
  }

  // Rajasthan's city limit is a limit, not an exemption, so it is compared like any other.
  const insideOneCity = rule.intraCityThresholdPaise !== undefined && movement.withinSameCity === true;
  const applied: ValueThreshold = insideOneCity
    ? { ...rule, thresholdPaise: rule.intraCityThresholdPaise as Paise }
    : (rule as ValueThreshold);

  facts.push(fact(
    "Limit that applies",
    ownRule
      ? `${formatPaise(applied.thresholdPaise)} — ${rule.stateName}'s own limit${insideOneCity ? " for goods staying inside one city" : ""}, from ${rule.effectiveFrom}`
      : `${formatPaise(applied.thresholdPaise)} — the national limit`,
  ));

  const where = ownRule
    ? `Inside ${rule.stateName} the limit is ${formatPaise(applied.thresholdPaise)}${insideOneCity ? " for goods that stay inside one city" : ""}, set by that state from ${rule.effectiveFrom} — it is that state's limit, not a national one`
    : rule.note ?? `The national ₹50,000 limit has been used`;

  return decideAgainst(base, applied, value.valuePaise, {
    required: `${where}. This consignment is worth ${formatPaise(value.valuePaise)} including tax, which is above it, so it needs an e-way bill before the vehicle leaves.`,
    notRequired: `${where}. This consignment is worth ${formatPaise(value.valuePaise)} including tax, which is not above it, so no e-way bill is needed.`,
    // Some states ask for a bill only for goods on their own list, so a "yes" there is a "yes
    // unless these goods are off the list" — said out loud rather than left for someone to discover.
    ...(rule.notifiedGoodsOnly === true && rule.note !== undefined ? { caveat: rule.note } : {}),
    // And where a state's higher limit does not cover every kind of goods, a "no" is only a "no"
    // for goods the higher limit covers. Only worth saying once the national ₹50,000 is passed.
    ...(rule.excludedGoodsNote !== undefined && value.valuePaise > INTER_STATE_THRESHOLD.thresholdPaise
      ? { notRequiredCaveat: rule.excludedGoodsNote }
      : {}),
  });
};

/**
 * The comparison itself, in one place.
 *
 * The rule says "exceeds", so a consignment worth exactly the limit does not need a bill. That one
 * word is the whole ₹50,000 boundary, and putting it in a single function is how it stays the same
 * for every state.
 */
const decideAgainst = (
  base: { ruleSetVersion: string; appliedFacts: readonly AppliedFact[]; consignmentValuePaise: Paise },
  threshold: ValueThreshold,
  valuePaise: Paise,
  words: {
    readonly required: string;
    readonly notRequired: string;
    readonly caveat?: string;
    readonly notRequiredCaveat?: string;
  },
): EwayApplicabilityDecision => {
  const required = valuePaise > threshold.thresholdPaise;
  return {
    ...base,
    outcome: required ? "REQUIRED" : "NOT_REQUIRED",
    ruleId: threshold.ruleId,
    sourceRef: threshold.sourceRef,
    effectiveFrom: threshold.effectiveFrom,
    reason: required
      ? (words.caveat === undefined ? words.required : `${words.required} ${words.caveat}`)
      : (words.notRequiredCaveat === undefined ? words.notRequired : `${words.notRequired} ${words.notRequiredCaveat}`),
    thresholdApplied: threshold,
  };
};
