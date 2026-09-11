/**
 * Issue #141 — where delivery challans are kept.
 *
 * Joins the ledger store as a transaction participant, the same way the invoice repository does,
 * so allocating a challan number and saving the challan either both happen or neither does.
 */
import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { ChallanState, DeliveryChallan } from './challan-model.ts';

export interface ChallanRepository {
  findById(companyId: CompanyId, id: string): Promise<DeliveryChallan | null>;
  findByNumber(companyId: CompanyId, number: string): Promise<DeliveryChallan | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<DeliveryChallan | null>;
  insert(challan: DeliveryChallan): Promise<void>;
  /** Replaces a challan only if nobody else changed it first. */
  update(challan: DeliveryChallan, expectedVersion: number): Promise<void>;
  list(companyId: CompanyId, filter?: { partyId?: string; state?: ChallanState; invoiceId?: string }): Promise<DeliveryChallan[]>;
}

export class InMemoryChallanRepository implements ChallanRepository, TransactionParticipant {
  #challans: DeliveryChallan[] = [];

  snapshot(): unknown {
    return [...this.#challans];
  }

  restore(taken: unknown): void {
    this.#challans = taken as DeliveryChallan[];
  }

  async findById(companyId: CompanyId, id: string): Promise<DeliveryChallan | null> {
    return this.#challans.find((c) => c.companyId === companyId && c.id === id) ?? null;
  }

  async findByNumber(companyId: CompanyId, number: string): Promise<DeliveryChallan | null> {
    return this.#challans.find((c) => c.companyId === companyId && c.number === number) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<DeliveryChallan | null> {
    return this.#challans.find((c) => c.companyId === companyId && c.idempotencyKey === key) ?? null;
  }

  async insert(challan: DeliveryChallan): Promise<void> {
    const clash = this.#challans.find(
      (c) => c.companyId === challan.companyId && (c.id === challan.id || c.idempotencyKey === challan.idempotencyKey || c.number === challan.number),
    );
    if (clash !== undefined) {
      throw conflict(
        clash.number === challan.number ? 'CHALLAN_DUPLICATE_NUMBER' : 'CHALLAN_DUPLICATE',
        clash.number === challan.number ? `Challan number ${challan.number} has already been used.` : 'This challan was already issued.',
      );
    }
    this.#challans = [...this.#challans, challan];
  }

  async update(challan: DeliveryChallan, expectedVersion: number): Promise<void> {
    const index = this.#challans.findIndex((c) => c.companyId === challan.companyId && c.id === challan.id);
    if (index === -1) throw notFound('CHALLAN_NOT_FOUND', 'That challan does not exist in this business.');
    if ((this.#challans[index] as DeliveryChallan).version !== expectedVersion) {
      throw conflict('CHALLAN_CONCURRENT_EDIT', 'Someone else changed this challan while you were working on it. Open it again to see their change.');
    }
    const next = [...this.#challans];
    next[index] = challan;
    this.#challans = next;
  }

  async list(
    companyId: CompanyId,
    filter: { partyId?: string; state?: ChallanState; invoiceId?: string } = {},
  ): Promise<DeliveryChallan[]> {
    return this.#challans.filter(
      (c) =>
        c.companyId === companyId &&
        (filter.partyId === undefined || c.partyId === filter.partyId) &&
        (filter.state === undefined || c.state === filter.state) &&
        (filter.invoiceId === undefined || c.invoice?.invoiceId === filter.invoiceId),
    );
  }
}
