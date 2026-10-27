/**
 * Issue #366 (lane: GPT 2, #49) — a half-finished setup in PostgreSQL, beside
 * `InMemoryOnboardingRepository` and behaving the same (`test/onboarding-repository-contract.ts`
 * runs one suite on both).
 *
 * Unit of work v1: writes go through `requireUnitOfWork(companyId).sql`, so they commit with the
 * action or not at all, and throw `NO_UNIT_OF_WORK` when there is none. `OnboardingService` already
 * wraps every write in `store.transaction`, which on `PostgresLedgerStore` is that unit of work.
 * Reads use `tenantTransaction`. Nothing here opens a transaction of its own, and every query names
 * its company and its columns.
 */
import { conflict, notFound, type CompanyId, type UserId } from '@invoice/kernel';
import { canonicalJson } from '../../platform/src/platform.ts';
import { reviveJson } from '../../platform/src/postgres-audit.ts';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { OnboardingSession } from './model.ts';
import type { OnboardingRepository } from './repository.ts';

const COLUMNS = 'id, company_id, state, steps, answers, created_by, created_at, updated_at, opening_voucher_id, version';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();

const sessionOf = (r: Record<string, unknown>): OnboardingSession => ({
  id: String(r.id),
  companyId: String(r.company_id) as CompanyId,
  state: r.state as OnboardingSession['state'],
  steps: reviveJson(r.steps),
  answers: reviveJson(r.answers),
  createdBy: String(r.created_by) as UserId,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  openingVoucherId: r.opening_voucher_id === null ? null : String(r.opening_voucher_id),
  version: Number(r.version),
});

const alreadyStarted = () => conflict('ONBOARDING_ALREADY_STARTED', 'Setup was already started.');

export class PostgresOnboardingRepository implements OnboardingRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async #one(companyId: CompanyId, where: string, value: string): Promise<OnboardingSession | null> {
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) =>
      sql.query(`SELECT ${COLUMNS} FROM onboarding_sessions WHERE company_id = $1 AND ${where} ORDER BY seq LIMIT 1`, [companyId, value]));
    return rows[0] === undefined ? null : sessionOf(rows[0]);
  }

  // An id that could not be a uuid is simply not one of ours, as in memory — not a database error.
  findById(companyId: CompanyId, id: string): Promise<OnboardingSession | null> {
    return UUID.test(id) ? this.#one(companyId, 'id = $2', id) : Promise.resolve(null);
  }

  findOpenForCompany(companyId: CompanyId): Promise<OnboardingSession | null> {
    return this.#one(companyId, 'state = $2', 'IN_PROGRESS');
  }

  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<OnboardingSession | null> {
    return this.#one(companyId, 'idempotency_key = $2', key);
  }

  async insert(session: OnboardingSession, idempotencyKey: string): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(session.companyId);
    try {
      await sql.query(
        `INSERT INTO onboarding_sessions (id, company_id, idempotency_key, state, steps, answers, created_by, created_at, updated_at, opening_voucher_id, version)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)`,
        [session.id, session.companyId, idempotencyKey, session.state, canonicalJson(session.steps), canonicalJson(session.answers),
          session.createdBy, session.createdAt, session.updatedAt, session.openingVoucherId, session.version],
      );
    } catch (error) {
      // The same key twice, or a second setup while one is open (two servers at once): one setup.
      if ((error as { code?: string }).code === '23505') throw alreadyStarted();
      throw error;
    }
  }

  async update(session: OnboardingSession, expectedVersion: number): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(session.companyId);
    const { rows } = await sql.query(
      `UPDATE onboarding_sessions SET state = $4, steps = $5::jsonb, answers = $6::jsonb, updated_at = $7, opening_voucher_id = $8, version = $9
        WHERE company_id = $1 AND id = $2 AND version = $3 RETURNING id`,
      [session.companyId, session.id, expectedVersion, session.state, canonicalJson(session.steps), canonicalJson(session.answers),
        session.updatedAt, session.openingVoucherId, session.version],
    );
    if (rows.length > 0) return;
    if ((await this.findById(session.companyId, session.id)) === null) {
      throw notFound('ONBOARDING_NOT_FOUND', 'That setup does not exist for this business.');
    }
    throw conflict('ONBOARDING_CONCURRENT_EDIT', 'Someone else changed this setup while you were working on it. Open it again to see their changes.');
  }
}
