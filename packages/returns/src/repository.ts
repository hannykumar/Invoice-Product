import { conflict, invalid, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { ReturnNote, SupplierCreditNoteRef } from './model.ts';
import type { Page, ReturnNoteRepository } from './ports.ts';

/** Issue #366 — a page size is a whole number from 1 to 500. */
export const pageLimit = (page: Page): number => {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 500) {
    throw invalid('RETURN_PAGE_LIMIT_INVALID', 'Ask for between 1 and 500 returns at a time.');
  }
  return page.limit;
};

/** Issue #366 — the page of `notes` that `page` asks for, in id order; all of them when it is absent. */
const pageOf = (notes: ReturnNote[], page: Page | undefined): ReturnNote[] => {
  if (page === undefined) return notes;
  const limit = pageLimit(page);
  return notes.filter((note) => page.after === undefined || note.id > page.after)
    .sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
};

export class InMemoryReturnNoteRepository implements ReturnNoteRepository, TransactionParticipant {
  #notes: ReturnNote[] = [];

  snapshot(): unknown { return [...this.#notes]; }
  restore(taken: unknown): void { this.#notes = [...(taken as ReturnNote[])]; }

  async insert(note: ReturnNote): Promise<void> {
    const duplicate = this.#notes.find((candidate) =>
      candidate.companyId === note.companyId &&
      (candidate.id === note.id || candidate.idempotencyKey === note.idempotencyKey || candidate.number === note.number));
    if (duplicate !== undefined) {
      throw conflict('RETURN_NOTE_DUPLICATE', 'This return note has already been recorded.');
    }
    this.#notes.push(Object.freeze(note));
  }

  async findById(companyId: CompanyId, id: string): Promise<ReturnNote | null> {
    return this.#notes.find((note) => note.companyId === companyId && note.id === id) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnNote | null> {
    return this.#notes.find((note) => note.companyId === companyId && note.idempotencyKey === key) ?? null;
  }

  async listForOriginal(companyId: CompanyId, originalDocumentId: string, page?: Page): Promise<ReturnNote[]> {
    return pageOf(this.#notes.filter((note) => note.companyId === companyId && note.originalDocument.id === originalDocumentId), page);
  }

  async list(companyId: CompanyId, page?: Page): Promise<ReturnNote[]> {
    return pageOf(this.#notes.filter((note) => note.companyId === companyId), page);
  }

  async setSupplierCreditNote(companyId: CompanyId, id: string, reference: SupplierCreditNoteRef): Promise<ReturnNote> {
    const index = this.#notes.findIndex((note) => note.companyId === companyId && note.id === id && note.kind === 'PURCHASE_RETURN');
    if (index < 0) throw notFound('RETURN_NOTE_NOT_FOUND', 'We could not find that return in this business.');
    const updated = Object.freeze({ ...(this.#notes[index] as ReturnNote), supplierCreditNote: { number: reference.number, date: reference.date } });
    this.#notes = this.#notes.map((note, at) => (at === index ? updated : note));
    return updated;
  }
}
