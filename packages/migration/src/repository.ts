/** Issue #37 [E37] — where a batch and its file live between arriving and being approved. */
import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { ImportBatch } from './model.ts';
import type { MigrationBatchStore, MigrationSourceStore } from './ports.ts';

export class InMemoryMigrationStore implements MigrationBatchStore, MigrationSourceStore, TransactionParticipant {
  #batches: ImportBatch[] = [];
  #sources = new Map<string, string>();

  snapshot(): unknown {
    return { batches: [...this.#batches], sources: new Map(this.#sources) };
  }

  restore(taken: unknown): void {
    const state = taken as { batches: ImportBatch[]; sources: Map<string, string> };
    this.#batches = state.batches;
    this.#sources = state.sources;
  }

  async findById(companyId: CompanyId, id: string): Promise<ImportBatch | null> {
    return this.#batches.find((batch) => batch.companyId === companyId && batch.id === id) ?? null;
  }

  /** The most recent batch for these bytes, so "you already brought this in" names the right one. */
  async findByDigest(companyId: CompanyId, digest: string): Promise<ImportBatch | null> {
    const matches = this.#batches.filter((batch) => batch.companyId === companyId && batch.digest === digest);
    return matches[matches.length - 1] ?? null;
  }

  async list(companyId: CompanyId): Promise<readonly ImportBatch[]> {
    return this.#batches.filter((batch) => batch.companyId === companyId);
  }

  async insert(batch: ImportBatch): Promise<void> {
    if (this.#batches.some((existing) => existing.companyId === batch.companyId && existing.id === batch.id)) {
      throw conflict('MIGRATION_BATCH_EXISTS', 'That import has already been started.');
    }
    this.#batches = [...this.#batches, batch];
  }

  async update(batch: ImportBatch, expectedVersion: number): Promise<void> {
    const index = this.#batches.findIndex((existing) => existing.companyId === batch.companyId && existing.id === batch.id);
    if (index === -1) throw notFound('MIGRATION_BATCH_NOT_FOUND', 'That import does not exist for this business.');
    const current = this.#batches[index] as ImportBatch;
    if (current.version !== expectedVersion) {
      throw conflict(
        'MIGRATION_CONCURRENT_EDIT',
        'Someone else changed this import while you were working on it. Open it again to see where it has got to.',
      );
    }
    const next = [...this.#batches];
    next[index] = batch;
    this.#batches = next;
  }

  async putSource(companyId: CompanyId, batchId: string, text: string): Promise<void> {
    this.#sources.set(`${companyId}:${batchId}`, text);
  }

  async source(companyId: CompanyId, batchId: string): Promise<string | null> {
    return this.#sources.get(`${companyId}:${batchId}`) ?? null;
  }
}
