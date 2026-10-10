/**
 * Issue #9 [E09] — what the sales module talks to.
 *
 * Inventory (#12) and the government registrations (#26 e-invoice, #27 e-way bill) are other
 * issues. They are consumed here as narrow ports with mocks, so finalisation can be built and
 * tested now and the real modules drop in without touching this file.
 */
import type { CompanyId, IsoDate, Quantity } from '@invoice/kernel';
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
  /**
   * Issue #256 — forgets a bill that was never issued. Only ever called for an unnumbered draft
   * with no entry in the books (see `SalesService.discardDraft`); an issued bill is never removed.
   */
  remove(companyId: CompanyId, id: string): Promise<void>;
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
  /**
   * Issue #306 — the same answer as `reserve`, with nothing held and nothing written. Optional: an
   * inventory that cannot say leaves the live total without a stock check, and the review still
   * makes it.
   */
  check?(actor: ActorContext, request: ReservationRequest): Promise<ReservationResult>;
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
 * Issues #26 and #27. The books must not wait for a government service — see message
 * `gov.service_unavailable` in issue #46.
 *
 * Issue #363 — `onInvoiceFinalised` runs inside the bill's transaction, so its request is saved
 * with the bill or not at all. An implementation must therefore only queue the request (the
 * transactional outbox, docs/contracts/unit-of-work-v1.md); it must never call out from here.
 */
export interface ComplianceHookPort {
  onInvoiceFinalised(invoice: SalesInvoice): Promise<readonly GovernmentRegistration[]>;
  onInvoiceCancelled(invoice: SalesInvoice): Promise<void>;
}

/**
 * Issue #233 — something outside the sales module that stops an issued bill being cancelled.
 *
 * A bill may be cancelled only while it is not yet in an approved or filed GST return, has no
 * credit note against it, and has no live e-invoice or e-way bill with the government. Those facts
 * live in other modules, so they are asked here rather than copied in.
 *
 * `clearable` marks a stop the person can remove from this same screen: an e-invoice or e-way bill
 * still inside the government's window can be cancelled with the portal first. Everything else
 * (an approved month, a credit note, a closed window) sends them to a credit note instead.
 */
export interface CancelBlocker {
  readonly code: string;
  readonly message: string;
  readonly clearable: 'EINVOICE' | 'EWAY_BILL' | null;
}

export interface CancellationGuardPort {
  blockers(actor: ActorContext, invoice: SalesInvoice): Promise<readonly CancelBlocker[]>;
}

export const noCancellationGuard: CancellationGuardPort = {
  async blockers() {
    return [];
  },
};

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
