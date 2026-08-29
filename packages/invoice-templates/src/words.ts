/**
 * Issue #13 [E13] — the amount in words, in the Indian system.
 *
 * It is on the invoice because a misread figure is a real and common problem, and words are the
 * check. Lakh and crore, not million and billion: a bill that says "one hundred thousand" to an
 * Indian business is a bill nobody proof-reads.
 */
import { type Money } from '@invoice/kernel';

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const underThousand = (n: number): string => {
  if (n === 0) return '';
  if (n < 20) return ONES[n] as string;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] as string;
    const rest = n % 10;
    return rest === 0 ? tens : `${tens}-${ONES[rest] as string}`;
  }
  const hundreds = `${ONES[Math.floor(n / 100)] as string} hundred`;
  const rest = n % 100;
  return rest === 0 ? hundreds : `${hundreds} and ${underThousand(rest)}`;
};

/** Splits into crore, lakh, thousand and the rest, which is how the number is actually spoken. */
const indianGroups = (value: bigint): string => {
  if (value === 0n) return 'zero';
  const parts: string[] = [];
  const crore = value / 10000000n;
  const afterCrore = value % 10000000n;
  const lakh = afterCrore / 100000n;
  const afterLakh = afterCrore % 100000n;
  const thousand = afterLakh / 1000n;
  const rest = afterLakh % 1000n;

  if (crore > 0n) parts.push(`${indianGroups(crore)} crore`);
  if (lakh > 0n) parts.push(`${underThousand(Number(lakh))} lakh`);
  if (thousand > 0n) parts.push(`${underThousand(Number(thousand))} thousand`);
  if (rest > 0n) parts.push(underThousand(Number(rest)));
  return parts.join(' ');
};

const capitalise = (s: string): string => (s.length === 0 ? s : `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`);

/** "Rupees one lakh eighty thousand and paise fifty only". */
export const amountInWords = (amount: Money): string => {
  const negative = amount.minor < 0n;
  const abs = negative ? -amount.minor : amount.minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const head = `rupees ${indianGroups(rupees)}`;
  const tail = paise === 0n ? '' : ` and paise ${underThousand(Number(paise))}`;
  return capitalise(`${negative ? 'minus ' : ''}${head}${tail} only`);
};
