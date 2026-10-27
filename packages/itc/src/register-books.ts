/**
 * Issue #366 — the purchase comparison's view of our own books, read from where the books live.
 *
 * There is no table of "ITC purchases" and there must not be one. A posted bill (#17), a return of
 * goods (#249) and the reverse-charge register already hold every figure this module compares, in
 * PostgreSQL, under forced row-level security, immutable once posted. A second copy of them for
 * this module would be a second set of books that could disagree with the first — and a credit
 * claimed against the wrong one is a claim the department can disallow. So the books port is
 * *derived*, on every call, from those records, and restart-safe and shared between API processes
 * because they are.
 *
 * What this class owns is the conversion that used to sit inline in the application's
 * composition: which month a bill belongs to, which supplier registration it is compared under,
 * and what a bill's reverse-charge time of supply does to its month. Every rule below is carried
 * over unchanged from there; none is new.
 *
 *  - A bill whose supplier has no GST number on their master record travels with
 *    `supplierGstin: null` and is reported as a question, never matched on its number alone.
 *  - A bill the portal does not carry is never credit. That decision is the service's
 *    (`service.ts`, `match.ts`) and nothing here can soften it: this class only supplies facts.
 *  - Reverse charge (CGST Act s.12(3) goods / s.13(3) services): the bill is handed over from
 *    whichever month comes first, its own or its time of supply, because the credit comes from
 *    paying the tax. s.16 (eligibility), s.16(2)(aa) (supplier's details in GSTR-2B), s.17(5)
 *    (blocked credit) and Rule 37 (180 days) are applied by the service; not here.
 *
 * The sources are narrow ports so the sibling conversions (master data, to async PostgreSQL) plug
 * in without this file changing.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import { purchaseBillToBookDocument, purchaseReturnToBookDocument, type PostedBillLike, type PurchaseReturnLike } from './adapters.ts';
import type { PurchaseBookPort } from './ports.ts';
import type { BookPurchaseDocument, TaxPeriod } from './types.ts';

/** Posted purchase bills, oldest first. Backed by `purchase_bills` on PostgreSQL. */
export interface PostedBillSource {
  list(companyId: CompanyId): Promise<readonly PostedBillLike[]>;
  findById(companyId: CompanyId, id: string): Promise<PostedBillLike | null>;
}

/** Return notes of either kind; only purchase returns are used. Backed by `return_notes`. */
export interface PurchaseReturnSource {
  list(companyId: CompanyId): Promise<readonly (Omit<PurchaseReturnLike, 'kind'> & { readonly kind: string })[]>;
}

/** What the supplier's master record says about their registration. */
export interface SupplierRegistrationSource {
  gstinOf(companyId: CompanyId, partyId: string): Promise<string | null> | string | null;
  /** 'unregistered' | 'exempt_only' | 'composition' | 'regular' …, or null when unknown. */
  registrationOf(companyId: CompanyId, partyId: string): Promise<string | null> | string | null;
}

/** When a reverse-charge bill's GST falls due, or null for any other bill. */
export type TaxPointSource = (companyId: CompanyId, billId: string) => Promise<IsoDate | null>;

export class RegisterPurchaseBooks implements PurchaseBookPort {
  readonly #bills: PostedBillSource;
  readonly #returns: PurchaseReturnSource;
  readonly #suppliers: SupplierRegistrationSource;
  readonly #taxPoint: TaxPointSource;

  constructor(sources: {
    readonly bills: PostedBillSource;
    readonly returns: PurchaseReturnSource;
    readonly suppliers: SupplierRegistrationSource;
    readonly taxPointOf?: TaxPointSource;
  }) {
    this.#bills = sources.bills;
    this.#returns = sources.returns;
    this.#suppliers = sources.suppliers;
    this.#taxPoint = sources.taxPointOf ?? (async () => null);
  }

  async documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly BookPurchaseDocument[]> {
    const posted = await this.#bills.list(companyId);
    // Issue #289, part 2b — a reverse-charge bill's tax belongs to the month of its time of supply,
    // which can be before the bill's own month (paid in advance) or after it (a service unpaid for
    // 60 days). It is handed over from whichever month comes first.
    const taxPoints = new Map<string, IsoDate>();
    for (const bill of posted) {
      if (!bill.tax.reverseCharge) continue;
      const point = await this.#taxPoint(companyId, bill.id);
      if (point !== null) taxPoints.set(bill.id, point);
    }
    const firstMonth = (bill: PostedBillLike): string => {
      const point = taxPoints.get(bill.id);
      return point !== undefined && point.slice(0, 7) < bill.invoiceDate.slice(0, 7) ? point.slice(0, 7) : bill.invoiceDate.slice(0, 7);
    };
    const fromBills: BookPurchaseDocument[] = [];
    for (const bill of posted.filter((candidate) => firstMonth(candidate) <= period)) {
      const registration = await this.#suppliers.registrationOf(companyId, bill.supplierPartyId);
      fromBills.push(purchaseBillToBookDocument(bill, {
        gstin: await this.#suppliers.gstinOf(companyId, bill.supplierPartyId),
        // Issue #289 — a seller who is not registered sells taxable goods without GST; that is not a
        // Table 5 supply (composition, exempt, nil-rated or non-GST).
        ...(registration === 'unregistered' ? { inTable5: false } : {}),
        ...(registration !== null && ['unregistered', 'exempt_only', 'composition'].includes(registration) ? { outsideGstr2b: true as const } : {}),
        ...(taxPoints.has(bill.id) ? { taxPointDate: taxPoints.get(bill.id) as string } : {}),
      }));
    }
    // Issue #249 — every return of goods to a supplier, as a credit note linked to its bill, from the
    // month of the return.
    const returned: BookPurchaseDocument[] = [];
    for (const note of (await this.#returns.list(companyId)).filter((candidate) => candidate.kind === 'PURCHASE_RETURN' && candidate.documentDate.slice(0, 7) <= period)) {
      const bill = await this.#bills.findById(companyId, note.originalDocument.id);
      returned.push(purchaseReturnToBookDocument({ ...note, kind: 'PURCHASE_RETURN' as const }, {
        gstin: await this.#suppliers.gstinOf(companyId, String(note.partyId)),
        name: bill?.supplierName ?? String(note.partyId),
      }));
    }
    return [...fromBills, ...returned];
  }
}
