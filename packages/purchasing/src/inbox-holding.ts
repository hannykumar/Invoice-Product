// Issue #488 — where the purchase inbox (#15) keeps a document whose company is not known yet.
//
// Lane owner: GPT 3. Once a document is routed it lives in its company's books (inbox-store.ts,
// #366). Before that it has no company, and every table of a company's rows has forced row-level
// security. Those documents — still being screened, waiting for the virus scanner, delivered to an
// address several businesses share, or to an address nobody owns — used to live in process memory
// and were lost on a restart. They now live behind this port: in memory (below) or in PostgreSQL
// (inbox-holding-postgres.ts). One contract suite (test/inbox-holding-contract.ts) runs on both.
//
// What is held: ids, channel, message key, received time, the sender and the file's name, size,
// hash and storage key, and which businesses may claim it. Never the file itself (it stays in
// private object storage) and never anything read out of it. Row-level security is not bypassed:
// the holding has no company, so no company can read it; the few lookups a company may make are
// narrow functions that take the company from the session (inbox-migrations.ts).

import type { Id } from "../../masters/src/types.ts";
import type { ScanVerdict } from "./safety.ts";
import type { InboxDocumentKeys } from "./inbox-store.ts";
import type { InboundDocument, InboundStatus, IntakeChannel, QuarantineReason } from "./inbox-types.ts";

/** The `companyId` of a document nobody owns yet. */
export const UNROUTED = "__unrouted__";

/** The statuses an unrouted document can be in. Everything later happens inside a company. */
export type HeldStatus = Extract<InboundStatus, "received" | "screening" | "quarantined">;

/** What a restart needs, beyond the document, to carry on exactly where the process stopped. */
export interface HeldDelivery {
  /** The alias or number the provider delivered to; routing and the redelivery key are built from it. */
  readonly deliveredTo?: string;
  /** What the sender's scan answer was, if any (#401). */
  readonly scanVerdict?: ScanVerdict;
  /** The signed-in uploader: only the company and the person, never the session. */
  readonly uploader?: { readonly companyId: Id; readonly actorId: Id };
}

/** A document in the holding. `document.companyId` is always `UNROUTED`. */
export interface HeldRecord {
  readonly document: InboundDocument;
  readonly keys: InboxDocumentKeys;
  readonly delivery: HeldDelivery;
}

/** What a business sees of a document waiting for it: no storage key, no hash, nothing read from it. */
export interface WaitingItem {
  readonly id: Id;
  readonly channel: IntakeChannel;
  readonly receivedAt: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

export interface InboxHolding {
  /**
   * Stores a document that has just arrived, with the companies that may claim it (none yet).
   * A second document with the same message key is not stored: the first one is returned and
   * `created` is false, however many copies arrive at the same moment (#406).
   */
  put(record: HeldRecord, owners: readonly Id[]): Promise<{ readonly record: HeldRecord; readonly created: boolean }>;
  /**
   * Saves what the service changes while a document is unrouted: status, hold reason and message,
   * the page count and the companies that may claim it. Returns false when the document is no
   * longer there, or — with `from` — is no longer in that state, so two answers to one question
   * cannot both go ahead.
   */
  save(record: HeldRecord, owners: readonly Id[], from?: { readonly status: HeldStatus; readonly quarantineReason?: QuarantineReason }): Promise<boolean>;
  /** The server's own read, before any company is involved (the scanner's answer, a resume). */
  get(id: Id): Promise<HeldRecord | null>;
  byMessage(messageKey: string): Promise<HeldRecord | null>;
  /**
   * The narrow lookup: the ids of the companies whose channel the document arrived on, and
   * nothing else about them. Every call is written to the holding's trail.
   */
  channelOwners(id: Id): Promise<readonly Id[]>;
  /**
   * The documents waiting for this company to say they are its own: held `COMPANY_NOT_IDENTIFIED`
   * on an address it owns. The company is the caller's, never a field of the request.
   */
  waitingFor(companyId: Id): Promise<readonly WaitingItem[]>;
  /** The document, if this company may claim it. Reads; removes nothing. */
  peek(companyId: Id, id: Id): Promise<HeldRecord | null>;
  /**
   * Takes the document out of the holding for this company, if it may claim it. On PostgreSQL it
   * must run inside that company's unit of work, so the move into the company's books and the
   * removal from the holding commit together or not at all.
   */
  claim(companyId: Id, id: Id): Promise<HeldRecord | null>;
  /** Documents still being screened since before `before`: the process that was on them stopped. */
  stalled(before: Date): Promise<readonly HeldRecord[]>;
  /** Removes everything received before `before` and says which files it pointed at (D10). */
  expire(before: Date): Promise<readonly { readonly id: Id; readonly storageKey: string }[]>;
}

/** One line of the holding's trail: ids and a verb, never contents. */
export interface HoldingTrailEntry {
  readonly heldId: Id;
  readonly action: "received" | "owners_looked_up" | "claimed" | "expired";
  readonly companyId?: Id;
  readonly storageKey?: string;
}

/** The default holding. Gone on a restart, as before; `npm test` and a developer's machine need nothing else. */
export class InMemoryInboxHolding implements InboxHolding {
  readonly #rows = new Map<Id, { record: HeldRecord; owners: readonly Id[] }>();
  readonly #trail: HoldingTrailEntry[] = [];

  /** For tests: what was done, in order. */
  trail(): readonly HoldingTrailEntry[] { return [...this.#trail]; }

  async put(record: HeldRecord, owners: readonly Id[]) {
    const messageKey = record.keys.messageKey;
    const clash = messageKey === null ? undefined : [...this.#rows.values()].find((row) => row.record.keys.messageKey === messageKey);
    if (clash) return { record: clash.record, created: false };
    if (this.#rows.has(record.document.id)) throw new Error("HOLDING_ID_TAKEN");
    this.#rows.set(record.document.id, { record, owners: [...owners] });
    this.#trail.push({ heldId: record.document.id, action: "received" });
    return { record, created: true };
  }

  async save(record: HeldRecord, owners: readonly Id[], from?: { readonly status: HeldStatus; readonly quarantineReason?: QuarantineReason }): Promise<boolean> {
    const row = this.#rows.get(record.document.id);
    if (!row) return false;
    if (from && (row.record.document.status !== from.status || row.record.document.quarantineReason !== from.quarantineReason)) return false;
    this.#rows.set(record.document.id, { record, owners: [...owners] });
    return true;
  }

  async get(id: Id): Promise<HeldRecord | null> { return this.#rows.get(id)?.record ?? null; }

  async byMessage(messageKey: string): Promise<HeldRecord | null> {
    return [...this.#rows.values()].find((row) => row.record.keys.messageKey === messageKey)?.record ?? null;
  }

  async channelOwners(id: Id): Promise<readonly Id[]> {
    this.#trail.push({ heldId: id, action: "owners_looked_up" });
    return [...(this.#rows.get(id)?.owners ?? [])];
  }

  async waitingFor(companyId: Id): Promise<readonly WaitingItem[]> {
    const waiting = [...this.#rows.values()]
      .filter((row) => row.owners.includes(companyId) && row.record.document.status === "quarantined" && row.record.document.quarantineReason === "COMPANY_NOT_IDENTIFIED")
      .map((row) => row.record.document);
    const oldestFirst = [...waiting].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : 1));
    return oldestFirst.map((document) => ({ id: document.id, channel: document.channel, receivedAt: document.receivedAt, fileName: document.attachment.fileName, sizeBytes: document.attachment.sizeBytes }));
  }

  async peek(companyId: Id, id: Id): Promise<HeldRecord | null> {
    const row = this.#rows.get(id);
    return row && row.owners.includes(companyId) ? row.record : null;
  }

  async claim(companyId: Id, id: Id): Promise<HeldRecord | null> {
    const row = this.#rows.get(id);
    if (!row || !row.owners.includes(companyId)) return null;
    this.#rows.delete(id);
    this.#trail.push({ heldId: id, action: "claimed", companyId });
    return row.record;
  }

  async stalled(before: Date): Promise<readonly HeldRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => (row.record.document.status === "screening" || row.record.document.status === "received") && new Date(row.record.document.receivedAt) < before)
      .map((row) => row.record);
  }

  async expire(before: Date) {
    const gone = [...this.#rows.values()].filter((row) => new Date(row.record.document.receivedAt) < before);
    for (const row of gone) {
      this.#rows.delete(row.record.document.id);
      this.#trail.push({ heldId: row.record.document.id, action: "expired", storageKey: row.record.document.attachment.storageKey });
    }
    return gone.map((row) => ({ id: row.record.document.id, storageKey: row.record.document.attachment.storageKey }));
  }

  /** How many documents are held, for tests. */
  get size(): number { return this.#rows.size; }
}

/**
 * How long an unrouted document is kept, counted from the day it was received. A document no
 * business has accepted is not part of anyone's books, so D10's eight years (decision 0010) are
 * read as not applying to it; the DPDP Act asks for personal data (a sender's name and address)
 * to go once it is no longer needed. D10 has no row for this, so 30 days — the period it
 * proposes for application logs — is PROPOSED here, pending the owner and legal (D10: "Every
 * period is configuration"). Whether CGST s.36 / Rule 56 reach a received-but-unaccepted
 * document was not verified from a primary source.
 */
export const HOLDING_RETENTION_DAYS = 30;

export interface HoldingSweepResult { readonly expired: number; readonly bytesDiscarded: number }

/**
 * Removes everything held for longer than the retention period. `discardBytes` removes the file
 * from private object storage; where it is not given (the storage port has no delete yet) the keys
 * are left in the holding's trail as `expired` entries, so the file can still be found and removed.
 */
export async function sweepInboxHolding(
  holding: InboxHolding,
  options: { readonly now?: Date; readonly retentionDays?: number; readonly discardBytes?: (storageKey: string) => Promise<void> } = {},
): Promise<HoldingSweepResult> {
  const days = options.retentionDays ?? HOLDING_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 1) throw new Error("The retention period must be a whole number of days.");
  const before = new Date((options.now ?? new Date()).getTime() - days * 86_400_000);
  const gone = await holding.expire(before);
  let discarded = 0;
  for (const item of gone) {
    if (!options.discardBytes) continue;
    try { await options.discardBytes(item.storageKey); discarded += 1; } catch { /* the key stays in the trail */ }
  }
  return { expired: gone.length, bytesDiscarded: discarded };
}
