// Effective-dated versioning for master records.
//
// A master record is never overwritten. Each change appends a version that takes
// effect on a date. Reading a master "as of" a document date therefore returns what
// the record looked like when that document was raised — which is what keeps a
// reprinted invoice from silently acquiring this year's address.

import { PlatformError } from "../../platform/src/types.ts";
import type { Id, IsoDate } from "./types.ts";

export interface Version<T> {
  readonly recordId: Id;
  readonly companyId: Id;
  /** 1, 2, 3 … in the order the versions were recorded, not the order they take effect. */
  readonly version: number;
  readonly effectiveFrom: IsoDate;
  readonly data: T;
  readonly recordedAt: string;
  readonly recordedBy: Id;
  readonly reason?: string;
}

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const today = (clock: () => Date = () => new Date()): IsoDate => clock().toISOString().slice(0, 10);

/**
 * Append-only store of versioned records, scoped per company. Reads always take a
 * company id and throw rather than return another tenant's row.
 */
export class VersionedStore<T extends { readonly id: Id; readonly companyId: Id }> {
  readonly #versions = new Map<Id, Version<T>[]>();

  /** Records a new version. Back-dating is allowed and slots into the timeline. */
  append(data: T, effectiveFrom: IsoDate, recordedBy: Id, reason?: string): Version<T> {
    if (!isIsoDate(effectiveFrom)) throw new PlatformError("INVALID_TRANSITION", `"${effectiveFrom}" is not a date in YYYY-MM-DD form.`);
    const history = this.#versions.get(data.id) ?? [];
    const first = history[0];
    if (first && first.companyId !== data.companyId) throw new PlatformError("TENANT_ISOLATION", "This record belongs to another company.");
    const version: Version<T> = {
      recordId: data.id,
      companyId: data.companyId,
      version: history.length + 1,
      effectiveFrom,
      data: Object.freeze(data),
      recordedAt: new Date().toISOString(),
      recordedBy,
      ...(reason === undefined ? {} : { reason }),
    };
    history.push(Object.freeze(version));
    this.#versions.set(data.id, history);
    return version;
  }

  /** Every version of one record, oldest recorded first. */
  history(companyId: Id, id: Id): readonly Version<T>[] {
    const history = this.#versions.get(id);
    if (!history || history.length === 0) return [];
    if (history[0]?.companyId !== companyId) throw new PlatformError("TENANT_ISOLATION", "This record belongs to another company.");
    return history;
  }

  /** The version in force on `asOf`, or null when the record did not exist yet. */
  asOf(companyId: Id, id: Id, asOf: IsoDate): Version<T> | null {
    const applicable = this.history(companyId, id).filter((version) => version.effectiveFrom <= asOf);
    if (applicable.length === 0) return null;
    // Latest effective date wins; a later-recorded correction wins a tie.
    return applicable.reduce((best, candidate) => (candidate.effectiveFrom > best.effectiveFrom || (candidate.effectiveFrom === best.effectiveFrom && candidate.version > best.version) ? candidate : best));
  }

  /** The most recently recorded version, regardless of its effective date. */
  latest(companyId: Id, id: Id): Version<T> | null {
    const history = this.history(companyId, id);
    return history[history.length - 1] ?? null;
  }

  current(companyId: Id, id: Id, asOf: IsoDate = today()): T | null {
    return this.asOf(companyId, id, asOf)?.data ?? null;
  }

  /** Every record of this kind that exists as of a date, for one company. */
  list(companyId: Id, asOf: IsoDate = today()): readonly T[] {
    const rows: T[] = [];
    for (const [id, history] of this.#versions) {
      if (history[0]?.companyId !== companyId) continue;
      const version = this.asOf(companyId, id, asOf);
      if (version) rows.push(version.data);
    }
    return rows;
  }

  has(id: Id): boolean {
    return this.#versions.has(id);
  }

  size(companyId: Id): number {
    return this.list(companyId, "9999-12-31").length;
  }
}
