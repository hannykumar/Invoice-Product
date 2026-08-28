/**
 * Issue #9 [E09] — what the sales module talks to.
 *
 * Inventory (#12) and the government registrations (#26 e-invoice, #27 e-way bill) are other
 * issues. They are consumed here as narrow ports with mocks, so finalisation can be built and
 * tested now and the real modules drop in without touching this file.
 */
import type { CompanyId, IsoDate, Quantity } from '@invoice/kernel';
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
  reserve(request: ReservationRequest): Promise<ReservationResult>;
  release(companyId: CompanyId, documentId: string): Promise<void>;
  issue(companyId: CompanyId, documentId: string): Promise<void>;
  /** Puts the goods back when a final invoice is cancelled. */
  returnToStock(companyId: CompanyId, documentId: string): Promise<void>;
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
  async reserve(request) {
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
