import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { ReturnNote, SupplierCreditNoteRef } from './model.ts';
import type { ReturnNoteRepository } from './ports.ts';

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

  async listForOriginal(companyId: CompanyId, originalDocumentId: string): Promise<ReturnNote[]> {
    return this.#notes.filter((note) => note.companyId === companyId && note.originalDocument.id === originalDocumentId);
  }

  async list(companyId: CompanyId): Promise<ReturnNote[]> {
    return this.#notes.filter((note) => note.companyId === companyId);
  }

  async setSupplierCreditNote(companyId: CompanyId, id: string, reference: SupplierCreditNoteRef): Promise<ReturnNote> {
    const index = this.#notes.findIndex((note) => note.companyId === companyId && note.id === id);
    if (index < 0) throw notFound('RETURN_NOTE_NOT_FOUND', 'We could not find that return in this business.');
    const updated = Object.freeze({ ...(this.#notes[index] as ReturnNote), supplierCreditNote: { number: reference.number, date: reference.date } });
    this.#notes = this.#notes.map((note, at) => (at === index ? updated : note));
    return updated;
  }
}
