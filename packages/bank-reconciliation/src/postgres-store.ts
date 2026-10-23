/**
 * Issue #366 — bank reconciliation on PostgreSQL. `action` opens the unit of work and takes a
 * per-company advisory lock, so overlapping confirmations run one after the other. Writes join it
 * through `requireUnitOfWork` (`NO_UNIT_OF_WORK` otherwise); reads run in `tenantTransaction`;
 * every query names its company as well as relying on row-level security.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { MatchCandidate, ReconciliationAuditEvent, ReconciliationMatch } from './model.ts';
import { pageLimit, type Page, type ReconciliationStore, type Unmatching } from './store.ts';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const CANDIDATE = 'c.id, c.company_id, c.bank_transaction_ids, c.payment_ids, c.confidence, c.amount_difference_paise, c.reasons';
const candidate = (r: Row): MatchCandidate => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), bankTransactionIds: Object.freeze([...(r.bank_transaction_ids as string[])]),
  paymentIds: Object.freeze([...(r.payment_ids as string[])]), confidence: Number(r.confidence),
  amountDifferencePaise: BigInt(String(r.amount_difference_paise)), reasons: Object.freeze([...(r.reasons as string[])]),
});
const MATCH = 'm.id, m.company_id, m.candidate_id, m.bank_transaction_ids, m.payment_ids, m.confidence, m.amount_difference_paise, m.reasons, m.status, m.remaining_bank_paise, m.remaining_book_paise, m.confirmed_by, m.confirmed_at';
const match = (r: Row): ReconciliationMatch => Object.freeze({
  ...candidate(r), candidateId: String(r.candidate_id), status: String(r.status) as ReconciliationMatch['status'],
  remainingBankPaise: BigInt(String(r.remaining_bank_paise)), remainingBookPaise: BigInt(String(r.remaining_book_paise)),
  confirmedBy: r.confirmed_by === null ? null : String(r.confirmed_by), confirmedAt: r.confirmed_at === null ? null : iso(r.confirmed_at),
});
const EVENT = 'e.id, e.company_id, e.actor_id, e.action, e.match_id, e.occurred_at, e.reason';
const event = (r: Row): ReconciliationAuditEvent => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), actorId: String(r.actor_id), action: String(r.action) as ReconciliationAuditEvent['action'],
  matchId: String(r.match_id), occurredAt: iso(r.occurred_at), reason: r.reason === null ? null : String(r.reason),
});

export class PostgresReconciliationStore implements ReconciliationStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  action<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    return this.#db.unitOfWork(companyId, async ({ sql }) => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || $1, 0))", [companyId]);
      return work();
    });
  }
  #read<T>(companyId: string, work: (sql: SqlExecutor) => Promise<T>): Promise<T> { return this.#db.tenantTransaction(companyId, work); }
  #write(companyId: string): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  async saveCandidates(companyId: string, candidates: readonly MatchCandidate[]): Promise<void> {
    const sql = this.#write(companyId);
    if (candidates.length === 0) return;
    await sql.query(
      `INSERT INTO bank_reconciliation_candidates (company_id, id, bank_transaction_ids, payment_ids, confidence, amount_difference_paise, reasons)
       SELECT $1, x.id, x.bank_transaction_ids, x.payment_ids, x.confidence, x.amount_difference_paise, x.reasons
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, bank_transaction_ids text[], payment_ids text[], confidence integer, amount_difference_paise bigint, reasons jsonb)
       ON CONFLICT (company_id, id) DO NOTHING`,
      [companyId, JSON.stringify(candidates.map((c) => ({ id: c.id, bank_transaction_ids: c.bankTransactionIds, payment_ids: c.paymentIds, confidence: c.confidence, amount_difference_paise: c.amountDifferencePaise.toString(), reasons: c.reasons })))]);
  }

  candidate(companyId: string, candidateId: string): Promise<MatchCandidate | null> {
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${CANDIDATE} FROM bank_reconciliation_candidates c WHERE c.company_id = $1 AND c.id = $2`, [companyId, candidateId])).rows[0];
      return row === undefined ? null : candidate(row);
    });
  }

  async addMatch(m: ReconciliationMatch): Promise<void> {
    await this.#write(m.companyId).query(
      `INSERT INTO bank_reconciliation_matches (id, company_id, candidate_id, bank_transaction_ids, payment_ids, confidence, amount_difference_paise, reasons, status, remaining_bank_paise, remaining_book_paise, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
      [m.id, m.companyId, m.candidateId, m.bankTransactionIds, m.paymentIds, m.confidence, m.amountDifferencePaise.toString(), JSON.stringify(m.reasons), m.status, m.remainingBankPaise.toString(), m.remainingBookPaise.toString(), m.confirmedBy, m.confirmedAt]);
  }

  activeMatches(companyId: string, bankIds: readonly string[], paymentIds: readonly string[]): Promise<readonly ReconciliationMatch[]> {
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${MATCH} FROM bank_reconciliation_matches m
        WHERE m.company_id = $1 AND m.status <> 'UNMATCHED' AND (m.bank_transaction_ids && $2::text[] OR m.payment_ids && $3::text[])
        ORDER BY m.matched_at, m.id LIMIT 500`, [companyId, bankIds, paymentIds])).rows.map(match));
  }

  match(companyId: string, matchId: string): Promise<ReconciliationMatch | null> {
    if (!UUID.test(matchId)) return Promise.resolve(null);
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${MATCH} FROM bank_reconciliation_matches m WHERE m.company_id = $1 AND m.id = $2`, [companyId, matchId])).rows[0];
      return row === undefined ? null : match(row);
    });
  }

  async unmatch(companyId: string, matchId: string, u: Unmatching): Promise<{ readonly match: ReconciliationMatch; readonly changed: boolean } | null> {
    const sql = this.#write(companyId);
    if (!UUID.test(matchId)) return null;
    const undone = await sql.query(
      `UPDATE bank_reconciliation_matches m SET status = 'UNMATCHED', unmatched_at = $3, unmatched_by = $4, unmatch_reason = $5
        WHERE m.company_id = $1 AND m.id = $2 AND m.status <> 'UNMATCHED' RETURNING ${MATCH}`, [companyId, matchId, u.at, u.by, u.reason]);
    if (undone.rows[0] !== undefined) return { match: match(undone.rows[0]), changed: true };
    const current = (await sql.query(`SELECT ${MATCH} FROM bank_reconciliation_matches m WHERE m.company_id = $1 AND m.id = $2`, [companyId, matchId])).rows[0];
    return current === undefined ? null : { match: match(current), changed: false };
  }

  async appendAudit(e: ReconciliationAuditEvent): Promise<void> {
    await this.#write(e.companyId).query(
      'INSERT INTO bank_reconciliation_events (id, company_id, actor_id, action, match_id, occurred_at, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [e.id, e.companyId, e.actorId, e.action, e.matchId, e.occurredAt, e.reason]);
  }

  audit(companyId: string, matchId: string, page?: Page): Promise<readonly ReconciliationAuditEvent[]> {
    if (!UUID.test(matchId)) return Promise.resolve([]);
    const after = page?.after !== undefined && UUID.test(page.after) ? page.after : page?.after === undefined ? null : '00000000-0000-0000-0000-000000000000';
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${EVENT} FROM bank_reconciliation_events e
        WHERE e.company_id = $1 AND e.match_id = $2
          AND ($3::uuid IS NULL OR e.seq > (SELECT a.seq FROM bank_reconciliation_events a WHERE a.company_id = $1 AND a.id = $3))
        ORDER BY e.seq LIMIT $4`, [companyId, matchId, after, pageLimit(page)])).rows.map(event));
  }
}
