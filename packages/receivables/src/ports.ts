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

export interface PaymentRepository {
  insert(payment: Payment): Promise<void>;
  update(payment: Payment, expectedVersion: number): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<Payment | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<Payment | null>;
  listForParty(companyId: CompanyId, partyId: PartyId): Promise<Payment[]>;
  list(companyId: CompanyId): Promise<Payment[]>;
}
