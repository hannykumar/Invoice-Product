/**
 * Issue #37 [E37] — reading a cell without ever guessing at a number.
 *
 * Old software writes money in every shape there is: "₹1,23,456.50", "1234.50 Cr", "(500)" for a
 * negative, "5,000/-", a plain "-". Each of those has one exact meaning and this file returns it, or
 * returns a refusal that says what the cell said and what to do about it. Nothing here rounds,
 * nothing infers a missing digit, and a cell that could mean two things is refused rather than
 * decided — a silently misread opening balance is money that walks into the books unopposed.
 */
import { fromDecimalString, isoDate, type IsoDate, type Money } from '@invoice/kernel';
import { quantity as makeQuantity, type Quantity } from '../../masters/src/units.ts';
import type { Bilingual } from './model.ts';

export type Read<T> =
  | { readonly ok: true; readonly value: T; readonly note?: Bilingual }
  | { readonly ok: false; readonly code: string; readonly message: Bilingual };

const fail = (code: string, en: string, hi: string): Read<never> => ({ ok: false, code, message: { 'en-IN': en, 'hi-IN': hi } });

export const isBlank = (cell: string): boolean => cell.trim() === '' || cell.trim() === '-';

/** Strips the decoration old software adds around an amount, keeping every digit. */
const undecorate = (cell: string): { text: string; negative: boolean; side: 'DEBIT' | 'CREDIT' | null } => {
  let text = cell.trim().replace(/ /g, ' ');
  let negative = false;
  let side: 'DEBIT' | 'CREDIT' | null = null;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  const drcr = /(^|\s)(dr|cr|debit|credit)\.?$/i.exec(text);
  if (drcr !== null) {
    side = /^d/i.test(drcr[2] as string) ? 'DEBIT' : 'CREDIT';
    text = text.slice(0, drcr.index).trim();
  }
  text = text
    .replace(/^(rs\.?|inr|₹)\s*/i, '')
    .replace(/\/-\s*$/, '')
    .replace(/[,\s]/g, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  return { text, negative, side };
};

export interface AmountRead {
  readonly amount: Money;
  /** "Cr" written next to the figure, when the file said so. Never inferred from the sign. */
  readonly side: 'DEBIT' | 'CREDIT' | null;
}

/** Reads an amount in rupees. Refuses anything with more than two decimal places. */
export const readMoney = (cell: string): Read<AmountRead> => {
  if (isBlank(cell)) return fail('AMOUNT_EMPTY', 'This amount is empty.', 'यह रक़म ख़ाली है।');
  const { text, negative, side } = undecorate(cell);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return fail(
      'AMOUNT_NOT_A_NUMBER',
      `"${cell.trim()}" is not an amount we can read. Write it as a plain number, for example 4500 or 4500.50.`,
      `"${cell.trim()}" को रक़म के रूप में नहीं पढ़ा जा सका। साधारण नंबर लिखिए, जैसे 4500 या 4500.50।`,
    );
  }
  const [, fraction = ''] = text.split('.');
  if (fraction.length > 2) {
    return fail(
      'AMOUNT_TOO_MANY_PAISE',
      `"${cell.trim()}" has more than two decimal places, so we cannot record it exactly. Round it yourself and put the correct figure in the file.`,
      `"${cell.trim()}" में दो से ज़्यादा दशमलव हैं, इसलिए इसे ठीक से दर्ज नहीं किया जा सकता। सही रक़म फ़ाइल में लिखिए।`,
    );
  }
  const amount = fromDecimalString(`${negative ? '-' : ''}${text}`);
  return { ok: true, value: { amount, side } };
};

/** Reads a quantity, with the unit that was written beside it when there was one. */
export const readQuantity = (cell: string, fallbackUnit: string): Read<Quantity> => {
  if (isBlank(cell)) return fail('QUANTITY_EMPTY', 'This quantity is empty.', 'यह मात्रा ख़ाली है।');
  const text = cell.trim().replace(/,/g, '');
  const match = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z.\s]*)?$/.exec(text);
  if (match === null) {
    return fail(
      'QUANTITY_NOT_A_NUMBER',
      `"${cell.trim()}" is not a quantity we can read. Write it as a number, for example 12 or 12.5.`,
      `"${cell.trim()}" को मात्रा के रूप में नहीं पढ़ा जा सका। नंबर लिखिए, जैसे 12 या 12.5।`,
    );
  }
  const digits = match[1] as string;
  const fraction = digits.split('.')[1] ?? '';
  if (fraction.length > 6) {
    return fail(
      'QUANTITY_TOO_PRECISE',
      `"${cell.trim()}" has more than six decimal places. We never round a quantity quietly, so please shorten it in the file.`,
      `"${cell.trim()}" में छह से ज़्यादा दशमलव हैं। मात्रा कभी चुपचाप राउंड नहीं की जाती; फ़ाइल में इसे छोटा कीजिए।`,
    );
  }
  const unit = (match[2] ?? fallbackUnit).trim().replace(/\.$/, '').toUpperCase();
  if (unit === '') {
    return fail('QUANTITY_NO_UNIT', 'We do not know what unit this quantity is in.', 'यह मात्रा किस यूनिट में है, पता नहीं।');
  }
  return { ok: true, value: makeQuantity(digits, unit) };
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const build = (year: number, month: number, day: number): Read<IsoDate> => {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try {
    return { ok: true, value: isoDate(text) };
  } catch {
    return fail(
      'DATE_NOT_REAL',
      `"${text}" is not a real date.`,
      `"${text}" असली तारीख़ नहीं है।`,
    );
  }
};

/**
 * Reads a date.
 *
 * Indian exports write day first, so 03/04/2026 is 3 April. When both halves could be a month the
 * day-first reading is used and the caller is told, because that is the convention every one of
 * these products follows — but the person is shown what we read, never left to assume.
 */
export const readDate = (cell: string): Read<IsoDate> => {
  if (isBlank(cell)) return fail('DATE_EMPTY', 'This date is empty.', 'यह तारीख़ ख़ाली है।');
  const text = cell.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso !== null) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const named = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{2}|\d{4})$/.exec(text);
  if (named !== null) {
    const month = MONTHS[(named[2] as string).slice(0, 4).toLowerCase()] ?? MONTHS[(named[2] as string).slice(0, 3).toLowerCase()];
    if (month === undefined) {
      return fail('DATE_UNKNOWN_MONTH', `We do not recognise the month in "${text}".`, `"${text}" में महीना समझ नहीं आया।`);
    }
    const yearText = named[3] as string;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    return build(year, month, Number(named[1]));
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (numeric !== null) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const yearText = numeric[3] as string;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    if (first > 12 && second > 12) {
      return fail('DATE_UNREADABLE', `"${text}" is not a date we can read.`, `"${text}" को तारीख़ के रूप में नहीं पढ़ा जा सकता।`);
    }
    // Day first, as every Indian export writes it.
    const [day, month] = first > 12 ? [first, second] : second > 12 ? [second, first] : [first, second];
    const read = build(year, month, day);
    if (read.ok && first <= 12 && second <= 12) {
      return {
        ...read,
        note: {
          'en-IN': `"${text}" was read as ${day} of month ${month}, ${year}, the way Indian software writes dates.`,
          'hi-IN': `"${text}" को ${day}/${month}/${year} पढ़ा गया, जैसे भारत के सॉफ़्टवेयर तारीख़ लिखते हैं।`,
        },
      };
    }
    return read;
  }

  // Excel hands over a serial number when a date column was formatted as a date.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.trunc(Number(text));
    const epoch = Date.UTC(1899, 11, 30);
    const instant = new Date(epoch + serial * 86_400_000);
    return build(instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate());
  }

  return fail(
    'DATE_UNREADABLE',
    `"${text}" is not a date we can read. Write it as 01-04-2026.`,
    `"${text}" को तारीख़ के रूप में नहीं पढ़ा जा सकता। इसे 01-04-2026 की तरह लिखिए।`,
  );
};

/** Reads a percentage into basis points: "18%" and "18" both become 1800. */
export const readPercent = (cell: string): Read<number> => {
  if (isBlank(cell)) return fail('PERCENT_EMPTY', 'This rate is empty.', 'यह दर ख़ाली है।');
  const text = cell.trim().replace(/%$/, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return fail(
      'PERCENT_NOT_A_NUMBER',
      `"${cell.trim()}" is not a rate we can read. Write it as 18 or 18%.`,
      `"${cell.trim()}" को दर के रूप में नहीं पढ़ा जा सका। 18 या 18% लिखिए।`,
    );
  }
  const [whole = '0', fraction = ''] = text.split('.');
  const basisPoints = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (basisPoints > 10_000) {
    return fail(
      'PERCENT_TOO_LARGE',
      `"${cell.trim()}" is more than 100%, which cannot be a GST rate.`,
      `"${cell.trim()}" सौ प्रतिशत से ज़्यादा है, जो GST दर नहीं हो सकती।`,
    );
  }
  return { ok: true, value: basisPoints };
};

export const readInteger = (cell: string): Read<number> => {
  if (isBlank(cell)) return fail('NUMBER_EMPTY', 'This number is empty.', 'यह नंबर ख़ाली है।');
  const text = cell.trim().replace(/,/g, '');
  if (!/^\d+$/.test(text)) {
    return fail(
      'NUMBER_NOT_WHOLE',
      `"${cell.trim()}" is not a whole number.`,
      `"${cell.trim()}" पूरा नंबर नहीं है।`,
    );
  }
  return { ok: true, value: Number(text) };
};

/** "Dr", "Debit", "Receivable" mean the same side. Anything else is refused. */
export const readSide = (cell: string): Read<'DEBIT' | 'CREDIT'> => {
  const text = cell.trim().toLowerCase().replace(/\./g, '');
  if (text === 'dr' || text === 'debit' || text === 'receivable' || text === 'to receive') return { ok: true, value: 'DEBIT' };
  if (text === 'cr' || text === 'credit' || text === 'payable' || text === 'to pay') return { ok: true, value: 'CREDIT' };
  return fail(
    'SIDE_UNREADABLE',
    `"${cell.trim()}" does not say whether the amount is owed to the business or by it. Write Dr or Cr.`,
    `"${cell.trim()}" से पता नहीं चलता कि रक़म लेना है या देना। Dr या Cr लिखिए।`,
  );
};
