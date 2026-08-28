/**
 * Dates.
 *
 * A document date is a calendar date in India, not an instant. It decides the fiscal period, the
 * tax period and which version of a rule applies. System timestamps are a separate thing and are
 * always UTC instants; they never stand in for a document date.
 */
export type IsoDate = string & { readonly __isoDate: unique symbol };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isoDate = (value: string): IsoDate => {
  const match = ISO.exec(value);
  if (match === null) throw new RangeError(`"${value}" is not a date in YYYY-MM-DD form`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== day) {
    throw new RangeError(`"${value}" is not a real date`);
  }
  return value as IsoDate;
};

export const compareDates = (a: IsoDate, b: IsoDate): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

/** India's financial year runs 1 April to 31 March and is named like "2026-27" (assumption A2). */
export const financialYearOf = (date: IsoDate): string => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

export const financialYearRange = (financialYear: string): { from: IsoDate; to: IsoDate } => {
  const start = Number(financialYear.slice(0, 4));
  return { from: isoDate(`${start}-04-01`), to: isoDate(`${start + 1}-03-31`) };
};

/** "2026-04" — the monthly accounting period a document date falls into. */
export const monthKeyOf = (date: IsoDate): string => date.slice(0, 7);

export const monthRange = (monthKey: string): { from: IsoDate; to: IsoDate } => {
  const [year, month] = monthKey.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: isoDate(`${monthKey}-01`), to: isoDate(`${monthKey}-${String(lastDay).padStart(2, '0')}`) };
};

/** How a date is written for a person: "15 April 2026". Never 15/04/26 (issue #46). */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const formatDate = (date: IsoDate): string => {
  const [year, month, day] = date.split('-') as [string, string, string];
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
};

/** An instant, always UTC, for audit records. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (at: string): Clock => {
  const instant = new Date(at);
  return { now: () => new Date(instant.getTime()) };
};
