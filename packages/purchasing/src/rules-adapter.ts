// Issue #16 [E16] — the seam between purchase validation and GPT 1's rules engine (#7/#25).
//
// The engine is reached only through TaxSplitPort, so nothing in #16 depends on its internals
// and a GST rate is never decided here. If the engine cannot answer, that is reported as such
// and the item goes to a person — it is never filled in with a plausible number (rule 4).

import { RuleRegistry, RulesEngine, FactSet, GST_RULE_SET, type EngineMode } from "../../rules-engine/src/index.ts";
import { isoDate } from "../../kernel/src/dates.ts";
import type { TaxSplitAnswer, TaxSplitPort } from "./validation-types.ts";

export interface RulesTaxSplitOptions {
  /** 'production' refuses any rule that is not APPROVED. That is the safe default. */
  readonly mode?: EngineMode;
}

/**
 * Build the tax-split port over the shipped GST rule set.
 *
 * Note for callers: at the time of writing every rule in `in.gst` is still DRAFT pending #54,
 * so a production engine returns CANNOT_DECIDE. That is the correct, safe behaviour — it means
 * tax is checked only for internal consistency until reviewed sources are published.
 */
export function rulesEngineTaxSplit(options: RulesTaxSplitOptions = {}): TaxSplitPort {
  const registry = new RuleRegistry().register(GST_RULE_SET);
  const engine = new RulesEngine({ registry, ruleSetId: GST_RULE_SET.id, mode: options.mode ?? "production" });

  return {
    splitFor(input): TaxSplitAnswer {
      const { decision } = engine.evaluate({
        topic: "gst.tax_split",
        facts: FactSet.of(
          {
            "supply.supplierStateCode": input.supplierStateCode,
            "supply.placeOfSupplyStateCode": input.placeOfSupplyStateCode,
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
        intraState: decision.computed["split"] === "CGST_SGST",
        ruleSetVersion: decision.ruleSetVersion,
        ruleId: decision.ruleId ?? "unknown",
        explanation: decision.explanation["en-IN"],
      };
    },
  };
}
