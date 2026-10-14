// Issue #366 — one page of a list, the same way in memory and in PostgreSQL.
//
// A list is walked in a fixed order: oldest first, and by id where two rows share a moment. The
// caller hands back the id of the last row it saw and gets the rows after it, so every row is
// seen exactly once however many pages it takes. Leave the page out and the whole list comes back,
// as it always did.

import { invalid } from "@invoice/kernel";

export interface Page {
  readonly limit: number;
  /** The id of the last row of the previous page. For supplier checks, its fingerprint. */
  readonly after?: string;
}

export const pageLimit = (page: Page): number => {
  if (!Number.isInteger(page.limit) || page.limit <= 0) {
    throw invalid("PAGE_LIMIT_INVALID", "A page needs a whole number of rows, at least one.");
  }
  return page.limit;
};

/** The in-memory half. `at` is when the row was written, `id` its stable key. */
export const pageOf = <T>(rows: readonly T[], page: Page | undefined, at: (row: T) => string, id: (row: T) => string): T[] => {
  if (page === undefined) return [...rows];
  const limit = pageLimit(page);
  const sorted = [...rows].sort((left, right) =>
    at(left) < at(right) ? -1 : at(left) > at(right) ? 1 : id(left) < id(right) ? -1 : id(left) > id(right) ? 1 : 0);
  if (page.after === undefined) return sorted.slice(0, limit);
  const last = sorted.findIndex((row) => id(row) === page.after);
  // A cursor that names no row of this list gives nothing, rather than starting again from the top.
  return last < 0 ? [] : sorted.slice(last + 1, last + 1 + limit);
};
