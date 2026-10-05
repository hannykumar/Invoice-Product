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

/**
 * Issue #234 — the calendar date in India at an instant. India is UTC+05:30 all year (no summer
 * time), so the date is the UTC date of the instant moved forward five and a half hours. Never
 * `toISOString().slice(0, 10)` on its own: until 05:30 in India that is still yesterday, and a bill
 * made then would carry yesterday's date.
 */
export const indiaDateOf = (at: Date | string | number): IsoDate =>
  isoDate(new Date(new Date(at).getTime() + 330 * 60_000).toISOString().slice(0, 10));

/** Today's date in India by the given clock. */
export const indiaToday = (clock: Clock): IsoDate => indiaDateOf(clock.now());

/** India is UTC+05:30 all year, with no summer time. */
const INDIA_OFFSET_MS = 330 * 60_000;

/**
 * Issue #283 — a timestamp written by a government portal (e-invoice IRP, e-way bill), which is
 * always a wall-clock time in India even though it carries no zone. Both portals use two shapes —
 * "29/09/2026 20:12:51" and "2026-09-29 20:12:51" — on a 24- or 12-hour clock ("11:59:00 PM").
 * Reading either as UTC, or as the server's own zone, moved the 24-hour cancel window by 5½ hours.
 * A string that does carry a zone ("…Z", "+05:30") is an instant and is read as one.
 */
export const readIndianTimestamp = (raw: string): Date => {
  const text = raw.trim();
  const shape =
    /^(?:(\d{2})\/(\d{2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2}))[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*([AaPp])\.?[Mm]\.?)?$/.exec(text);
  if (shape === null) return new Date(text);
  const [, d1, m1, y1, y2, m2, d2, rawHour, minute, second = '00', meridiem] = shape;
  const [year, month, day] = y1 !== undefined ? [y1, m1, d1] : [y2, m2, d2];
  let hour = Number(rawHour);
  if (meridiem !== undefined) {
    // Midnight is 12 AM and noon is 12 PM: the only two the arithmetic gets wrong if left alone.
    const afternoon = meridiem.toLowerCase() === 'p';
    hour = afternoon ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
  }
  return new Date(Date.parse(`${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${minute}:${second}Z`) - INDIA_OFFSET_MS);
};

/** An instant as Indian wall-clock time, in the given portal shape. */
export const writeIndianTimestamp = (at: Date, shape: 'DD/MM/YYYY' | 'YYYY-MM-DD' = 'DD/MM/YYYY'): string => {
  const indian = new Date(at.getTime() + INDIA_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = pad(indian.getUTCDate());
  const month = pad(indian.getUTCMonth() + 1);
  const year = indian.getUTCFullYear();
  const time = `${pad(indian.getUTCHours())}:${pad(indian.getUTCMinutes())}:${pad(indian.getUTCSeconds())}`;
  return shape === 'YYYY-MM-DD' ? `${year}-${month}-${day} ${time}` : `${day}/${month}/${year} ${time}`;
};
