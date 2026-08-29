/** Issue #20 [E20] — the in-memory payment store, joined to the ledger's transaction. */
import { conflict, notFound, type CompanyId, type PartyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { Payment } from './model.ts';
import type { PaymentRepository } from './ports.ts';

export class InMemoryPaymentRepository implements PaymentRepository, TransactionParticipant {
  #payments: Payment[] = [];
  #keys = new Map<string, string>();

  snapshot(): unknown {
    return { payments: [...this.#payments], keys: new Map(this.#keys) };
  }

  restore(taken: unknown): void {
    const state = taken as { payments: Payment[]; keys: Map<string, string> };
    this.#payments = state.payments;
    this.#keys = state.keys;
  }

  async insert(payment: Payment): Promise<void> {
    const composite = `${payment.companyId}:${payment.idempotencyKey}`;
    if (this.#keys.has(composite)) throw conflict('PAYMENT_DUPLICATE', 'This payment was already recorded.');
    this.#payments = [...this.#payments, payment];
    this.#keys = new Map(this.#keys).set(composite, payment.id);
  }

  async update(payment: Payment, expectedVersion: number): Promise<void> {
    const index = this.#payments.findIndex((p) => p.companyId === payment.companyId && p.id === payment.id);
    if (index === -1) throw notFound('PAYMENT_NOT_FOUND', 'That payment does not exist in this business.');
    const current = this.#payments[index] as Payment;
    if (current.version !== expectedVersion) {
      throw conflict(
        'PAYMENT_CONCURRENT_EDIT',
        'Someone else changed this payment while you were working on it. Open it again to see their changes.',
      );
    }
    const next = [...this.#payments];
    next[index] = payment;
    this.#payments = next;
  }

  async findById(companyId: CompanyId, id: string): Promise<Payment | null> {
    return this.#payments.find((p) => p.companyId === companyId && p.id === id) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<Payment | null> {
    const id = this.#keys.get(`${companyId}:${key}`);
    return id === undefined ? null : this.findById(companyId, id);
  }

  async listForParty(companyId: CompanyId, partyId: PartyId): Promise<Payment[]> {
    return this.#payments.filter((p) => p.companyId === companyId && p.partyId === partyId);
  }

  async list(companyId: CompanyId): Promise<Payment[]> {
    return this.#payments.filter((p) => p.companyId === companyId);
  }
}
