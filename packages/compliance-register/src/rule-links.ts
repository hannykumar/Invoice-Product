/**
 * Issue #54 [X06] — which rule stands on which source, and which tests prove it.
 *
 * This is the mapping that makes "trace a transaction's decision to its source and its test"
 * mechanical rather than a research exercise. `ComplianceRegister.trace()` walks it.
 */
import type { RuleSourceLink } from './types.ts';

export const RULE_SOURCE_LINKS: readonly RuleSourceLink[] = [
  {
    ruleId: 'gst.place_of_supply.goods',
    ruleVersion: '2026.08.29',
    sourceIds: ['igst-act-2017-s10-1-a'],
    tests: [
      'packages/rules-engine/test/approved-gst.test.ts › goods that move take the place of supply where the movement ends',
      'packages/rules-engine/test/approved-gst.test.ts › a case the source does not cover is refused, not approximated',
      'packages/gst-calc/test/compute.test.ts › golden case — intra-state sale splits into two GST amounts and rounds to ₹1,180 (worked example 3)',
    ],
  },
  {
    ruleId: 'gst.place_of_supply.services',
    ruleVersion: '2026.08.29',
    sourceIds: ['igst-act-2017-s12-2'],
    tests: [
      'packages/rules-engine/test/approved-gst.test.ts › services to a registered person take that person’s location',
      'packages/rules-engine/test/approved-gst.test.ts › services to an unregistered person need a recorded address',
    ],
  },
  {
    ruleId: 'gst.composition.charging',
    ruleVersion: '2026.08.29',
    sourceIds: ['cgst-act-2017-s10-4'],
    tests: [
      'packages/rules-engine/test/approved-gst.test.ts › a business on the composition scheme charges no tax',
      'packages/rules-engine/test/approved-gst.test.ts › an ordinary registered business charges tax normally',
      'packages/gst-calc/test/compute.test.ts › a business on the composition scheme charges no GST, and the bill says so',
    ],
  },
  {
    ruleId: 'gst.tax_split',
    ruleVersion: '2026.08.29',
    sourceIds: ['igst-act-2017-s7', 'igst-act-2017-s8', 'utgst-act-2017-s7'],
    tests: [
      'packages/rules-engine/test/approved-gst.test.ts › same state means two taxes, different states mean one',
      'packages/rules-engine/test/approved-gst.test.ts › a union territory in the UTGST Act carries union territory tax',
      'packages/rules-engine/test/approved-gst.test.ts › Delhi is a union territory but carries State tax',
      'packages/rules-engine/test/approved-gst.test.ts › Ladakh is refused rather than guessed',
      'packages/gst-calc/test/compute.test.ts › golden case — inter-state sale carries one combined GST and no CGST or SGST',
    ],
  },
];
