/**
 * Issue #47 [E47] — what was approved is what runs.
 *
 * The fingerprint covers the intent and, for every step in order, the tool, its input, the party
 * and the amount. So a plan approved for "₹250 to ABC Traders" cannot execute as "₹25,000 to
 * someone else": the world moved, the fingerprint moved, and execution stops and says so. It is
 * the same idea as the acknowledgement pinning in #19 and the send-time re-check in #23.
 */
import { createHash } from 'node:crypto';
import type { PlannedStep } from './model.ts';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return `${item}n`;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return item;
  });

export const fingerprintOf = (intent: string, steps: readonly PlannedStep[]): string => {
  const material = canonical({
    intent,
    steps: steps.map((step) => ({
      tool: step.tool,
      input: step.input,
      party: step.party,
      amount: step.amount === null ? null : `${step.amount.currency}:${step.amount.minor}`,
    })),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
};
