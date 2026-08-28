/**
 * Issue #54 [X06] — the decision log.
 *
 * Where the sources do not settle a question, somebody decided something. That decision is written
 * down here with its reasoning and with what would let us stop guessing, rather than living in a
 * commit message or in nobody's head.
 */
import { isoDate } from '@invoice/kernel';
import type { DecisionLogEntry } from './types.ts';

const GPT1 = 'GPT 1 (agent) — awaiting countersignature by a qualified reviewer';

export const DECISION_LOG: readonly DecisionLogEntry[] = [
  {
    id: 'dl-ladakh-utgst',
    question: 'Does a supply inside Ladakh carry union territory tax or State tax?',
    decision:
      'Refuse to decide. A supply whose place of supply is Ladakh returns CANNOT_DECIDE and opens an exception item.',
    rationale:
      'The UTGST Act extent clause we were able to read first-hand is the text as enacted in 2017, which predates the creation of Ladakh as a union territory. Official summaries indicate Ladakh was added by a later amendment, but we could not retrieve the amended text from the publisher (the updated-Act host refused the connection). Answering either way would be a guess about the law, and a wrong answer here means the wrong tax was charged on a real bill.',
    kind: 'DEFERRED',
    decidedBy: GPT1,
    decidedOn: isoDate('2026-08-29'),
    affectedRules: ['gst.tax_split'],
    sourceIds: ['utgst-act-2017-s1-2'],
    whatWouldResolveIt:
      'Retrieve the UTGST Act as amended by the Finance Act 2020 from an official source, quote its extent clause, and add Ladakh to UTGST_TERRITORY_NAMES with that source recorded.',
  },
  {
    id: 'dl-delhi-puducherry-state-tax',
    question: 'Do Delhi and Puducherry carry union territory tax, since they are union territories?',
    decision: 'No. An intra-State supply in Delhi or Puducherry carries State tax, not union territory tax.',
    rationale:
      'The UTGST Act does not extend to them: its extent clause names Andaman and Nicobar Islands, Lakshadweep, Dadra and Nagar Haveli, Daman and Diu, Chandigarh and other territory. Delhi and Puducherry are absent. This matters because the master-data state table marks them `union: true` for other purposes, and reading that flag as "UTGST applies" would charge the wrong tax on a very large number of ordinary Delhi bills.',
    kind: 'INTERPRETATION',
    decidedBy: GPT1,
    decidedOn: isoDate('2026-08-29'),
    affectedRules: ['gst.tax_split'],
    sourceIds: ['utgst-act-2017-s1-2', 'utgst-act-2017-s7'],
    whatWouldResolveIt: 'Nothing further; the extent clause is explicit. Recorded because the master-data flag invites the opposite reading.',
  },
  {
    id: 'dl-place-of-supply-goods-scope',
    question: 'Which place-of-supply cases for goods does the product support?',
    decision:
      'Only section 10(1)(a): goods that move to the recipient. Bill-to-ship-to, goods not involving movement, assembly at site, supply on board a conveyance, imports and exports are refused.',
    rationale:
      'Each of the other clauses turns on facts the product does not yet capture, and approximating any of them would produce a confidently wrong place of supply. Refusing produces an exception item a person can resolve.',
    kind: 'UNSUPPORTED_SCENARIO',
    decidedBy: GPT1,
    decidedOn: isoDate('2026-08-29'),
    affectedRules: ['gst.place_of_supply.goods'],
    sourceIds: ['igst-act-2017-s10-1-a'],
    whatWouldResolveIt:
      'Capture the third-party delivery address and the movement facts each clause needs, then add one rule per clause with its own source entry.',
  },
  {
    id: 'dl-place-of-supply-services-scope',
    question: 'Which place-of-supply cases for services does the product support?',
    decision:
      'Only the general rule in section 12(2): the location of a registered recipient, or the recorded address of an unregistered one. Every specific service in sections 12(3) to 12(14) is refused.',
    rationale:
      'Immovable property, transport, events, training, telecommunications, banking and insurance each have their own rule and their own facts. A general answer applied to them would be wrong, and wrong in a way nobody would notice until a return was filed.',
    kind: 'UNSUPPORTED_SCENARIO',
    decidedBy: GPT1,
    decidedOn: isoDate('2026-08-29'),
    affectedRules: ['gst.place_of_supply.services'],
    sourceIds: ['igst-act-2017-s12-2'],
    whatWouldResolveIt: 'Add a service-category fact from master data, then one rule per carve-out with its own source entry.',
  },
  {
    id: 'dl-eway-thresholds-unsourced',
    question: 'May the e-way bill applicability rule be approved?',
    decision: 'No. It stays DRAFT, and production refuses it, so the product returns CANNOT_DECIDE for e-way applicability.',
    rationale:
      'Its thresholds are placeholders written to exercise the arithmetic. They rest on no source at all. A threshold is exactly the kind of number that is easy to get almost right and expensive to get wrong.',
    kind: 'DEFERRED',
    decidedBy: GPT1,
    decidedOn: isoDate('2026-08-29'),
    affectedRules: ['gst.eway.applicability'],
    sourceIds: [],
    whatWouldResolveIt:
      'Record the e-way bill rules and the State notifications that set intra-State thresholds, one register entry per jurisdiction, then re-issue the rule per State with its own effective dates.',
  },
  {
    id: 'dl-gst-rates-unsourced',
    question: 'May the shipped GST rate table be used in production?',
    decision: 'No. Every rate entry is DRAFT and production refuses it.',
    rationale:
      'The rates in the fixture table were written to exercise inclusive pricing, cess and effective-date boundaries. They are not sourced, and a rate is the single number a business is most likely to be penalised for getting wrong.',
    kind: 'DEFERRED',
    decidedBy: GPT1,
    decidedOn: isoDate('2026-08-29'),
    affectedRules: [],
    sourceIds: [],
    whatWouldResolveIt:
      'Record the rate notifications per chapter or heading with their effective dates, and load the rate table from the register rather than from code.',
  },
];
