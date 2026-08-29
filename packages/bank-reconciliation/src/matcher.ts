import { createHash } from 'node:crypto';
import type { BankLine, BookPayment, MatchCandidate } from './model.ts';

const DAY = 86_400_000;
const daysApart = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
const reference = (value: string | null): string => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const id = (bankIds: readonly string[], paymentIds: readonly string[]): string =>
  createHash('sha256').update(`${[...bankIds].sort().join(',')}|${[...paymentIds].sort().join(',')}`).digest('hex').slice(0, 24);

const combinations = <T>(values: readonly T[], size: number): T[][] => {
  if (size === 0) return [[]];
  const result: T[][] = [];
  for (let index = 0; index <= values.length - size; index += 1) {
    const head = values[index] as T;
    for (const tail of combinations(values.slice(index + 1), size - 1)) result.push([head, ...tail]);
  }
  return result;
};

const score = (banks: readonly BankLine[], payments: readonly BookPayment[]): MatchCandidate | null => {
  if (banks.length === 0 || payments.length === 0) return null;
  const companyId = banks[0]!.companyId;
  const direction = banks[0]!.direction;
  if (banks.some((line) => line.companyId !== companyId || line.direction !== direction)) return null;
  if (payments.some((payment) => payment.companyId !== companyId || payment.direction !== direction)) return null;
  const bankTotal = banks.reduce((total, line) => total + line.amountPaise, 0n);
  const bookTotal = payments.reduce((total, payment) => total + payment.amountPaise, 0n);
  const difference = bankTotal >= bookTotal ? bankTotal - bookTotal : bookTotal - bankTotal;
  if (difference > 100n) return null;

  const distances = banks.flatMap((line) => payments.map((payment) => daysApart(line.bookedOn, payment.date)));
  const nearest = Math.min(...distances);
  if (nearest > 7) return null;
  const bankRefs = banks.map((line) => reference(line.reference)).filter(Boolean);
  const paymentRefs = payments.map((payment) => reference(payment.reference)).filter(Boolean);
  const exactReference = bankRefs.some((left) => paymentRefs.includes(left));
  const partialReference = bankRefs.some((left) => paymentRefs.some((right) => left.includes(right) || right.includes(left)));
  const reasons: string[] = [];
  let confidence = 0;
  if (difference === 0n) { confidence += 55; reasons.push('Amounts are exactly equal.'); }
  else { confidence += 40; reasons.push(`Amounts differ by ${difference} paise.`); }
  if (nearest === 0) { confidence += 20; reasons.push('Dates are the same.'); }
  else if (nearest <= 2) { confidence += 15; reasons.push(`Dates are ${nearest} day${nearest === 1 ? '' : 's'} apart.`); }
  else { confidence += 5; reasons.push(`Dates are ${nearest} days apart.`); }
  if (exactReference) { confidence += 25; reasons.push('References are identical.'); }
  else if (partialReference) { confidence += 15; reasons.push('One reference contains the other.'); }
  if (banks.length + payments.length > 2) reasons.push(`${banks.length} bank lines correspond to ${payments.length} book payments.`);
  return Object.freeze({
    id: id(banks.map((line) => line.id), payments.map((payment) => payment.id)),
    companyId,
    bankTransactionIds: Object.freeze(banks.map((line) => line.id)),
    paymentIds: Object.freeze(payments.map((payment) => payment.id)),
    confidence,
    amountDifferencePaise: difference,
    reasons: Object.freeze(reasons),
  });
};

/** Enumerates one-to-one, one-to-many and many-to-one candidates, capped at three lines per side. */
export const buildCandidates = (banks: readonly BankLine[], payments: readonly BookPayment[]): readonly MatchCandidate[] => {
  const found = new Map<string, MatchCandidate>();
  for (const bank of banks) {
    const nearby = payments.filter((payment) => payment.companyId === bank.companyId && payment.direction === bank.direction && daysApart(bank.bookedOn, payment.date) <= 7);
    for (const size of [1, 2, 3]) for (const group of combinations(nearby, size)) {
      const candidate = score([bank], group);
      if (candidate) found.set(candidate.id, candidate);
    }
  }
  for (const payment of payments) {
    const nearby = banks.filter((bank) => bank.companyId === payment.companyId && bank.direction === payment.direction && daysApart(bank.bookedOn, payment.date) <= 7);
    for (const size of [2, 3]) for (const group of combinations(nearby, size)) {
      const candidate = score(group, [payment]);
      if (candidate) found.set(candidate.id, candidate);
    }
  }
  return Object.freeze([...found.values()].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id)));
};

export const findWrongDatePairs = (banks: readonly BankLine[], payments: readonly BookPayment[]): readonly { bankId: string; paymentId: string; days: number }[] =>
  banks.flatMap((bank) => payments.flatMap((payment) => {
    if (bank.companyId !== payment.companyId || bank.direction !== payment.direction || bank.amountPaise !== payment.amountPaise) return [];
    const days = daysApart(bank.bookedOn, payment.date);
    const sameReference = reference(bank.reference) !== '' && reference(bank.reference) === reference(payment.reference);
    return days > 7 && days <= 30 && sameReference ? [{ bankId: bank.id, paymentId: payment.id, days }] : [];
  }));
