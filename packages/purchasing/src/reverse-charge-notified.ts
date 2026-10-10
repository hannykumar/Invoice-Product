/**
 * Issue #289 — the supplies on which the *recipient* pays the GST (reverse charge, CGST s.9(3)),
 * as the notifications list them, for the cases that turn on who the supplier is.
 *
 * Every entry names its notification, serial number and the date it took effect. The lists were
 * rebuilt on 10 Oct 2026 from each amending notification in turn (no official consolidated copy
 * after 01.04.2019 exists); the chain and the full lists are on issue #289:
 *
 *  - Goods: Notification 4/2017-Central Tax (Rate), amended by 36/2017, 43/2017, 11/2018, 10/2021,
 *    14/2022, 19/2023 and 06/2024. No later amendment found.
 *  - Services: Notification 13/2017-Central Tax (Rate), last amended by 07/2025 (16.01.2025). The
 *    56th Council (Sept 2025) did not change it.
 *
 * Only entries a purchase screen can meet are here, and only matched on what the app knows for
 * certain — the HSN/SAC code and the supplier's registration. Where the code alone cannot tell (a
 * Chapter 81 metal that may or may not be scrap), the entry says so and the person is asked.
 *
 * Section 9(4) (purchases from unregistered suppliers in general) applies only to the class of
 * recipients notified under it — promoters, Notification 07/2019-CT(R) — so an ordinary shop buying
 * from an unregistered seller pays no reverse charge unless the supply is on one of these lists.
 */

export type ReverseChargeSupplier = 'AGRICULTURIST' | 'UNREGISTERED' | 'ANY' | 'NON_BODY_CORPORATE';

export interface ReverseChargeEntry {
  readonly id: string;
  readonly notification: string;
  readonly serialNumber: string;
  readonly effectiveFrom: string;
  readonly description: string;
  /** HSN/SAC prefixes the entry covers. */
  readonly codes: readonly string[];
  readonly supplier: ReverseChargeSupplier;
  /** The recipient the entry names. Every entry here covers a regular registered business. */
  readonly recipient: string;
  /** True when the code alone cannot settle it (e.g. a Chapter 81 metal that may not be scrap). */
  readonly askFirst?: string;
  /** Recipients the entry leaves out. */
  readonly excludesCompositionRecipient?: boolean;
}

export const REVERSE_CHARGE_ENTRIES: readonly ReverseChargeEntry[] = [
  { id: 'G1', notification: '4/2017-Central Tax (Rate)', serialNumber: '1', effectiveFrom: '2017-07-01', description: 'Cashew nuts, not shelled or peeled', codes: ['080131'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  { id: 'G2', notification: '4/2017-Central Tax (Rate)', serialNumber: '2', effectiveFrom: '2017-07-01', description: 'Bidi wrapper leaves (tendu)', codes: ['14049010'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  { id: 'G3', notification: '4/2017-Central Tax (Rate)', serialNumber: '3', effectiveFrom: '2017-07-01', description: 'Tobacco leaves', codes: ['2401'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  { id: 'G3A', notification: '4/2017-Central Tax (Rate), S.No. 3A as substituted by 14/2022', serialNumber: '3A', effectiveFrom: '2023-01-01', description: 'Mint essential oils (peppermint, spearmint, water mint, horsemint, bergamot, Mentha arvensis)', codes: ['33012400', '33012510', '33012520', '33012530', '33012540', '33012590'], supplier: 'UNREGISTERED', recipient: 'Any registered person' },
  { id: 'G4A', notification: '4/2017-Central Tax (Rate), S.No. 4A inserted by 43/2017', serialNumber: '4A', effectiveFrom: '2017-11-15', description: 'Raw cotton', codes: ['5201'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  // Waste and scrap headings of Chapters 72 to 80 are scrap by their own description.
  { id: 'G8', notification: '4/2017-Central Tax (Rate), S.No. 8 inserted by 06/2024', serialNumber: '8', effectiveFrom: '2024-10-10', description: 'Metal scrap (Chapters 72 to 81)', codes: ['7204', '7404', '7503', '7602', '7802', '7902', '8002'], supplier: 'UNREGISTERED', recipient: 'Any registered person' },
  // Chapter 81 headings mix metal and its waste and scrap; the code alone does not say which.
  { id: 'G8-81', notification: '4/2017-Central Tax (Rate), S.No. 8 inserted by 06/2024', serialNumber: '8', effectiveFrom: '2024-10-10', description: 'Metal scrap (Chapters 72 to 81)', codes: ['81'], supplier: 'UNREGISTERED', recipient: 'Any registered person', askFirst: 'Chapter 81 covers both these metals and their scrap. If what you bought is scrap, the GST on it is yours to pay under reverse charge.' },
  { id: 'S5AA', notification: '13/2017-Central Tax (Rate), S.No. 5AA inserted by 05/2022', serialNumber: '5AA', effectiveFrom: '2022-07-18', description: 'Renting of a residential dwelling to a registered person', codes: ['997211'], supplier: 'ANY', recipient: 'Any registered person' },
  { id: 'S5AB', notification: '13/2017-Central Tax (Rate), S.No. 5AB inserted by 09/2024 (corrigendum 22.10.2024), amended by 07/2025', serialNumber: '5AB', effectiveFrom: '2024-10-10', description: 'Renting of any immovable property other than a residential dwelling', codes: ['997212'], supplier: 'UNREGISTERED', recipient: 'Any registered person other than a composition taxpayer', excludesCompositionRecipient: true },
  { id: 'S14', notification: '13/2017-Central Tax (Rate), S.No. 14 inserted by 29/2018', serialNumber: '14', effectiveFrom: '2019-01-01', description: 'Security services (supply of security personnel)', codes: ['998525'], supplier: 'NON_BODY_CORPORATE', recipient: 'A registered person (not a composition taxpayer)', excludesCompositionRecipient: true },
];

export interface ReverseChargeQuestion {
  readonly hsnSac: string;
  readonly on: string;
  readonly supplier: {
    readonly registered: boolean;
    readonly agriculturist: boolean;
    /** A company or other body corporate. Unknown for a person with no GST number is `false`. */
    readonly bodyCorporate: boolean;
  };
  readonly recipientIsComposition: boolean;
}

const suppliedBy = (entry: ReverseChargeEntry, supplier: ReverseChargeQuestion['supplier']): boolean => {
  switch (entry.supplier) {
    case 'AGRICULTURIST': return supplier.agriculturist;
    case 'UNREGISTERED': return !supplier.registered;
    case 'NON_BODY_CORPORATE': return !supplier.bodyCorporate;
    case 'ANY': return true;
  }
};

/** The entry this purchase falls under, or `null` when the recipient does not pay its GST. */
export const reverseChargeEntryFor = (question: ReverseChargeQuestion): ReverseChargeEntry | null => {
  const code = question.hsnSac.replace(/\s/g, '');
  return REVERSE_CHARGE_ENTRIES.find((entry) =>
    entry.effectiveFrom <= question.on
    && entry.codes.some((prefix) => code.startsWith(prefix))
    && suppliedBy(entry, question.supplier)
    && !(entry.excludesCompositionRecipient === true && question.recipientIsComposition)) ?? null;
};
