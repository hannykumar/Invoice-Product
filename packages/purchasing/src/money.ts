// Reading money off a document without floating point.
//
// Indian invoices write amounts as 1,23,456.78 with a rupee sign, sometimes with the
// paise separated by a space or missing entirely. Every amount becomes an exact bigint
// number of paise, or null — never an approximation.

export function parsePaise(raw: string): bigint | null {
  const cleaned = raw.replace(/[₹\sRrSs.]*$/u, "").replace(/^[₹\s]*(INR|Rs\.?|₹)?\s*/iu, "").replace(/,/g, "").trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, sign = "", whole = "0", fraction = ""] = match;
  const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return sign === "-" ? -paise : paise;
}

export function formatPaise(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const rupees = (absolute / 100n).toString();
  const paise = (absolute % 100n).toString().padStart(2, "0");
  // Indian grouping: last three digits, then pairs.
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}.${paise}`;
}

/** Amounts in e-invoice JSON are numbers of rupees; this keeps them exact. */
export function rupeesToPaise(value: number | string): bigint | null {
  return parsePaise(typeof value === "number" ? value.toFixed(2) : value);
}
