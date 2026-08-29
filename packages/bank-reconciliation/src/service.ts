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

export interface ReconciliationPolicy {
  readonly automaticThreshold: number;
  readonly ambiguityMargin: number;
}

const overlaps = (left: MatchCandidate, right: MatchCandidate): boolean =>
  left.bankTransactionIds.some((id) => right.bankTransactionIds.includes(id)) || left.paymentIds.some((id) => right.paymentIds.includes(id));

export class BankReconciliationService {
  #candidates = new Map<string, MatchCandidate>();
  #matches = new Map<string, ReconciliationMatch>();
  #audit: ReconciliationAuditEvent[] = [];
  private readonly policy: ReconciliationPolicy;
  private readonly now: () => Date;

  constructor(policy: ReconciliationPolicy = { automaticThreshold: 75, ambiguityMargin: 10 }, now: () => Date = () => new Date()) {
    this.policy = policy;
    this.now = now;
  }

  reconcile(context: ReconciliationContext, bankLines: readonly BankLine[], bookPayments: readonly BookPayment[]): ReconciliationRun {
    this.require(context, 'bank.reconcile');
    if (bankLines.some((line) => line.companyId !== context.companyId) || bookPayments.some((payment) => payment.companyId !== context.companyId)) throw new Error('Reconciliation inputs belong to another company.');
    const candidates = buildCandidates(bankLines, bookPayments);
    for (const candidate of candidates) this.#candidates.set(candidate.id, candidate);
    const matches: ReconciliationMatch[] = [];
    const exceptions: ReconciliationException[] = [];
    const usedBanks = new Set<string>();
    const usedPayments = new Set<string>();
    const reversalBanks = new Set(bankLines.filter((line) => /reversal|reversed|chargeback|returned/i.test(line.description)).map((line) => line.id));

    for (const candidate of candidates) {
      if (candidate.bankTransactionIds.some((id) => usedBanks.has(id) || reversalBanks.has(id)) || candidate.paymentIds.some((id) => usedPayments.has(id))) continue;
      const competing = candidates.filter((other) => other.id !== candidate.id && overlaps(candidate, other) && other.confidence >= candidate.confidence - this.policy.ambiguityMargin);
      if (candidate.confidence >= this.policy.automaticThreshold && competing.length === 0) {
        const match = this.toMatch(candidate, 'AUTO_MATCHED', null);
        this.#matches.set(match.id, match);
        matches.push(match);
        candidate.bankTransactionIds.forEach((id) => usedBanks.add(id));
        candidate.paymentIds.forEach((id) => usedPayments.add(id));
        this.record(context, match, 'reconciliation.auto_matched', null);
      }
    }

    const activeCandidates = candidates.filter((candidate) => !candidate.bankTransactionIds.some((id) => usedBanks.has(id)) && !candidate.paymentIds.some((id) => usedPayments.has(id)));
    const ambiguousIds = new Set<string>();
    for (const candidate of activeCandidates) {
      const peers = activeCandidates.filter((other) => other.id !== candidate.id && overlaps(candidate, other) && Math.abs(other.confidence - candidate.confidence) <= this.policy.ambiguityMargin);
      if (peers.length === 0 || ambiguousIds.has(candidate.id)) continue;
      const group = [candidate, ...peers];
      group.forEach((item) => ambiguousIds.add(item.id));
      exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'AMBIGUOUS', bankTransactionIds: Object.freeze([...new Set(group.flatMap((item) => item.bankTransactionIds))]), paymentIds: Object.freeze([...new Set(group.flatMap((item) => item.paymentIds))]), summary: 'More than one plausible match needs confirmation.', candidateIds: Object.freeze(group.map((item) => item.id)) }));
    }

    for (const pair of findWrongDatePairs(bankLines, bookPayments)) exceptions.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, kind: 'WRONG_DATE', bankTransactionIds: [pair.bankId], paymentIds: [pair.paymentId], summary: `The amount and reference agree, but the dates are ${pair.days} days apart.`, candidateIds: [] }));
    const fingerprints = new Map<string, string>();
    for (const line of bankLines) {
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
  }

  confirm(context: ReconciliationContext, candidateId: string): ReconciliationMatch {
    this.require(context, 'bank.reconcile.confirm');
    const candidate = this.candidate(context, candidateId);
    if ([...this.#matches.values()].some((match) => match.status !== 'UNMATCHED' && overlaps(match, candidate))) throw new Error('One of these transactions is already matched.');
    const match = this.toMatch(candidate, 'CONFIRMED', context.actorId);
    this.#matches.set(match.id, match);
    this.record(context, match, 'reconciliation.confirmed', null);
    return match;
  }

  unmatch(context: ReconciliationContext, matchId: string, reason: string): ReconciliationMatch {
    this.require(context, 'bank.reconcile.confirm');
    if (reason.trim() === '') throw new Error('Please explain why this match is being undone.');
    const match = this.#matches.get(matchId);
    if (!match || match.companyId !== context.companyId) throw new Error('Reconciliation match was not found.');
    const unmatched = Object.freeze({ ...match, status: 'UNMATCHED' as const });
    this.#matches.set(matchId, unmatched);
    this.record(context, unmatched, 'reconciliation.unmatched', reason);
    return unmatched;
  }

  auditFor(context: ReconciliationContext, matchId: string): readonly ReconciliationAuditEvent[] {
    this.require(context, 'bank.reconcile');
    return Object.freeze(this.#audit.filter((event) => event.companyId === context.companyId && event.matchId === matchId));
  }

  private candidate(context: ReconciliationContext, id: string): MatchCandidate {
    const candidate = this.#candidates.get(id);
    if (!candidate || candidate.companyId !== context.companyId) throw new Error('Reconciliation candidate was not found.');
    return candidate;
  }

  private toMatch(candidate: MatchCandidate, status: ReconciliationMatch['status'], actorId: string | null): ReconciliationMatch {
    const remainingBankPaise = candidate.amountDifferencePaise;
    return Object.freeze({ ...candidate, status, remainingBankPaise, remainingBookPaise: candidate.amountDifferencePaise, confirmedBy: actorId, confirmedAt: actorId === null ? null : this.now().toISOString() });
  }

  private require(context: ReconciliationContext, permission: string): void {
    if (!context.permissions.has(permission)) throw new Error('Bank reconciliation permission is required.');
  }

  private record(context: ReconciliationContext, match: ReconciliationMatch, action: ReconciliationAuditEvent['action'], reason: string | null): void {
    this.#audit.push(Object.freeze({ id: randomUUID(), companyId: context.companyId, actorId: context.actorId, action, matchId: match.id, occurredAt: this.now().toISOString(), reason }));
  }
}
