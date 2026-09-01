/**
 * Issue #32 [E32] — the obligations themselves, effective-dated and versioned.
 *
 * Every entry below is `DRAFT`, and that is not laziness. This product's standing rule is that a
 * compliance figure nobody has checked against the notification it came from may be used but must
 * never be presented as checked law. So each entry carries the notification reference it is meant
 * to rest on, a review state that says nobody has verified it yet, and wording — written once, in
 * `describeReviewState` — that appears beside the date on every screen and in every alert: confirm
 * this with your accountant. When the compliance register (#54) approves an entry against its
 * source, the review state changes and the caveat disappears. Nothing else changes.
 *
 * The three deadlines that are not government forms — reviewing purchase mismatches, clearing the
 * invoices that never reached the IRP, and the e-way bill that expires tonight — are marked
 * `POLICY`. They are this product's own preventive work, they are the ones that actually stop a
 * business losing money, and they are never dressed up as statute.
 *
 * **How a changed deadline is handled.** A new date is a new version with a later `effectiveFrom`,
 * appended to this list. The old entry is not edited and not removed. `definitionsFor` picks the
 * version effective on the period's *own* end date, so a rule that takes effect in October cannot
 * reach back and re-date July's return, and a return already filed keeps the deadline it had.
 */
import { isoDate, type IsoDate } from '@invoice/kernel';
import { bilingual, type ObligationCode, type ObligationDefinition } from './types.ts';

/**
 * The two state groups the quarterly summary return is split into: one files on the 22nd, the other
 * on the 24th. The codes are the two-digit GST state codes.
 *
 * Like every other figure in this file the split is `DRAFT` — a reading of a notification that
 * nobody has checked here — and it is written out state by state rather than as "southern and
 * western states" because a business in a state this product got wrong deserves to be able to point
 * at the row that is wrong.
 */
const QUARTERLY_GROUP_X = Object.freeze([
  '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37',
]);

const QUARTERLY_GROUP_Y = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16',
  '17', '18', '19', '20', '21', '38', '97',
]);

const LADDER_STATUTORY = Object.freeze([
  { offsetDays: -7, level: 'EARLY' as const, audiences: ['ACCOUNTANT' as const] },
  { offsetDays: -3, level: 'DUE_SOON' as const, audiences: ['ACCOUNTANT' as const, 'OWNER' as const] },
  { offsetDays: 0, level: 'DUE_TODAY' as const, audiences: ['ACCOUNTANT' as const, 'OWNER' as const] },
  { offsetDays: 1, level: 'OVERDUE' as const, audiences: ['OWNER' as const] },
  { offsetDays: 5, level: 'ESCALATED' as const, audiences: ['OWNER' as const] },
]);

const LADDER_PREVENTIVE = Object.freeze([
  { offsetDays: -5, level: 'EARLY' as const, audiences: ['ACCOUNTANT' as const] },
  { offsetDays: -2, level: 'DUE_SOON' as const, audiences: ['ACCOUNTANT' as const, 'OWNER' as const] },
  { offsetDays: 0, level: 'DUE_TODAY' as const, audiences: ['ACCOUNTANT' as const, 'OWNER' as const] },
  { offsetDays: 1, level: 'OVERDUE' as const, audiences: ['OWNER' as const] },
]);

const FROM = isoDate('2017-07-01');

/**
 * The catalogue.
 *
 * Read it as a table of readings of notifications, not as the law itself. Every date here is the
 * date this product believes applies; the belief is dated, versioned, attributed to a source and
 * marked unchecked.
 */
export const OBLIGATION_CATALOGUE: readonly ObligationDefinition[] = Object.freeze([
  {
    code: 'GSTR1',
    version: 1,
    kind: 'STATUTORY',
    title: bilingual('GSTR-1 — your sales list', 'GSTR-1 — aapki bikri ki list'),
    description: bilingual(
      'The month-by-month list of everything you sold. Your buyers see their purchase credit from this, so a late one holds up their money as well as yours.',
      'Har mahine ki bikri ki poori list. Aapke buyer ka credit isi se banta hai, isliye der hone par unka paisa bhi ruk jaata hai.',
    ),
    cadence: 'MONTHLY',
    effectiveFrom: FROM,
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      filingFrequencies: ['MONTHLY'],
      requiredFacts: ['registrationType', 'gstFilingFrequency'],
    },
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day: 11 },
    dueDateShift: 'NONE',
    ladder: LADDER_STATUTORY,
    consequence: bilingual(
      'Filing late adds a daily late fee until it is filed, and your buyers cannot see their credit for these bills until you do.',
      'Der se file karne par rozana late fee lagti hai, aur tab tak aapke buyer ko in bills ka credit nahin dikhta.',
    ),
    nextAction: bilingual('Open the sales return and check the bills before filing.', 'Sales return kholein aur file karne se pehle bills dekh lein.'),
    actionCode: 'OPEN_GSTR1_WORKSPACE',
    sourceRef: 'cbic:gstr1-monthly-due-date',
    reviewState: 'DRAFT',
  },
  {
    code: 'GSTR1',
    version: 2,
    kind: 'STATUTORY',
    title: bilingual('GSTR-1 — your sales list (quarterly)', 'GSTR-1 — aapki bikri ki list (teen maheene)'),
    description: bilingual(
      'The quarterly sales list for a business on the QRMP scheme. The months inside the quarter are still reported month by month.',
      'QRMP scheme wale business ki teen maheene ki bikri list. Andar ke mahine phir bhi alag alag report hote hain.',
    ),
    cadence: 'QUARTERLY',
    effectiveFrom: isoDate('2021-01-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      filingFrequencies: ['QUARTERLY'],
      requiredFacts: ['registrationType', 'gstFilingFrequency'],
    },
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day: 13 },
    dueDateShift: 'NONE',
    ladder: LADDER_STATUTORY,
    consequence: bilingual(
      'Filing late adds a daily late fee, and your buyers cannot see their credit for the quarter until it is filed.',
      'Der se file karne par rozana late fee lagti hai, aur tab tak buyer ko is quarter ka credit nahin dikhta.',
    ),
    nextAction: bilingual('Open the sales return for the quarter and check the bills before filing.', 'Quarter ka sales return kholein aur bills dekh kar file karein.'),
    actionCode: 'OPEN_GSTR1_WORKSPACE',
    sourceRef: 'cbic:gstr1-qrmp-due-date',
    reviewState: 'DRAFT',
  },
  {
    code: 'GSTR3B',
    version: 1,
    kind: 'STATUTORY',
    title: bilingual('GSTR-3B — your summary and tax payment', 'GSTR-3B — summary aur tax bharna'),
    description: bilingual(
      'The monthly summary where the tax you owe is worked out and paid. This is the one that costs interest if it is late.',
      'Har mahine ka summary jisme tax banta hai aur bharna hota hai. Der hui to isi par interest lagta hai.',
    ),
    cadence: 'MONTHLY',
    effectiveFrom: FROM,
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      filingFrequencies: ['MONTHLY'],
      requiredFacts: ['registrationType', 'gstFilingFrequency'],
    },
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day: 20 },
    dueDateShift: 'NONE',
    ladder: LADDER_STATUTORY,
    consequence: bilingual(
      'Late filing carries a daily late fee and interest on the tax that was due, counted from this date.',
      'Der se file karne par rozana late fee aur bakaya tax par is date se interest lagta hai.',
    ),
    nextAction: bilingual('Settle the purchase mismatches, then check the summary and pay.', 'Purchase ke farak nipta lein, phir summary dekh kar tax bharein.'),
    actionCode: 'OPEN_GSTR3B_WORKSPACE',
    sourceRef: 'cbic:gstr3b-monthly-due-date',
    reviewState: 'DRAFT',
  },
  {
    code: 'GSTR3B',
    version: 2,
    kind: 'STATUTORY',
    title: bilingual('GSTR-3B — your quarterly summary and tax payment', 'GSTR-3B — teen maheene ka summary aur tax'),
    description: bilingual(
      'The quarterly summary for a QRMP filer. The due date is not the same in every state.',
      'QRMP filer ka teen maheene ka summary. Har state mein date ek jaisi nahin hoti.',
    ),
    cadence: 'QUARTERLY',
    effectiveFrom: isoDate('2021-01-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      filingFrequencies: ['QUARTERLY'],
      requiredFacts: ['registrationType', 'gstFilingFrequency', 'stateCode'],
    },
    dueRule: {
      kind: 'DAY_OF_MONTH_AFTER_PERIOD',
      monthsAfter: 1,
      day: 24,
      byState: [
        { day: 22, stateCodes: QUARTERLY_GROUP_X },
        { day: 24, stateCodes: QUARTERLY_GROUP_Y },
      ],
    },
    dueDateShift: 'NONE',
    ladder: LADDER_STATUTORY,
    consequence: bilingual(
      'Late filing carries a daily late fee and interest on the tax that was due, counted from this date.',
      'Der se file karne par rozana late fee aur bakaya tax par is date se interest lagta hai.',
    ),
    nextAction: bilingual('Settle the purchase mismatches, then check the summary and pay.', 'Purchase ke farak nipta lein, phir summary dekh kar tax bharein.'),
    actionCode: 'OPEN_GSTR3B_WORKSPACE',
    sourceRef: 'cbic:gstr3b-qrmp-due-date',
    reviewState: 'DRAFT',
  },
  {
    code: 'CMP08',
    version: 1,
    kind: 'STATUTORY',
    title: bilingual('CMP-08 — quarterly statement and payment', 'CMP-08 — teen maheene ka statement aur payment'),
    description: bilingual(
      'The quarterly statement a composition dealer files with the tax for the quarter.',
      'Composition dealer ka teen maheene ka statement, jiske saath tax bhara jaata hai.',
    ),
    cadence: 'QUARTERLY',
    effectiveFrom: isoDate('2019-04-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['COMPOSITION'],
      requiredFacts: ['registrationType'],
    },
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day: 18 },
    dueDateShift: 'NONE',
    ladder: LADDER_STATUTORY,
    consequence: bilingual('Late filing carries a daily late fee and interest on the tax for the quarter.', 'Der hone par rozana late fee aur quarter ke tax par interest lagta hai.'),
    nextAction: bilingual('Check the quarter’s sales total and pay the tax.', 'Quarter ki kul bikri dekh kar tax bhar dein.'),
    actionCode: 'OPEN_CMP08_WORKSPACE',
    sourceRef: 'cbic:cmp08-due-date',
    reviewState: 'DRAFT',
  },
  {
    code: 'GSTR9',
    version: 1,
    kind: 'STATUTORY',
    title: bilingual('GSTR-9 — the annual return', 'GSTR-9 — saal ka return'),
    description: bilingual(
      'The once-a-year return that ties the whole financial year together.',
      'Saal mein ek baar ka return jo poore saal ka hisaab jodta hai.',
    ),
    cadence: 'ANNUAL',
    effectiveFrom: FROM,
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      requiredFacts: ['registrationType'],
    },
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 9, day: 31 },
    dueDateShift: 'NONE',
    ladder: LADDER_STATUTORY,
    consequence: bilingual('Filing late adds a daily late fee for every day of delay.', 'Der se file karne par har din ki late fee lagti hai.'),
    nextAction: bilingual('Check the year’s figures against your books before filing.', 'File karne se pehle saal ke figures apni books se mila lein.'),
    actionCode: 'OPEN_ANNUAL_RETURN',
    sourceRef: 'cbic:gstr9-due-date',
    reviewState: 'DRAFT',
  },
  {
    code: 'IRN_REPORTING',
    version: 1,
    kind: 'STATUTORY',
    title: bilingual('Report this invoice for its IRN', 'Is invoice ka IRN lena hai'),
    description: bilingual(
      'An invoice that needs an e-invoice must be reported to the portal within thirty days of its date. After that the portal will not accept it at all.',
      'Jis invoice par e-invoice zaroori hai, use invoice ki date se tees din ke andar portal par bhejna hota hai. Uske baad portal use leta hi nahin.',
    ),
    cadence: 'EVENT',
    effectiveFrom: isoDate('2023-11-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      requiresEInvoice: true,
      requiredFacts: ['registrationType', 'eInvoiceApplicable'],
    },
    dueRule: { kind: 'DAYS_AFTER_EVENT', days: 30 },
    dueDateShift: 'NONE',
    ladder: LADDER_PREVENTIVE,
    consequence: bilingual(
      'After the window closes the portal refuses the invoice, and an invoice without an IRN is not a valid invoice — your buyer loses the credit on it.',
      'Window band hone ke baad portal invoice leta nahin, aur bina IRN ke invoice valid nahin — buyer ka credit chala jaata hai.',
    ),
    nextAction: bilingual('Send this invoice to the portal now.', 'Yeh invoice abhi portal par bhejein.'),
    actionCode: 'GENERATE_IRN',
    sourceRef: 'cbic:irn-reporting-window',
    reviewState: 'DRAFT',
  },
  {
    code: 'EWAY_VALIDITY',
    version: 1,
    kind: 'POLICY',
    title: bilingual('This e-way bill runs out', 'Is e-way bill ki validity khatam ho rahi hai'),
    description: bilingual(
      'The goods are still on the road and the e-way bill expires. Extend it before it lapses, not after.',
      'Maal abhi raaste mein hai aur e-way bill khatam ho raha hai. Khatam hone se pehle badhaayein.',
    ),
    cadence: 'EVENT',
    effectiveFrom: isoDate('2018-04-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR', 'COMPOSITION'],
      requiresGoodsMovement: true,
      requiredFacts: ['registrationType', 'movesGoods'],
    },
    dueRule: { kind: 'DAYS_AFTER_EVENT', days: 0 },
    dueDateShift: 'NONE',
    ladder: LADDER_PREVENTIVE,
    consequence: bilingual(
      'Goods moving on a lapsed e-way bill can be stopped and the vehicle detained.',
      'Khatam ho chuke e-way bill par maal pakda ja sakta hai aur gaadi rok li jaati hai.',
    ),
    nextAction: bilingual('Extend the e-way bill while the goods are still in transit.', 'Maal raaste mein hai tabhi e-way bill badha dein.'),
    actionCode: 'EXTEND_EWAY_BILL',
    sourceRef: 'cbic:eway-validity-extension',
    reviewState: 'DRAFT',
  },
  {
    code: 'ITC_REVIEW',
    version: 1,
    kind: 'POLICY',
    title: bilingual('Settle the purchase mismatches before you file', 'File karne se pehle purchase ke farak nipta lein'),
    description: bilingual(
      'Purchases that do not match what your suppliers told the government. Sort these out before the summary return, because the credit you claim depends on them.',
      'Woh purchases jo suppliers ke bataye record se nahin milte. Summary return se pehle suljhaayein, kyunki credit inhi par tika hai.',
    ),
    cadence: 'MONTHLY',
    effectiveFrom: isoDate('2020-01-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      requiredFacts: ['registrationType'],
    },
    // Three days before the monthly summary return, which is what makes it preventive rather than
    // an autopsy. A quarterly filer's own summary date is later; the review still happens monthly,
    // because the mismatch a business can still fix is this month's, not last quarter's.
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day: 17 },
    dueDateShift: 'NONE',
    ladder: LADDER_PREVENTIVE,
    consequence: bilingual(
      'Unsettled mismatches either take credit you are not entitled to or leave credit you are entitled to unclaimed. Both are corrected later at your cost.',
      'Bina suljhe farak ya to galat credit dila dete hain ya sahi credit chhod dete hain. Dono baad mein aapke kharche par theek hote hain.',
    ),
    nextAction: bilingual('Open the purchase comparison and answer the unmatched bills.', 'Purchase comparison kholein aur na-milne wale bills ka jawab dein.'),
    actionCode: 'OPEN_ITC_WORKSPACE',
    sourceRef: null,
    reviewState: 'APPROVED',
  },
  {
    code: 'EINVOICE_BACKLOG',
    version: 1,
    kind: 'POLICY',
    title: bilingual('Invoices still waiting for an IRN', 'Jin invoices ka IRN abhi baaki hai'),
    description: bilingual(
      'A monthly sweep of the invoices that needed an e-invoice and have not got one yet.',
      'Har mahine dekha jaata hai ki kin invoices par e-invoice zaroori tha aur abhi tak liya nahin gaya.',
    ),
    cadence: 'MONTHLY',
    effectiveFrom: isoDate('2023-11-01'),
    effectiveTo: null,
    applicability: {
      registrationTypes: ['REGULAR'],
      requiresEInvoice: true,
      requiredFacts: ['registrationType', 'eInvoiceApplicable'],
    },
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day: 10 },
    dueDateShift: 'NONE',
    ladder: LADDER_PREVENTIVE,
    consequence: bilingual(
      'An invoice that never reaches the portal cannot be reported at all after thirty days, and your buyer loses the credit on it.',
      'Jo invoice portal tak pahunchi hi nahin, tees din baad bheji hi nahin ja sakti, aur buyer ka credit chala jaata hai.',
    ),
    nextAction: bilingual('Send the remaining invoices to the portal.', 'Bachi hui invoices portal par bhej dein.'),
    actionCode: 'OPEN_EINVOICE_QUEUE',
    sourceRef: null,
    reviewState: 'APPROVED',
  },
]);

/**
 * The versions of one obligation that govern a date, newest first.
 *
 * The date passed in is the period's own end date, never today. That single choice is what keeps
 * history intact: an amendment effective from 1 October governs October's return and leaves July's
 * exactly as it was filed.
 */
export const definitionsFor = (
  definitions: readonly ObligationDefinition[],
  code: ObligationCode,
  on: IsoDate,
): readonly ObligationDefinition[] =>
  definitions
    .filter((definition) => definition.code === code && isEffectiveOn(definition, on))
    .sort((left, right) => right.version - left.version);

export const isEffectiveOn = (definition: ObligationDefinition, on: IsoDate): boolean =>
  definition.effectiveFrom <= on && (definition.effectiveTo === null || on <= definition.effectiveTo);

/** Every obligation code the catalogue knows, in the order a calendar should show them. */
export const catalogueCodes = (definitions: readonly ObligationDefinition[]): readonly ObligationCode[] => {
  const seen: ObligationCode[] = [];
  for (const definition of definitions) if (!seen.includes(definition.code)) seen.push(definition.code);
  return seen;
};
