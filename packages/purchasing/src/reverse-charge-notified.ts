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

export type ReverseChargeSupplier = 'AGRICULTURIST' | 'UNREGISTERED' | 'ANY';

/** What one answer does: go on to the next question, or settle the line. */
export type ReverseChargeAnswerEffect = 'CONTINUE' | 'NOT_REVERSE_CHARGE' | 'EXEMPT';

/**
 * Issue #289, part 2 — a fact the law turns on that the HSN/SAC code and the supplier record cannot
 * tell: whether a transporter issued a consignment note, whether an advocate is the seller. The
 * person is asked it in plain words, once per bill, and the answer is kept with the bill.
 */
export interface ReverseChargeAsk {
  readonly id: string;
  readonly question: string;
  /** Why it is asked, with the law that turns on it. */
  readonly why: string;
  readonly onYes: ReverseChargeAnswerEffect;
  readonly onNo: ReverseChargeAnswerEffect;
  /** Asked only of a supplier with a GST number (e.g. a transporter opting for forward charge). */
  readonly onlyRegisteredSupplier?: boolean;
  /** What the answer that settles it as exempt means, said on the bill. */
  readonly exemptBecause?: string;
}

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
  /** Recipients the entry leaves out. */
  readonly excludesCompositionRecipient?: boolean;
  /** Asked in order; the first answer that settles it ends the questions. */
  readonly asks?: readonly ReverseChargeAsk[];
  /**
   * The rate the law fixes for this supply whatever the item record says, with its source. Absent
   * means the item's own rate from the rate schedule.
   */
  readonly rate?: { readonly basisPoints: number; readonly source: string };
}

const IS_SCRAP: ReverseChargeAsk = {
  id: 'metal_is_scrap',
  question: 'Is what you bought scrap or waste of this metal (not the metal itself)?',
  why: 'Chapter 81 covers both these metals and their scrap, and only metal scrap from an unregistered seller is under reverse charge (Notification 4/2017-CT(R), S.No. 8).',
  onYes: 'CONTINUE', onNo: 'NOT_REVERSE_CHARGE',
};

// Notification 13/2017-CT(R) S.No. 1 and its Explanation: a goods transport agency is a person who
// transports goods by road and issues a consignment note (bilty / lorry receipt).
const GTA_NOTE: ReverseChargeAsk = {
  id: 'gta_consignment_note',
  question: 'Did the transporter give you a consignment note (bilty or lorry receipt) for these goods?',
  why: 'A transporter who issues a consignment note is a goods transport agency (GTA). GST on a GTA\'s freight is paid by you, the registered buyer, not by the transporter — Notification 13/2017-CT(R), S.No. 1. A transporter who issues none is not a GTA.',
  onYes: 'CONTINUE', onNo: 'NOT_REVERSE_CHARGE',
};
// Notification 12/2017-CT(R) S.No. 21 (as amended up to 01.04.2019, the latest official
// consolidated copy): these GTA services are exempt, so there is no tax for anyone to pay.
const GTA_EXEMPT: ReverseChargeAsk = {
  id: 'gta_exempt',
  question: 'Is this freight ₹1,500 or less for the truckload, or ₹750 or less for all the goods sent to you — or are the goods farm produce, milk, salt, food grain (including flour, pulses and rice), organic manure, registered newspapers or magazines, disaster relief material, or defence equipment?',
  why: 'Those GTA services are exempt from GST — Notification 12/2017-CT(R), S.No. 21.',
  onYes: 'EXEMPT', onNo: 'CONTINUE',
  exemptBecause: 'GTA freight exempt under Notification 12/2017-CT(R), S.No. 21',
};
// Notification 13/2017-CT(R) S.No. 1 as amended by 05/2022 and 08/2023 (Annexure III): reverse charge
// does not apply where the GTA opted to pay the tax itself and says so on its invoice.
const GTA_FORWARD: ReverseChargeAsk = {
  id: 'gta_forward_charge',
  question: 'Does the transporter\'s bill charge GST and say that they have opted to pay the GST themselves (forward charge)?',
  why: 'A GTA may opt to pay the GST itself; then its bill carries the GST and you pay it to them as on any bill — Notification 13/2017-CT(R), S.No. 1, as amended by 05/2022 and 08/2023. Otherwise you pay it.',
  onYes: 'NOT_REVERSE_CHARGE', onNo: 'CONTINUE', onlyRegisteredSupplier: true,
};

const ADVOCATE: ReverseChargeAsk = {
  id: 'legal_advocate',
  question: 'Is the seller an advocate or a firm of advocates?',
  why: 'Legal services from an advocate or a firm of advocates to a business are under reverse charge — Notification 13/2017-CT(R), S.No. 2. Legal or advisory work by anyone else is not.',
  onYes: 'CONTINUE', onNo: 'NOT_REVERSE_CHARGE',
};
// Notification 12/2017-CT(R) S.No. 45(b)(iii) and (c)(ii) (as amended up to 01.04.2019).
const SMALL_BUSINESS: ReverseChargeAsk = {
  id: 'legal_turnover_above_limit',
  question: 'Was your business\'s total turnover in the last financial year more than ₹20 lakh (₹10 lakh in a special category state)?',
  why: 'An advocate\'s legal services to a business whose turnover last year was up to ₹20 lakh (₹10 lakh in a special category state) are exempt — Notification 12/2017-CT(R), S.No. 45.',
  onYes: 'CONTINUE', onNo: 'EXEMPT',
  exemptBecause: 'legal services to a business with turnover up to the limit, exempt under Notification 12/2017-CT(R), S.No. 45',
};

const BODY_CORPORATE: ReverseChargeAsk = {
  id: 'security_body_corporate',
  question: 'Is the security agency a company (a body corporate)?',
  why: 'Security services are under reverse charge only when the agency is not a body corporate — Notification 13/2017-CT(R), S.No. 14. A company charges GST on its own bill.',
  onYes: 'NOT_REVERSE_CHARGE', onNo: 'CONTINUE',
};

export const REVERSE_CHARGE_ENTRIES: readonly ReverseChargeEntry[] = [
  { id: 'G1', notification: '4/2017-Central Tax (Rate)', serialNumber: '1', effectiveFrom: '2017-07-01', description: 'Cashew nuts, not shelled or peeled', codes: ['080131'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  { id: 'G2', notification: '4/2017-Central Tax (Rate)', serialNumber: '2', effectiveFrom: '2017-07-01', description: 'Bidi wrapper leaves (tendu)', codes: ['14049010'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  { id: 'G3', notification: '4/2017-Central Tax (Rate)', serialNumber: '3', effectiveFrom: '2017-07-01', description: 'Tobacco leaves', codes: ['2401'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  { id: 'G3A', notification: '4/2017-Central Tax (Rate), S.No. 3A as substituted by 14/2022', serialNumber: '3A', effectiveFrom: '2023-01-01', description: 'Mint essential oils (peppermint, spearmint, water mint, horsemint, bergamot, Mentha arvensis)', codes: ['33012400', '33012510', '33012520', '33012530', '33012540', '33012590'], supplier: 'UNREGISTERED', recipient: 'Any registered person' },
  { id: 'G4A', notification: '4/2017-Central Tax (Rate), S.No. 4A inserted by 43/2017', serialNumber: '4A', effectiveFrom: '2017-11-15', description: 'Raw cotton', codes: ['5201'], supplier: 'AGRICULTURIST', recipient: 'Any registered person' },
  // Waste and scrap headings of Chapters 72 to 80 are scrap by their own description.
  { id: 'G8', notification: '4/2017-Central Tax (Rate), S.No. 8 inserted by 06/2024', serialNumber: '8', effectiveFrom: '2024-10-10', description: 'Metal scrap (Chapters 72 to 81)', codes: ['7204', '7404', '7503', '7602', '7802', '7902', '8002'], supplier: 'UNREGISTERED', recipient: 'Any registered person' },
  // Chapter 81 headings mix metal and its waste and scrap; the code alone does not say which.
  { id: 'G8-81', notification: '4/2017-Central Tax (Rate), S.No. 8 inserted by 06/2024', serialNumber: '8', effectiveFrom: '2024-10-10', description: 'Metal scrap (Chapters 72 to 81)', codes: ['81'], supplier: 'UNREGISTERED', recipient: 'Any registered person', asks: [IS_SCRAP] },
  // Issue #289, part 2 — the supplies a registered supplier can bring as well.
  {
    id: 'S1', notification: '13/2017-Central Tax (Rate), S.No. 1 as amended by 05/2022 and 08/2023', serialNumber: '1', effectiveFrom: '2017-07-01',
    description: 'Transport of goods by road by a goods transport agency (GTA)', codes: ['9965', '9967'], supplier: 'ANY', recipient: 'Any registered person',
    asks: [GTA_NOTE, GTA_EXEMPT, GTA_FORWARD],
    // GST Council, 56th meeting (PIB release, 3 Sep 2025), services table: GTA "5% without ITC
    // (RCM/FCM)" before and after 22.09.2025; 18% only where the GTA opts to pay it itself.
    rate: { basisPoints: 500, source: 'the GTA rate under reverse charge, per the GST Council\'s 56th meeting, 3 Sep 2025' },
  },
  { id: 'S2', notification: '13/2017-Central Tax (Rate), S.No. 2', serialNumber: '2', effectiveFrom: '2017-07-01', description: 'Legal services by an advocate or a firm of advocates to a business', codes: ['99821'], supplier: 'ANY', recipient: 'Any business entity', asks: [ADVOCATE, SMALL_BUSINESS] },
  { id: 'S5AA', notification: '13/2017-Central Tax (Rate), S.No. 5AA inserted by 05/2022', serialNumber: '5AA', effectiveFrom: '2022-07-18', description: 'Renting of a residential dwelling to a registered person', codes: ['997211'], supplier: 'ANY', recipient: 'Any registered person' },
  { id: 'S5AB', notification: '13/2017-Central Tax (Rate), S.No. 5AB inserted by 09/2024 (corrigendum 22.10.2024), amended by 07/2025', serialNumber: '5AB', effectiveFrom: '2024-10-10', description: 'Renting of any immovable property other than a residential dwelling', codes: ['997212'], supplier: 'UNREGISTERED', recipient: 'Any registered person other than a composition taxpayer', excludesCompositionRecipient: true },
  { id: 'S14', notification: '13/2017-Central Tax (Rate), S.No. 14 inserted by 29/2018', serialNumber: '14', effectiveFrom: '2019-01-01', description: 'Security services (supply of security personnel)', codes: ['998525'], supplier: 'ANY', recipient: 'A registered person (not a composition taxpayer)', excludesCompositionRecipient: true, asks: [BODY_CORPORATE] },
];

export interface ReverseChargeQuestion {
  readonly hsnSac: string;
  readonly on: string;
  readonly supplier: {
    readonly registered: boolean;
    readonly agriculturist: boolean;
  };
  readonly recipientIsComposition: boolean;
  /** Answers already given on this bill, by question id. */
  readonly answers?: Readonly<Record<string, boolean>>;
}

export type ReverseChargeDecision =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'ASK'; readonly entry: ReverseChargeEntry; readonly ask: ReverseChargeAsk }
  | { readonly kind: 'EXEMPT'; readonly entry: ReverseChargeEntry; readonly because: string }
  | { readonly kind: 'REVERSE_CHARGE'; readonly entry: ReverseChargeEntry };

const suppliedBy = (entry: ReverseChargeEntry, supplier: ReverseChargeQuestion['supplier']): boolean => {
  switch (entry.supplier) {
    case 'AGRICULTURIST': return supplier.agriculturist;
    case 'UNREGISTERED': return !supplier.registered;
    case 'ANY': return true;
  }
};

/** The entry cited once: its notification, with the serial number unless the text already names it. */
export const citeReverseChargeEntry = (entry: ReverseChargeEntry): string =>
  entry.notification.includes('S.No.') ? `Notification ${entry.notification}` : `Notification ${entry.notification}, S.No. ${entry.serialNumber}`;

/** The entry this purchase's code and supplier fall under, before any question is asked. */
export const reverseChargeEntryFor = (question: ReverseChargeQuestion): ReverseChargeEntry | null => {
  const code = question.hsnSac.replace(/\s/g, '');
  return REVERSE_CHARGE_ENTRIES.find((entry) =>
    entry.effectiveFrom <= question.on
    && entry.codes.some((prefix) => code.startsWith(prefix))
    && suppliedBy(entry, question.supplier)
    && !(entry.excludesCompositionRecipient === true && question.recipientIsComposition)) ?? null;
};

/**
 * Whether the recipient pays this line's GST: settled by the list, then by the person's answers to
 * what the list turns on and the code cannot tell. The first unanswered question is returned to ask.
 */
export const reverseChargeDecisionFor = (question: ReverseChargeQuestion): ReverseChargeDecision => {
  const entry = reverseChargeEntryFor(question);
  if (entry === null) return { kind: 'NONE' };
  for (const ask of entry.asks ?? []) {
    if (ask.onlyRegisteredSupplier === true && !question.supplier.registered) continue;
    const answer = question.answers?.[ask.id];
    if (answer === undefined) return { kind: 'ASK', entry, ask };
    const effect = answer ? ask.onYes : ask.onNo;
    if (effect === 'NOT_REVERSE_CHARGE') return { kind: 'NONE' };
    if (effect === 'EXEMPT') return { kind: 'EXEMPT', entry, because: ask.exemptBecause ?? ask.why };
  }
  return { kind: 'REVERSE_CHARGE', entry };
};
