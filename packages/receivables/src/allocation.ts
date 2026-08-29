/**
 * Issue #20 [E20] — matching money to bills.
 *
 * Two rules, and both are refusals:
 *
 *  1. **A payment is never applied to a bill nobody chose.** The product suggests the oldest bill
 *     first, because that is what most businesses do, but a suggestion is not a decision and the
 *     caller must confirm it.
 *  2. **Nothing is over-applied.** ₹30,000 cannot settle ₹30,000 of one bill and ₹10,000 of
 *     another, and a bill already settled cannot absorb more.
 */
import { compareDates, invalid, isZero, subtract, sum, toDecimalString, zero, type IsoDate, type Money } from '@invoice/kernel';
import type { Allocation, DocumentPosition, OpenDocument, Payment } from './model.ts';

const nil = (): Money => zero('INR');

/** Days between two dates. Positive means the first is later. */
export const daysBetween = (later: IsoDate, earlier: IsoDate): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

/**
 * What one document still owes, from the document's value less every accepted allocation.
 *
 * "Outstanding balances equal invoice less accepted allocations" is the acceptance criterion, so
 * outstanding is derived here and stored nowhere.
 */
export const positionOf = (
  document: OpenDocument,
  payments: readonly Payment[],
  today: IsoDate,
): DocumentPosition => {
  const allocated = sum(
    payments
      .filter((p) => p.state === 'RECORDED')
      .flatMap((p) => p.allocations.filter((a) => a.documentId === document.documentId).map((a) => a.amount)),
  );
  const outstanding = subtract(document.value, allocated);
  const daysOverdue = document.dueDate === null ? 0 : daysBetween(today, document.dueDate);
  const status: DocumentPosition['status'] = isZero(outstanding)
    ? 'SETTLED'
    : isZero(allocated)
      ? 'OPEN'
      : 'PARTLY_PAID';
  return { document, allocated, outstanding, daysOverdue, status };
};

/**
 * Suggests how a payment could be split, oldest bill first.
 *
 * A suggestion, not a decision: the caller confirms it. Anything left over is deliberately not
 * forced onto a bill — it stays on account where a person can see it.
 */
export const suggestAllocation = (
  amount: Money,
  positions: readonly DocumentPosition[],
): { allocations: Allocation[]; leftOver: Money } => {
  const open = [...positions]
    .filter((p) => !isZero(p.outstanding) && p.outstanding.minor > 0n)
    .sort((a, b) => {
      const byDue = compareDates(a.document.dueDate ?? a.document.date, b.document.dueDate ?? b.document.date);
      return byDue !== 0 ? byDue : compareDates(a.document.date, b.document.date);
    });

  let remaining = amount;
  const allocations: Allocation[] = [];
  for (const position of open) {
    if (remaining.minor <= 0n) break;
    const applied = remaining.minor >= position.outstanding.minor ? position.outstanding : remaining;
    allocations.push({
      documentId: position.document.documentId,
      documentNumber: position.document.number,
      amount: applied,
    });
    remaining = subtract(remaining, applied);
  }
  return { allocations, leftOver: remaining };
};

/**
 * Checks a proposed split before anything is written.
 *
 * Every refusal here names the bill and the amount, because "allocation exceeds outstanding" is
 * not something a shopkeeper can act on.
 */
export const validateAllocation = (
  amount: Money,
  allocations: readonly Allocation[],
  positions: readonly DocumentPosition[],
): void => {
  const byDocument = new Map(positions.map((p) => [p.document.documentId, p]));
  const seen = new Set<string>();

  for (const allocation of allocations) {
    if (allocation.amount.minor <= 0n) {
      throw invalid(
        'ALLOCATION_NOT_POSITIVE',
        `The amount put against ${allocation.documentNumber} must be more than zero.`,
      );
    }
    if (seen.has(allocation.documentId)) {
      throw invalid(
        'ALLOCATION_DUPLICATE_DOCUMENT',
        `${allocation.documentNumber} appears twice. Put the whole amount on it once.`,
      );
    }
    seen.add(allocation.documentId);

    const position = byDocument.get(allocation.documentId);
    if (position === undefined) {
      throw invalid(
        'ALLOCATION_UNKNOWN_DOCUMENT',
        `${allocation.documentNumber} is not an open bill for this customer.`,
      );
    }
    if (allocation.amount.minor > position.outstanding.minor) {
      throw invalid(
        'ALLOCATION_EXCEEDS_OUTSTANDING',
        `${allocation.documentNumber} only has ${toDecimalString(position.outstanding)} left to pay, but ${toDecimalString(allocation.amount)} was put against it.`,
        { details: { documentNumber: allocation.documentNumber, outstanding: toDecimalString(position.outstanding) } },
      );
    }
  }

  const total = sum(allocations.map((a) => a.amount));
  if (total.minor > amount.minor) {
    throw invalid(
      'ALLOCATION_EXCEEDS_PAYMENT',
      `${toDecimalString(total)} has been put against bills, but only ${toDecimalString(amount)} was received.`,
      { details: { allocated: toDecimalString(total), amount: toDecimalString(amount) } },
    );
  }
};

/** Money received that no bill has claimed. Visible, and never quietly attached to something. */
export const onAccountOf = (payments: readonly Payment[]): Money =>
  sum(
    payments
      .filter((p) => p.state === 'RECORDED')
      .map((p) => subtract(p.amount, sum(p.allocations.map((a) => a.amount)))),
  );

export const totalOutstanding = (positions: readonly DocumentPosition[]): Money =>
  sum(positions.map((p) => p.outstanding));

export const allocatedTotal = (allocations: readonly Allocation[]): Money => sum(allocations.map((a) => a.amount));

