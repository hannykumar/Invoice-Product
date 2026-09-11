/**
 * Issue #142 — where quotations and proforma invoices are kept.
 *
 * Joins the ledger store as a transaction participant, the same way the invoice and challan
 * repositories do, so allocating a number and saving the document either both happen or neither does.
 * Joining the store is not posting to it: nothing here writes an entry in the books.
 */
import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { PreSaleDocument, PreSaleKind, PreSaleState } from './presale-model.ts';

export interface PreSaleFilter {
  readonly kind?: PreSaleKind;
  readonly state?: PreSaleState;
  readonly partyId?: string;
  /** The invoice a proforma was billed on, or the draft a quotation became. */
  readonly invoiceId?: string;
}

export interface PreSaleRepository {
  findById(companyId: CompanyId, id: string): Promise<PreSaleDocument | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<PreSaleDocument | null>;
  insert(document: PreSaleDocument): Promise<void>;
  /** Replaces a document only if nobody else changed it first. */
  update(document: PreSaleDocument, expectedVersion: number): Promise<void>;
  list(companyId: CompanyId, filter?: PreSaleFilter): Promise<PreSaleDocument[]>;
}

export class InMemoryPreSaleRepository implements PreSaleRepository, TransactionParticipant {
  #documents: PreSaleDocument[] = [];

  snapshot(): unknown {
    return [...this.#documents];
  }

  restore(taken: unknown): void {
    this.#documents = taken as PreSaleDocument[];
  }

  async findById(companyId: CompanyId, id: string): Promise<PreSaleDocument | null> {
    return this.#documents.find((d) => d.companyId === companyId && d.id === id) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<PreSaleDocument | null> {
    return this.#documents.find((d) => d.companyId === companyId && d.idempotencyKey === key) ?? null;
  }

  async insert(document: PreSaleDocument): Promise<void> {
    const clash = this.#documents.find(
      (d) =>
        d.companyId === document.companyId &&
        (d.id === document.id || d.idempotencyKey === document.idempotencyKey || (d.kind === document.kind && d.number === document.number)),
    );
    if (clash !== undefined) {
      const sameNumber = clash.kind === document.kind && clash.number === document.number;
      throw conflict(
        sameNumber ? 'PRESALE_DUPLICATE_NUMBER' : 'PRESALE_DUPLICATE',
        sameNumber ? `Number ${document.number} has already been used.` : 'This document was already issued.',
      );
    }
    this.#documents = [...this.#documents, document];
  }

  async update(document: PreSaleDocument, expectedVersion: number): Promise<void> {
    const index = this.#documents.findIndex((d) => d.companyId === document.companyId && d.id === document.id);
    if (index === -1) throw notFound('PRESALE_NOT_FOUND', 'That quotation or proforma does not exist in this business.');
    if ((this.#documents[index] as PreSaleDocument).version !== expectedVersion) {
      throw conflict('PRESALE_CONCURRENT_EDIT', 'Someone else changed this document while you were working on it. Open it again to see their change.');
    }
    const next = [...this.#documents];
    next[index] = document;
    this.#documents = next;
  }

  async list(companyId: CompanyId, filter: PreSaleFilter = {}): Promise<PreSaleDocument[]> {
    return this.#documents.filter(
      (d) =>
        d.companyId === companyId &&
        (filter.kind === undefined || d.kind === filter.kind) &&
        (filter.state === undefined || d.state === filter.state) &&
        (filter.partyId === undefined || d.partyId === filter.partyId) &&
        (filter.invoiceId === undefined || d.invoice?.invoiceId === filter.invoiceId || d.sale?.invoiceId === filter.invoiceId),
    );
  }
}
