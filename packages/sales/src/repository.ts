/**
 * Issue #9 [E09] — the in-memory sales repository.
 *
 * It registers itself with the ledger store as a transaction participant, so that allocating an
 * invoice number, posting the entry and saving the invoice either all happen or none of them do.
 * In Postgres that is one transaction; here it is a snapshot and a restore.
 */
import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { SalesInvoice } from './model.ts';
import type { SalesRepository } from './ports.ts';

interface State {
  invoices: SalesInvoice[];
}

export class InMemorySalesRepository implements SalesRepository, TransactionParticipant {
  #state: State = { invoices: [] };

  snapshot(): unknown {
    return { invoices: [...this.#state.invoices] };
  }

  restore(taken: unknown): void {
    this.#state = taken as State;
  }

  async findById(companyId: CompanyId, id: string): Promise<SalesInvoice | null> {
    return this.#state.invoices.find((i) => i.companyId === companyId && i.id === id) ?? null;
  }

  async findByNumber(companyId: CompanyId, number: string): Promise<SalesInvoice | null> {
    return this.#state.invoices.find((i) => i.companyId === companyId && i.number === number) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<SalesInvoice | null> {
    return this.#state.invoices.find((i) => i.companyId === companyId && i.idempotencyKey === key) ?? null;
  }

  async insert(invoice: SalesInvoice): Promise<void> {
    const clash = this.#state.invoices.find(
      (i) => i.companyId === invoice.companyId && (i.id === invoice.id || i.idempotencyKey === invoice.idempotencyKey),
    );
    if (clash !== undefined) throw conflict('SALES_DUPLICATE_INVOICE', 'This bill was already started.');
    if (invoice.number !== null) {
      const numberClash = this.#state.invoices.find((i) => i.companyId === invoice.companyId && i.number === invoice.number);
      if (numberClash !== undefined) {
        throw conflict('SALES_DUPLICATE_NUMBER', `Bill number ${invoice.number} has already been used.`);
      }
    }
    this.#state = { invoices: [...this.#state.invoices, invoice] };
  }

  async update(invoice: SalesInvoice, expectedVersion: number): Promise<void> {
    const index = this.#state.invoices.findIndex((i) => i.companyId === invoice.companyId && i.id === invoice.id);
    if (index === -1) throw notFound('SALES_INVOICE_NOT_FOUND', 'That bill does not exist in this business.');
    const current = this.#state.invoices[index] as SalesInvoice;
    if (current.version !== expectedVersion) {
      throw conflict(
        'SALES_CONCURRENT_EDIT',
        'Someone else changed this bill while you were working on it. Open it again to see their changes.',
      );
    }
    if (invoice.number !== null && current.number === null) {
      const numberClash = this.#state.invoices.find(
        (i) => i.companyId === invoice.companyId && i.number === invoice.number && i.id !== invoice.id,
      );
      if (numberClash !== undefined) {
        throw conflict('SALES_DUPLICATE_NUMBER', `Bill number ${invoice.number} has already been used.`);
      }
    }
    const next = [...this.#state.invoices];
    next[index] = invoice;
    this.#state = { invoices: next };
  }

  async remove(companyId: CompanyId, id: string): Promise<void> {
    const current = this.#state.invoices.find((i) => i.companyId === companyId && i.id === id);
    if (current === undefined) return;
    // Issue #256 — a numbered or posted bill is part of the books and is never removed.
    if (current.number !== null || current.voucherId !== null) {
      throw conflict('SALES_ISSUED_NOT_REMOVABLE', `${current.number ?? 'This bill'} has been issued, so it stays on record.`);
    }
    this.#state = { invoices: this.#state.invoices.filter((i) => i !== current) };
  }

  async list(
    companyId: CompanyId,
    filter: { partyId?: string; state?: SalesInvoice['state'] } = {},
  ): Promise<SalesInvoice[]> {
    return this.#state.invoices.filter(
      (i) =>
        i.companyId === companyId &&
        (filter.partyId === undefined || i.partyId === filter.partyId) &&
        (filter.state === undefined || i.state === filter.state),
    );
  }
}
