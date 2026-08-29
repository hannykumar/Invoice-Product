/** Issue #36 [E36] — where a half-finished setup lives while the shopkeeper serves a customer. */
import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { OnboardingSession } from './model.ts';

export interface OnboardingRepository {
  findById(companyId: CompanyId, id: string): Promise<OnboardingSession | null>;
  findOpenForCompany(companyId: CompanyId): Promise<OnboardingSession | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<OnboardingSession | null>;
  insert(session: OnboardingSession, idempotencyKey: string): Promise<void>;
  update(session: OnboardingSession, expectedVersion: number): Promise<void>;
}

export class InMemoryOnboardingRepository implements OnboardingRepository, TransactionParticipant {
  #sessions: OnboardingSession[] = [];
  #keys = new Map<string, string>();

  snapshot(): unknown {
    return { sessions: [...this.#sessions], keys: new Map(this.#keys) };
  }

  restore(taken: unknown): void {
    const state = taken as { sessions: OnboardingSession[]; keys: Map<string, string> };
    this.#sessions = state.sessions;
    this.#keys = state.keys;
  }

  async findById(companyId: CompanyId, id: string): Promise<OnboardingSession | null> {
    return this.#sessions.find((s) => s.companyId === companyId && s.id === id) ?? null;
  }

  async findOpenForCompany(companyId: CompanyId): Promise<OnboardingSession | null> {
    return this.#sessions.find((s) => s.companyId === companyId && s.state === 'IN_PROGRESS') ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<OnboardingSession | null> {
    const id = this.#keys.get(`${companyId}:${key}`);
    return id === undefined ? null : this.findById(companyId, id);
  }

  async insert(session: OnboardingSession, idempotencyKey: string): Promise<void> {
    const composite = `${session.companyId}:${idempotencyKey}`;
    if (this.#keys.has(composite)) throw conflict('ONBOARDING_ALREADY_STARTED', 'Setup was already started.');
    this.#sessions = [...this.#sessions, session];
    this.#keys.set(composite, session.id);
  }

  async update(session: OnboardingSession, expectedVersion: number): Promise<void> {
    const index = this.#sessions.findIndex((s) => s.companyId === session.companyId && s.id === session.id);
    if (index === -1) throw notFound('ONBOARDING_NOT_FOUND', 'That setup does not exist for this business.');
    const current = this.#sessions[index] as OnboardingSession;
    if (current.version !== expectedVersion) {
      throw conflict(
        'ONBOARDING_CONCURRENT_EDIT',
        'Someone else changed this setup while you were working on it. Open it again to see their changes.',
      );
    }
    const next = [...this.#sessions];
    next[index] = session;
    this.#sessions = next;
  }
}
