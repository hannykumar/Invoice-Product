/**
 * Issue #234 — the one clock the running app reads.
 *
 * `npm run web` and `npm run dev` use the machine's real time. Every service the app composes
 * (sales, e-way bills, e-invoices, purchase credit, reports, reminders, the home screen) is handed
 * this same clock, and every "today" is the date in India (Asia/Kolkata) at that instant, so the
 * screen, the server and each service agree on one day.
 *
 * Tests pin it with `useFixedAppClock(...)` before they build the app, so what they assert does not
 * change with the day they are run. The clock delegates on every call, so a service built before the
 * pin still reads the pinned time.
 */
import { financialYearOf, financialYearRange, fixedClock, indiaDateOf, systemClock, type Clock, type IsoDate } from '@invoice/kernel';

let current: Clock = systemClock;

export const appClock: Clock = { now: () => current.now() };

/** For tests only: pin the running app to one instant (or hand it any other clock). */
export const setAppClock = (clock: Clock): void => { current = clock; };
export const useFixedAppClock = (at: string): void => setAppClock(fixedClock(at));
/** For tests only: back to the machine's time. */
export const useSystemAppClock = (): void => setAppClock(systemClock);

/** Today's date in India, by the app's clock. */
export const appToday = (): IsoDate => indiaDateOf(appClock.now());

/** The financial year (1 April to 31 March) that today falls in. */
export const currentFinancialYear = (): { readonly from: IsoDate; readonly to: IsoDate } =>
  financialYearRange(financialYearOf(appToday()));

/** "2026-08" — the month before today's, in India. The month a business is actually filing. */
export const previousMonthOfToday = (): string => {
  const [year, month] = appToday().split('-').map(Number) as [number, number];
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
};
