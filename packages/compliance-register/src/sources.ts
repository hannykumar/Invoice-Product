/**
 * Issue #54 [X06] — the source catalogue.
 *
 * Every entry was retrieved from the publisher's own domain on the date shown. `quotedText` is the
 * short passage the rule actually stands on — a citation, not a reproduction of the Act.
 *
 * Adding an entry is not the same as approving a rule. `validateRegister` decides whether a rule
 * may be APPROVED, and it refuses anything that rests on commentary, on an unreviewed entry, or on
 * a source we could not read first-hand.
 */
import { isoDate } from '@invoice/kernel';
import type { ComplianceSource } from './types.ts';

/** Sources are reviewed at least once a year, and sooner when something changes. */
const REVIEW_INTERVAL_DAYS = 365;

const reviewDueFrom = (retrieved: string): string => {
  const at = new Date(`${retrieved}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + REVIEW_INTERVAL_DAYS);
  return at.toISOString().slice(0, 10);
};

const source = (s: Omit<ComplianceSource, 'reviewDue'> & { reviewDue?: string }): ComplianceSource => ({
  ...s,
  reviewDue: isoDate(s.reviewDue ?? reviewDueFrom(s.retrievedOn)),
});

/**
 * The reviewer recorded on these entries is the agent that retrieved and quoted them.
 *
 * That is deliberately visible rather than hidden behind a plausible human name: a person with
 * professional responsibility should countersign each entry before the product is sold, and until
 * they do, the register says exactly who checked it and how. See `docs/compliance/README.md`.
 */
const GPT1 = 'GPT 1 (agent) — awaiting countersignature by a qualified reviewer';

export const SOURCES: readonly ComplianceSource[] = [
  source({
    id: 'igst-act-2017-s7',
    title: 'The Integrated Goods and Services Tax Act, 2017 — inter-State supply',
    authority: 'STATUTE',
    publisher: 'Parliament of India, published by CBIC',
    url: 'https://cbic-gst.gov.in/hindi/IGST-bill-e.html',
    provision: 'Section 7',
    quotedText:
      'Supply of goods, where the location of the supplier and the place of supply are in two different States; two different Union territories; or a State and a Union territory, shall be treated as a supply of goods in the course of inter-State trade or commerce.',
    effectiveFrom: isoDate('2017-07-01'),
    effectiveTo: null,
    retrievedOn: isoDate('2026-08-29'),
    verification: 'FIRST_HAND',
    state: 'ACTIVE',
    supersededBy: null,
    reviewedBy: GPT1,
    reviewedOn: isoDate('2026-08-29'),
    notes: 'Basis for treating a supply as inter-State when supplier and place of supply differ.',
  }),
  source({
    id: 'igst-act-2017-s8',
    title: 'The Integrated Goods and Services Tax Act, 2017 — intra-State supply',
    authority: 'STATUTE',
    publisher: 'Parliament of India, published by CBIC',
    url: 'https://cbic-gst.gov.in/hindi/IGST-bill-e.html',
    provision: 'Section 8',
    quotedText:
      'Supply of goods where the location of the supplier and the place of supply of goods are in the same State or same Union territory shall be treated as intra-State supply.',
    effectiveFrom: isoDate('2017-07-01'),
    effectiveTo: null,
    retrievedOn: isoDate('2026-08-29'),
    verification: 'FIRST_HAND',
    state: 'ACTIVE',
    supersededBy: null,
    reviewedBy: GPT1,
    reviewedOn: isoDate('2026-08-29'),
    notes: 'Basis for treating a supply as intra-State when supplier and place of supply agree.',
  }),
  source({
    id: 'igst-act-2017-s10-1-a',
    title: 'The Integrated Goods and Services Tax Act, 2017 — place of supply of goods involving movement',
    authority: 'STATUTE',
    publisher: 'Parliament of India, published by CBIC',
    url: 'https://cbic-gst.gov.in/hindi/IGST-bill-e.html',
    provision: 'Section 10(1)(a)',
    quotedText:
      'Where the supply involves movement of goods, whether by the supplier or the recipient or by any other person, the place of supply of such goods shall be the location of the goods at the time at which the movement of goods terminates for delivery to the recipient.',
    effectiveFrom: isoDate('2017-07-01'),
    effectiveTo: null,
    retrievedOn: isoDate('2026-08-29'),
    verification: 'FIRST_HAND',
    state: 'ACTIVE',
    supersededBy: null,
    reviewedBy: GPT1,
    reviewedOn: isoDate('2026-08-29'),
    notes:
      'Covers the ordinary case this product supports: goods that move to the recipient. Clauses (b) to (e) — bill-to-ship-to, goods not involving movement, assembly at site, supply on board a conveyance — are not implemented and are refused.',
  }),
  source({
    id: 'igst-act-2017-s12-2',
    title: 'The Integrated Goods and Services Tax Act, 2017 — place of supply of services, domestic',
    authority: 'STATUTE',
    publisher: 'Parliament of India, published by CBIC',
    url: 'https://cbic-gst.gov.in/hindi/IGST-bill-e.html',
    provision: 'Section 12(2)',
    quotedText:
      'Services made to a registered person shall be the location of such person; made to any person other than a registered person shall be the location of the recipient where the address on record exists.',
    effectiveFrom: isoDate('2017-07-01'),
    effectiveTo: null,
    retrievedOn: isoDate('2026-08-29'),
    verification: 'FIRST_HAND',
    state: 'ACTIVE',
    supersededBy: null,
    reviewedBy: GPT1,
    reviewedOn: isoDate('2026-08-29'),
    notes:
      'The general rule for domestic services. Sections 12(3) to 12(14) carve out specific services — immovable property, transport, events, telecom and others — none of which are implemented; those are refused.',
  }),
  source({
    id: 'utgst-act-2017-s1-2',
    title: 'The Union Territory Goods and Services Tax Act, 2017 — extent',
    authority: 'STATUTE',
    publisher: 'Parliament of India, published by CBIC',
    url: 'https://cbic-gst.gov.in/hindi/UTGST-bill-e.html',
    provision: 'Section 1(2)',
    quotedText:
      'It extends to the Union territories of the Andaman and Nicobar Islands, Lakshadweep, Dadra and Nagar Haveli, Daman and Diu, Chandigarh and other territory.',
    effectiveFrom: isoDate('2017-07-01'),
    effectiveTo: null,
    retrievedOn: isoDate('2026-08-29'),
    verification: 'FIRST_HAND',
    state: 'NEEDS_REVIEW',
    supersededBy: null,
    reviewedBy: GPT1,
    reviewedOn: isoDate('2026-08-29'),
    notes:
      'This is the text as enacted in 2017. It has since been amended: Dadra and Nagar Haveli and Daman and Diu were merged, and Ladakh was added. The amended text could not be retrieved first-hand (the publisher\'s updated-Act host refused the connection), so Ladakh is deliberately NOT treated as a UTGST territory by any rule — a supply inside Ladakh is refused instead. See decision log entry `dl-ladakh-utgst`.',
  }),
  source({
    id: 'utgst-act-2017-s7',
    title: 'The Union Territory Goods and Services Tax Act, 2017 — levy and collection',
    authority: 'STATUTE',
    publisher: 'Parliament of India, published by CBIC',
    url: 'https://cbic-gst.gov.in/hindi/UTGST-bill-e.html',
    provision: 'Section 7',
    quotedText:
      'There shall be levied a tax called the Union territory tax on all intra-State supplies of goods or services or both, except on the supply of alcoholic liquor for human consumption, on the value determined under section 15 of the Central Goods and Services Tax Act and at such rates, not exceeding twenty per cent.',
    effectiveFrom: isoDate('2017-07-01'),
    effectiveTo: null,
    retrievedOn: isoDate('2026-08-29'),
    verification: 'FIRST_HAND',
    state: 'ACTIVE',
    supersededBy: null,
    reviewedBy: GPT1,
    reviewedOn: isoDate('2026-08-29'),
    notes: 'Basis for charging union territory tax rather than State tax on an intra-State supply inside a covered union territory.',
  }),
];

/**
 * The union territories where the UTGST Act levies union territory tax, taken from the extent
 * clause above **as enacted**.
 *
 * Delhi, Puducherry and Jammu and Kashmir are not in this list. They are union territories, but
 * they are not in the UTGST Act's extent, so an intra-State supply there carries State tax. That
 * distinction is the reason this list exists rather than a general "is a union territory" flag.
 */
export const UTGST_TERRITORY_NAMES: readonly string[] = [
  'Andaman and Nicobar Islands',
  'Lakshadweep',
  'Dadra and Nagar Haveli',
  'Daman and Diu',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Chandigarh',
  'Other Territory',
];

/**
 * Territories we know were added or changed after the text we could read, and therefore refuse to
 * decide about. Refusing a small number of real supplies is the correct cost of not guessing.
 */
export const UTGST_PENDING_VERIFICATION_NAMES: readonly string[] = ['Ladakh'];
