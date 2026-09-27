// Issue #16 [E16] — the seam between purchase validation and GPT 1's rules engine (#7/#25).
//
// The engine is reached only through TaxSplitPort, so nothing in #16 depends on its internals
// and a GST rate is never decided here. If the engine cannot answer, that is reported as such
// and the item goes to a person — it is never filled in with a plausible number (rule 4).

import { RuleRegistry, RulesEngine, FactSet, GST_RULE_SET, type EngineMode } from "../../rules-engine/src/index.ts";
import { isoDate } from "../../kernel/src/dates.ts";
import { GST_STATE_CODES } from "../../masters/src/validation.ts";
import type { TaxSplitAnswer, TaxSplitPort } from "./validation-types.ts";

export interface RulesTaxSplitOptions {
  /** 'production' refuses any rule that is not APPROVED. That is the safe default. */
  readonly mode?: EngineMode;
  /**
   * The rules to consult. Defaults to the draft GST set alone, which a production engine will not
   * answer from. The running app passes the shipped registry, whose reviewed tax-split rule
   * (IGST Act sections 7 and 8) does answer — issue #228.
   */
  readonly registry?: RuleRegistry;
}

/**
 * Build the tax-split port over the shipped GST rule set.
 *
 * Note for callers: every rule in the draft `in.gst` set is DRAFT, so a production engine over
 * that set alone returns CANNOT_DECIDE — tax is then only checked for internal consistency. Pass
 * `registry: shippedRegistry()` to consult the reviewed set, as the purchase screen does (#228).
 */
export function rulesEngineTaxSplit(options: RulesTaxSplitOptions = {}): TaxSplitPort {
  const registry = options.registry ?? new RuleRegistry().register(GST_RULE_SET);
  const engine = new RulesEngine({ registry, ruleSetId: GST_RULE_SET.id, mode: options.mode ?? "production" });

  return {
    splitFor(input): TaxSplitAnswer {
      const { decision } = engine.evaluate({
        topic: "gst.tax_split",
        facts: FactSet.of(
          {
            "supply.supplierStateCode": input.supplierStateCode,
            "supply.placeOfSupplyStateCode": input.placeOfSupplyStateCode,
            // The reviewed rule needs the state's name to tell a union territory under the UTGST
            // Act from a state; the name is a fact about the code, not a guess.
            ...(GST_STATE_CODES[input.placeOfSupplyStateCode]?.name === undefined
              ? {}
              : { "supply.placeOfSupplyStateName": GST_STATE_CODES[input.placeOfSupplyStateCode]!.name }),
          },
          "MASTER_DATA",
        ),
        documentDate: isoDate(input.documentDate),
      });

      if (decision.outcome === "CANNOT_DECIDE") {
        return {
          kind: "CANNOT_DECIDE",
          missingFacts: decision.missingFacts.map((fact) => fact.factId),
          explanation: decision.explanation["en-IN"],
        };
      }
      return {
        kind: "SPLIT",
        // CGST with UTGST is as much an intra-state supply as CGST with SGST; only IGST is not.
        intraState: decision.computed["split"] !== "IGST",
        ruleSetVersion: decision.ruleSetVersion,
        ruleId: decision.ruleId ?? "unknown",
        explanation: decision.explanation["en-IN"],
      };
    },
  };
}
