/**
 * Issue #289, part 3 — purchases whose GST cannot be claimed back, because CGST s.17(5) blocks the
 * credit. The tax on such a line goes into what the purchase cost, not into Input GST.
 *
 * Law read 21 Oct 2026 from the current CBIC text of s.17(5) (taxinformation.cbic.gov.in), with its
 * amendment notes:
 *  - (a), (aa), (ab) substituted by the CGST (Amendment) Act 2018, s.9, from 01.02.2019;
 *  - (b) substituted by the same Act, from 01.02.2019;
 *  - (d) "plant or machinery" read as "plant and machinery" from 01.07.2017, and Explanation 2, by
 *    s.124 of the Finance Act, 2025 (No. 7 of 2025), in force 01.10.2025;
 *  - (fa) inserted by s.139 of the Finance Act 2023, from 01.10.2023 (Notification 28/2023-CT);
 *  - (i) limited to "section 74 in respect of any period up to Financial Year 2023-24" by s.119 of
 *    the Finance (No. 2) Act, 2024.
 *
 * Only the clauses a shopkeeper can meet when entering a supplier's bill are offered. Not here:
 * (e) composition purchases — decided by the supplier's record already (part 1); (f) goods received
 * by a non-resident taxable person — not this business; (h) goods lost, stolen, destroyed or written
 * off — that happens to stock after purchase, a reversal, not a purchase entry (gifts and free samples
 * from (h) are offered); (i) tax paid under s.74 — a demand, not a bill.
 *
 * The exceptions are the law's and only the person knows whether one applies, so each clause says
 * its exception in plain words; choosing the clause is saying it does not apply. The app never
 * decides a line is blocked on its own: rule 4 of the brief.
 */

export interface BlockedCreditReason {
  /** "17(5)(b)" — the clause, as it is stored on the line. */
  readonly clause: string;
  /** The short id a form sends. */
  readonly id: string;
  /** What the shopkeeper picks. */
  readonly label: string;
  /** When the law still allows the credit, said plainly. */
  readonly unless: string;
}

export const BLOCKED_CREDIT_REASONS: readonly BlockedCreditReason[] = [
  { id: 'motor_vehicle', clause: '17(5)(a)', label: 'A car or other motor vehicle for 13 people or fewer (driver included)', unless: 'unless you sell such vehicles, carry passengers for a fare, or run a driving school' },
  { id: 'vessel_aircraft', clause: '17(5)(aa)', label: 'A boat, ship or aircraft', unless: 'unless you sell them, carry passengers or goods with them, or train people to sail or fly them' },
  { id: 'vehicle_insurance_repair', clause: '17(5)(ab)', label: 'Insurance, servicing or repair of such a car, boat or aircraft', unless: 'unless the vehicle itself is used for one of those purposes, or you make such vehicles or insure them' },
  { id: 'food_health_etc', clause: '17(5)(b)', label: 'Food and drinks, outdoor catering, beauty treatment, health services, cosmetic surgery, hiring a car, life or health insurance', unless: 'unless you supply the same kind of thing onward, or it is part of a taxable supply you make, or a law makes you provide it to employees' },
  { id: 'club_fitness', clause: '17(5)(b)', label: 'Membership of a club, gym or fitness centre', unless: 'unless a law makes you provide it to employees' },
  { id: 'employee_travel', clause: '17(5)(b)', label: 'Holiday or leave travel for employees', unless: 'unless a law makes you provide it to employees' },
  { id: 'works_contract_building', clause: '17(5)(c)', label: 'Building work by a contractor on a building or other immovable property (including repairs you capitalise)', unless: 'unless it is plant and machinery, or you are a works contractor supplying the same onward' },
  { id: 'own_building', clause: '17(5)(d)', label: 'Goods or services used to build your own building or other immovable property (including repairs you capitalise)', unless: 'unless it is plant and machinery' },
  { id: 'csr', clause: '17(5)(fa)', label: 'Used for your company\'s corporate social responsibility (CSR) work', unless: 'no exception' },
  { id: 'personal_use', clause: '17(5)(g)', label: 'For personal use, not for the business', unless: 'no exception' },
  { id: 'gift_sample', clause: '17(5)(h)', label: 'Given away as gifts or free samples', unless: 'no exception' },
];

/** The reason a form names, by its id or its clause; `null` when it is blank. Throws nothing. */
export const blockedCreditReasonFor = (value: unknown): BlockedCreditReason | null | undefined => {
  const said = String(value ?? '').trim();
  if (said === '' || said === 'none' || said === 'no') return null;
  return BLOCKED_CREDIT_REASONS.find((reason) => reason.id === said || reason.clause === said) ?? undefined;
};
