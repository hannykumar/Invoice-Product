/** Issue #7 [E07] — the rule sets this product ships with. */
import { RuleRegistry } from '../registry.ts';
import { POLICY_RULE_SET } from './policy.ts';
import { GST_RULE_SET, GST_RULE_SET_V2 } from './gst.ts';

export * from './facts.ts';
export * from './policy.ts';
export * from './gst.ts';

/** A registry loaded with every shipped rule set. Rule sets are immutable once registered. */
export const shippedRegistry = (): RuleRegistry =>
  new RuleRegistry().register(POLICY_RULE_SET).register(GST_RULE_SET).register(GST_RULE_SET_V2);
