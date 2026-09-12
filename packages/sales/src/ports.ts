/**
 * Issue #9 [E09] — what the sales module talks to.
 *
 * Inventory (#12) and the government registrations (#26 e-invoice, #27 e-way bill) are other
 * issues. They are consumed here as narrow ports with mocks, so finalisation can be built and
 * tested now and the real modules drop in without touching this file.
 */
import { subtract, sum, zero, type CompanyId, type IsoDate, type Money, type Quantity } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { SalesInvoice } from './model.ts';

export interface SalesRepository {
  findById(companyId: CompanyId, id: string): Promise<SalesInvoice | null>;
  findByNumber(companyId: CompanyId, number: string): Promise<SalesInvoice | null>;
  /** Lets a retry find the bill it already created instead of starting a second one. */
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<SalesInvoice | null>;
  insert(invoice: SalesInvoice): Promise<void>;
  /**
   * Replaces an invoice, but only if `expectedVersion` still matches. Two people editing one
   * draft is normal in a shop; silently overwriting one of them is not.
   */
  update(invoice: SalesInvoice, expectedVersion: number): Promise<void>;
  list(companyId: CompanyId, filter?: { partyId?: string; state?: SalesInvoice['state'] }): Promise<SalesInvoice[]>;
}

export interface ReservationRequest {
  readonly companyId: CompanyId;
  readonly documentId: string;
  readonly documentDate: IsoDate;
  readonly lines: readonly {
    lineId: string;
    itemId: string;
    warehouseId: string | null;
    quantity: Quantity;
  }[];
}

export interface StockShortfall {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly warehouseName: string;
  readonly available: string;
  readonly required: string;
  readonly shortfall: string;
  readonly unit: string;
}

export type ReservationResult =
  | { readonly ok: true; readonly reservationId: string }
  | { readonly ok: false; readonly shortfalls: readonly StockShortfall[] };

/**
 * Issue #12's surface, as this module needs it. Reserving happens when a bill is started, so two
 * tills cannot promise the same goods; issuing happens when it becomes final.
 */
export interface InventoryPort {
  reserve(actor: ActorContext, request: ReservationRequest): Promise<ReservationResult>;
  release(actor: ActorContext, documentId: string): Promise<void>;
  issue(actor: ActorContext, documentId: string, documentDate: IsoDate, number: string | null): Promise<void>;
  /** Puts the goods back when a final invoice is cancelled. */
  returnToStock(actor: ActorContext, documentId: string, documentDate: IsoDate, reason: string): Promise<void>;
}

export type GovernmentRegistrationStatus = 'NOT_APPLICABLE' | 'PENDING' | 'REGISTERED' | 'FAILED';

export interface GovernmentRegistration {
  readonly kind: 'E_INVOICE' | 'E_WAY_BILL';
  readonly status: GovernmentRegistrationStatus;
  readonly reference: string | null;
  readonly message: string | null;
}

/**
 * Issues #26 and #27. Called after the invoice is already safe in the books, because the books
 * must not wait for a government service — see message `gov.service_unavailable` in issue #46.
 */
export interface ComplianceHookPort {
  onInvoiceFinalised(invoice: SalesInvoice): Promise<readonly GovernmentRegistration[]>;
  onInvoiceCancelled(invoice: SalesInvoice): Promise<void>;
}

/** A no-op inventory adapter for tests and for lanes that do not track stock. */
export const permissiveInventory: InventoryPort = {
  async reserve(_actor, request) {
    return { ok: true, reservationId: `mock:${request.documentId}` };
  },
  async release() {},
  async issue() {},
  async returnToStock() {},
};

export const noComplianceHooks: ComplianceHookPort = {
  async onInvoiceFinalised() {
    return [];
  },
  async onInvoiceCancelled() {},
};


/**
 * Issue #145 — how much this customer has already been billed this financial year.
 *
 * Tax collected at source starts once sales to one customer cross a threshold in one financial
 * year, so the amount on today's bill cannot be worked out without the year so far. It is a port
 * of its own because a business with years of history will answer it from a running total in the
 * database, not by adding up every bill again.
 */
export interface CustomerYearSalesPort {
  billedSoFar(
    companyId: CompanyId,
    partyId: string,
    financialYear: string,
    exceptInvoiceId: string,
  ): Promise<Money>;
}

/**
 * The obvious implementation: add up the bills that were actually issued.
 *
 * Only final bills count — a draft is not a sale and a cancelled bill never was one. TCS already
 * collected is taken back out, because money held for the government is not a sale to the customer
 * and must not push them closer to the threshold a second time.
 */
export const customerYearSalesFromRepository = (repository: SalesRepository): CustomerYearSalesPort => ({
  async billedSoFar(companyId, partyId, financialYear, exceptInvoiceId) {
    const issued = await repository.list(companyId, { partyId, state: 'FINAL' });
    return sum(
      issued
        .filter((invoice) => invoice.id !== exceptInvoiceId && invoice.financialYear === financialYear)
        .map((invoice) =>
          invoice.pricing === null
            ? zero('INR')
            : subtract(invoice.pricing.totals.invoiceValue, invoice.pricing.totals.tcs),
        ),
    );
  },
});
