import { randomUUID } from 'node:crypto';
import { buildCandidates, findWrongDatePairs } from './matcher.ts';
import type {
  BankLine,
  BookPayment,
  MatchCandidate,
  ReconciliationAuditEvent,
  ReconciliationContext,
  ReconciliationException,
  ReconciliationMatch,
  ReconciliationRun,
  SuggestedPaymentCreation,
} from './model.ts';
import { InMemoryReconciliationStore, type Page, type ReconciliationStore } from './store.ts';

export interface ReconciliationPolicy {
  readonly automaticThreshold: number;
  readonly ambiguityMargin: number;
}

const overlaps = (left: MatchCandidate, right: MatchCandidate): boolean =>
  left.bankTransactionIds.some((id) => right.bankTransactionIds.includes(id)) || left.paymentIds.some((id) => right.paymentIds.includes(id));

/**
 * Each command runs inside one `store.action(...)` (#366): on PostgreSQL one unit of work holding a
 * per-company lock, so two people confirming overlapping matches at once cannot both win, and a
 * match is never kept without its audit event. Running reconcile again over lines already matched
 * makes no second match and reports them as neither missing nor ambiguous, however many lines are
 * already matched. A pair a person matched and then undid is offered again only as a suggestion: a
 * run never auto-matches it over their undo.
 */
export class BankReconciliationService {
  readonly #store: ReconciliationStore;
  private readonly policy: ReconciliationPolicy;
  private readonly now: () => Date;

  constructor(policy: ReconciliationPolicy = { automaticThreshold: 75, ambiguityMargin: 10 }, now: () => Date = () => new Date(), store: ReconciliationStore = new InMemoryReconciliationStore()) {
    this.policy = policy;
    this.now = now;
    this.#store = store;
  }

  async reconcile(context: ReconciliationContext, bankLines: readonly BankLine[], bookPayments: readonly BookPayment[]): Promise<ReconciliationRun> {
    this.require(context, 'bank.reconcile');
    if (bankLines.some((line) => line.companyId !== context.companyId) || bookPayments.some((payment) => payment.companyId !== context.companyId)) throw new Error('Reconciliation inputs belong to another company.');
    if ([...bankLines, ...bookPayments].some((item) => typeof item.amountPaise !== 'bigint' || item.amountPaise <= 0n)) throw new Error('Every bank line and book entry needs an amount above zero, in paise.');
    return this.#store.action(context.companyId, async () => {
    const already = await this.#store.matchedLines(context.companyId, bankLines.map((line) => line.id), bookPayments.map((payment) => payment.id));
    const settledBanks = new Set(already.bankTransactionIds);
    const settledPayments = new Set(already.paymentIds);
    const candidates = buildCandidates(bankLines, bookPayments).filter((candidate) => !candidate.bankTransactionIds.some((id) => settledBanks.has(id)) && !candidate.paymentIds.some((id) => settledPayments.has(id)));
    await this.#store.saveCandidates(context.companyId, candidates);
    const undone = new Set(await this.#store.undoneCandidates(context.companyId, candidates.map((candidate) => candidate.id)));
    const matches: ReconciliationMatch[] = [];
    const exceptions: ReconciliationException[] = [];
    const usedBanks = new Set<string>(settledBanks);
    const usedPayments = new Set<string>(settledPayments);
    const reversalBanks = new Set(bankLines.filter((line) => !settledBanks.has(line.id) && /reversal|reversed|chargeback|returned/i.test(line.description)).map((line) => line.id));

    for (const candidate of candidates) {
      if (candidate.bankTransactionIds.some((id) => usedBanks.has(id) || reversalBanks.has(id)) || candidate.paymentIds.some((id) => usedPayments.has(id))) continue;
      const competing = candidates.filter((other) => other.id !== candidate.id && overlaps(candidate, other) && other.confidence >= candidate.confidence - this.policy.ambiguityMargin);
      if (candidate.confidence >= this.policy.automaticThreshold && competing.length === 0 && !undone.has(candidate.id)) {
        const match = this.toMatch(candidate, 'AUTO_MATCHED', null);
        matches.push(match);
        candidate.bankTransactionIds.forEach((id) => usedBanks.add(id));
        candidate.paymentIds.forEach((id) => usedPayments.add(id));
      }
    }
    await this.#store.addMatches(context.companyId, matches);
    await this.#store.appendAudits(context.companyId, matches.map((match) => this.event(context, match, 'reconciliation.auto_matched', null)));
    const activeCandidates = candidates.filter((candidate) => !candidate.bankTransactionIds.some((id) => usedBanks.has(id)) && !candidate.paymentIds.some((id) => usedPayments.has(id)));
    const ambiguousIds = new Set<string>();
    for (const candidate of activeCandidates) {
      const peers = activeCandidates.filter((other) => other.id !== candidate.id && overlaps(candidate, other) && Math.abs(other.confidence - candidate.confidence) <= this.policy.ambiguityMargin);
      if (peers.length === 0 || ambiguousIds.has(candidate.id)) continue;
      const group = [candidate, ...peers];
      group.forEach((item) => ambiguousIds.add(item.id));
      exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'AMBIGUOUS', bankTransactionIds: Object.freeze([...new Set(group.flatMap((item) => item.bankTransactionIds))]), paymentIds: Object.freeze([...new Set(group.flatMap((item) => item.paymentIds))]), summary: 'More than one plausible match needs confirmation.', candidateIds: Object.freeze(group.map((item) => item.id)) }));
    }

    for (const pair of findWrongDatePairs(bankLines.filter((line) => !settledBanks.has(line.id)), bookPayments.filter((payment) => !settledPayments.has(payment.id)))) exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'WRONG_DATE', bankTransactionIds: [pair.bankId], paymentIds: [pair.paymentId], summary: `The amount and reference agree, but the dates are ${pair.days} days apart.`, candidateIds: [] }));
    const fingerprints = new Map<string, string>();
    for (const line of bankLines.filter((item) => !settledBanks.has(item.id))) {
      const prior = fingerprints.get(line.fingerprint);
      if (prior) exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'DUPLICATE_BANK_TRANSACTION', bankTransactionIds: [prior, line.id], paymentIds: [], summary: 'The same bank transaction appears more than once.', candidateIds: [] }));
      else fingerprints.set(line.fingerprint, line.id);
      if (reversalBanks.has(line.id)) exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'POSSIBLE_REVERSAL', bankTransactionIds: [line.id], paymentIds: [], summary: 'This bank line looks like a reversal and must be reviewed.', candidateIds: [] }));
    }

    const candidateBankIds = new Set(candidates.flatMap((candidate) => candidate.bankTransactionIds));
    const candidatePaymentIds = new Set(candidates.flatMap((candidate) => candidate.paymentIds));
    for (const line of bankLines) if (!usedBanks.has(line.id) && !candidateBankIds.has(line.id) && !reversalBanks.has(line.id)) exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'MISSING_BOOK', bankTransactionIds: [line.id], paymentIds: [], summary: 'Money appears at the bank but has no matching receipt or payment in the books.', candidateIds: [] }));
    for (const payment of bookPayments) if (!usedPayments.has(payment.id) && !candidatePaymentIds.has(payment.id)) exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'MISSING_BANK', bankTransactionIds: [], paymentIds: [payment.id], summary: 'A receipt or payment is in the books but is missing from the bank statement.', candidateIds: [] }));

    const suggestedPayments: SuggestedPaymentCreation[] = exceptions.filter((item) => item.kind === 'MISSING_BOOK').map((item) => {
      const line = bankLines.find((candidate) => candidate.id === item.bankTransactionIds[0])!;
      return Object.freeze({ bankTransactionId: line.id, direction: line.direction, amountPaise: line.amountPaise, date: line.bookedOn, reference: line.reference, narration: line.description });
    });
    return Object.freeze({ companyId: context.companyId, candidates, matches: Object.freeze(matches), exceptions: Object.freeze(exceptions), suggestedPayments: Object.freeze(suggestedPayments) });
    });
  }

  async confirm(context: ReconciliationContext, candidateId: string): Promise<ReconciliationMatch> {
    this.require(context, 'bank.reconcile.confirm');
    return this.#store.action(context.companyId, async () => {
      const candidate = await this.#store.candidate(context.companyId, candidateId);
      if (!candidate) throw new Error('Reconciliation candidate was not found.');
      const taken = await this.#store.matchedLines(context.companyId, candidate.bankTransactionIds, candidate.paymentIds);
      if (taken.bankTransactionIds.length + taken.paymentIds.length > 0) throw new Error('One of these transactions is already matched.');
      const match = this.toMatch(candidate, 'CONFIRMED', context.actorId);
      await this.#store.addMatches(context.companyId, [match]);
      await this.record(context, match, 'reconciliation.confirmed', null);
      return match;
    });
  }

  /** Undoing a match twice (a retry, or two people at once) keeps the first undo and audits it once. */
  async unmatch(context: ReconciliationContext, matchId: string, reason: string): Promise<ReconciliationMatch> {
    this.require(context, 'bank.reconcile.confirm');
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error('Please explain why this match is being undone.');
    return this.#store.action(context.companyId, async () => {
      const undone = await this.#store.unmatch(context.companyId, matchId, { at: this.now().toISOString(), by: context.actorId, reason });
      if (!undone) throw new Error('Reconciliation match was not found.');
      if (undone.changed) await this.record(context, undone.match, 'reconciliation.unmatched', reason);
      return undone.match;
    });
  }

  async auditFor(context: ReconciliationContext, matchId: string, page?: Page): Promise<readonly ReconciliationAuditEvent[]> {
    this.require(context, 'bank.reconcile');
    return Object.freeze(await this.#store.audit(context.companyId, matchId, page));
  }

  private toMatch(candidate: MatchCandidate, status: ReconciliationMatch['status'], actorId: string | null): ReconciliationMatch {
    const remainingBankPaise = candidate.amountDifferencePaise;
    return Object.freeze({ ...candidate, id: randomUUID(), candidateId: candidate.id, status, remainingBankPaise, remainingBookPaise: candidate.amountDifferencePaise, confirmedBy: actorId, confirmedAt: actorId === null ? null : this.now().toISOString() });
  }

  private require(context: ReconciliationContext, permission: string): void {
    if (!context.permissions.has(permission)) throw new Error('Bank reconciliation permission is required.');
  }

  private async record(context: ReconciliationContext, match: ReconciliationMatch, action: ReconciliationAuditEvent['action'], reason: string | null): Promise<void> {
    await this.#store.appendAudits(context.companyId, [this.event(context, match, action, reason)]);
  }

  private event(context: ReconciliationContext, match: ReconciliationMatch, action: ReconciliationAuditEvent['action'], reason: string | null): ReconciliationAuditEvent {
    return Object.freeze({ id: randomUUID(), companyId: context.companyId, actorId: context.actorId, action, matchId: match.id, occurredAt: this.now().toISOString(), reason });
  }
}
