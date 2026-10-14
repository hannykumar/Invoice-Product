/** Issue #20 [E20] — where open bills come from, and where payments are kept. */
import type { CompanyId, PartyId } from '@invoice/kernel';
import type { OpenDocument, Payment } from './model.ts';

/**
 * Open documents.
 *
 * Sales invoices come from issue #9 and purchase bills from GPT 3's #17. This module never reads
 * either module's storage directly; it asks for the positions it needs.
 */
export interface DocumentLedgerPort {
  openDocuments(companyId: CompanyId, partyId: PartyId): Promise<readonly OpenDocument[]>;
  parties(companyId: CompanyId): Promise<readonly PartyId[]>;
  nameOf(companyId: CompanyId, partyId: PartyId): Promise<string>;
}

/**
 * Issue #366 — one page of a list, in a stable order (by id). `after` is the last id of the page
 * before. Leave it out and a list method returns everything, in the order it always did.
 */
export interface Page {
  readonly limit: number;
  readonly after?: string;
}

/** Issue #366 — the page of `rows` that `page` asks for, sorted by id. Shared by the in-memory stores. */
export const pageOf = <T extends { readonly id: string }>(rows: readonly T[], page: Page | undefined): T[] =>
  page === undefined
    ? [...rows]
    : [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).filter((r) => page.after === undefined || r.id > page.after).slice(0, page.limit);

export interface PaymentRepository {
  insert(payment: Payment): Promise<void>;
  update(payment: Payment, expectedVersion: number): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<Payment | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<Payment | null>;
  listForParty(companyId: CompanyId, partyId: PartyId, page?: Page): Promise<Payment[]>;
  list(companyId: CompanyId, page?: Page): Promise<Payment[]>;
}
