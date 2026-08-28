/**
 * Issue #4 [E04] — fiscal periods and locks.
 *
 * A period lock is what stops a filed month from moving under a business's feet. A soft lock is a
 * manager's decision and can be overridden with a recorded reason; a hard lock is deliberately
 * irreversible, because the figures behind it have been reported to someone.
 */
import { financialYearOf, monthKeyOf, notAllowed, type IsoDate } from '@invoice/kernel';
import type { CompanyId, FiscalPeriodId, UserId } from '@invoice/kernel';

/** See docs/product/spec/states.json, machine `fiscal_period`. */
export type PeriodState = 'OPEN' | 'SOFT_LOCKED' | 'HARD_LOCKED';

export interface FiscalPeriod {
  readonly id: FiscalPeriodId;
  readonly companyId: CompanyId;
  /** "2026-04" */
  readonly monthKey: string;
  /** "2026-27" */
  readonly financialYear: string;
  readonly state: PeriodState;
  readonly lockedBy: UserId | null;
  readonly lockedAt: string | null;
  readonly reason: string | null;
}

export const periodKeyOf = (date: IsoDate): { monthKey: string; financialYear: string } => ({
  monthKey: monthKeyOf(date),
  financialYear: financialYearOf(date),
});

export interface PeriodDecision {
  readonly allowed: boolean;
  readonly requiresOverride: boolean;
  readonly state: PeriodState;
}

/**
 * Decides whether a document dated in this period may be posted.
 *
 * `OPEN` posts freely. `SOFT_LOCKED` posts only with an explicit, reasoned override from a user
 * who holds the permission. `HARD_LOCKED` never posts, by anyone, for any reason.
 */
export const decidePeriod = (state: PeriodState): PeriodDecision => {
  switch (state) {
    case 'OPEN':
      return { allowed: true, requiresOverride: false, state };
    case 'SOFT_LOCKED':
      return { allowed: true, requiresOverride: true, state };
    case 'HARD_LOCKED':
      return { allowed: false, requiresOverride: false, state };
  }
};

export const refuseHardLocked = (monthKey: string): never => {
  throw notAllowed(
    'LEDGER_PERIOD_HARD_LOCKED',
    `${monthKey} is closed for good and cannot be reopened. Make the correction in the current month instead.`,
    { messageId: 'period.closed_permanently', details: { periodName: monthKey } },
  );
};

export const refuseSoftLockedWithoutOverride = (monthKey: string, documentDate: IsoDate): never => {
  throw notAllowed(
    'LEDGER_PERIOD_SOFT_LOCKED',
    `${monthKey} is closed, so this entry cannot be dated ${documentDate}.`,
    { messageId: 'period.closed', details: { periodName: monthKey, documentDate } },
  );
};
