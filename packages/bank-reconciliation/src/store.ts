/**
 * Issue #366 — what bank reconciliation must keep: the candidates a person may confirm, the matches
 * (automatic, confirmed, later undone) and the append-only audit trail. The in-memory store is the
 * default; postgres-store.ts keeps the same contract (test/reconciliation-contract.ts runs both).
 */
import type { MatchCandidate, ReconciliationAuditEvent, ReconciliationMatch } from './model.ts';

export interface Page { readonly limit?: number; readonly after?: string }
export const pageLimit = (page?: Page): number => Math.min(Math.max(Math.trunc(page?.limit ?? 100), 1), 500);
export interface Unmatching { readonly at: string; readonly by: string; readonly reason: string }

export interface ReconciliationStore {
  /** One business action for a company, run one at a time per company; on the database, one unit of work. */
  action<T>(companyId: string, work: () => Promise<T>): Promise<T>;
  /** Keeps candidates already kept as they are. */
  saveCandidates(companyId: string, candidates: readonly MatchCandidate[]): Promise<void>;
  candidate(companyId: string, candidateId: string): Promise<MatchCandidate | null>;
  addMatch(match: ReconciliationMatch): Promise<void>;
  /** Matches not undone that use any of these bank lines or book entries. */
  activeMatches(companyId: string, bankTransactionIds: readonly string[], paymentIds: readonly string[]): Promise<readonly ReconciliationMatch[]>;
  match(companyId: string, matchId: string): Promise<ReconciliationMatch | null>;
  /** Undoes a match once: one already undone stays as it was, and `changed` is false. */
  unmatch(companyId: string, matchId: string, unmatching: Unmatching): Promise<{ readonly match: ReconciliationMatch; readonly changed: boolean } | null>;
  appendAudit(event: ReconciliationAuditEvent): Promise<void>;
  /** Oldest first; `after` is the id of the last event already shown. */
  audit(companyId: string, matchId: string, page?: Page): Promise<readonly ReconciliationAuditEvent[]>;
}

const touches = (match: ReconciliationMatch, bankIds: readonly string[], paymentIds: readonly string[]): boolean =>
  match.bankTransactionIds.some((id) => bankIds.includes(id)) || match.paymentIds.some((id) => paymentIds.includes(id));

export class InMemoryReconciliationStore implements ReconciliationStore {
  readonly #candidates = new Map<string, MatchCandidate>();
  readonly #matches = new Map<string, ReconciliationMatch>();
  readonly #audit: ReconciliationAuditEvent[] = [];
  readonly #queues = new Map<string, Promise<unknown>>();

  action<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(companyId) ?? Promise.resolve()).then(work, work);
    this.#queues.set(companyId, run.catch(() => undefined));
    return run;
  }
  async saveCandidates(companyId: string, candidates: readonly MatchCandidate[]): Promise<void> {
    for (const candidate of candidates) if (!this.#candidates.has(`${companyId}:${candidate.id}`)) this.#candidates.set(`${companyId}:${candidate.id}`, candidate);
  }
  async candidate(companyId: string, candidateId: string): Promise<MatchCandidate | null> { return this.#candidates.get(`${companyId}:${candidateId}`) ?? null; }
  async addMatch(match: ReconciliationMatch): Promise<void> {
    if (this.#matches.has(match.id)) throw new Error('RECONCILIATION_MATCH_EXISTS');
    this.#matches.set(match.id, match);
  }
  async activeMatches(companyId: string, bankIds: readonly string[], paymentIds: readonly string[]): Promise<readonly ReconciliationMatch[]> {
    return [...this.#matches.values()].filter((m) => m.companyId === companyId && m.status !== 'UNMATCHED' && touches(m, bankIds, paymentIds));
  }
  async match(companyId: string, matchId: string): Promise<ReconciliationMatch | null> {
    const match = this.#matches.get(matchId);
    return match !== undefined && match.companyId === companyId ? match : null;
  }
  async unmatch(companyId: string, matchId: string): Promise<{ readonly match: ReconciliationMatch; readonly changed: boolean } | null> {
    const match = this.#matches.get(matchId);
    if (match === undefined || match.companyId !== companyId) return null;
    if (match.status === 'UNMATCHED') return { match, changed: false };
    const unmatched = Object.freeze({ ...match, status: 'UNMATCHED' as const });
    this.#matches.set(matchId, unmatched);
    return { match: unmatched, changed: true };
  }
  async appendAudit(event: ReconciliationAuditEvent): Promise<void> { this.#audit.push(event); }
  async audit(companyId: string, matchId: string, page?: Page): Promise<readonly ReconciliationAuditEvent[]> {
    const events = this.#audit.filter((e) => e.companyId === companyId && e.matchId === matchId);
    const start = page?.after === undefined ? 0 : events.findIndex((e) => e.id === page.after) + 1;
    return start === 0 && page?.after !== undefined ? [] : events.slice(start, start + pageLimit(page));
  }
}
