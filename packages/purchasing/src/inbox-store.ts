// Issue #366 — where the purchase inbox (#15) keeps a document once it belongs to a company.
//
// Lane owner: GPT 3. The inbox service (inbox.ts) used to hold everything in private maps. A
// document that has been routed to a company now lives behind this port, in memory (below) or in
// PostgreSQL (inbox-postgres.ts); one contract suite (test/inbox-store-contract.ts) runs on both.
//
// A document whose company is not known yet — still being screened, held for the virus scanner,
// or delivered to an address no single company owns — is not here. It has no company to file it
// under, and row-level security has no company to check, so it is kept in the pre-tenant holding
// (inbox-holding.ts, #488) until it is routed or claimed.

import { conflict, notFound } from "@invoice/kernel";
import type { Id } from "../../masters/src/types.ts";
import { pageOf, type Page } from "./paging.ts";
import type { ExtractionDraft, InboundDocument, InboundStatus } from "./inbox-types.ts";

/** Kept beside a stored document; neither is part of what the inbox shows. */
export interface InboxDocumentKeys {
  /** The redelivery key of #406 (channel, delivery scope, provider message id and file), or null. */
  readonly messageKey: string | null;
  /** The intake idempotency key, so a retry records its draft under the same command. */
  readonly intakeKey: string;
}

export interface InboxStore {
  /** Refuses a second document with the same id or the same message key in a company. */
  insertDocument(document: InboundDocument, keys: InboxDocumentKeys): Promise<void>;
  /**
   * Saves what the service changes as a document moves on: status, hold reason and message,
   * duplicate link, attempts and routing. Nothing else about a stored document ever changes.
   */
  updateDocument(document: InboundDocument): Promise<void>;
  document(companyId: Id, id: Id): Promise<InboundDocument | null>;
  /** Oldest first, then by id. Leave `page` out for the whole list. */
  documents(companyId: Id, status?: InboundStatus, page?: Page): Promise<readonly InboundDocument[]>;
  documentByMessageKey(companyId: Id, messageKey: string): Promise<InboundDocument | null>;
  intakeKey(companyId: Id, documentId: Id): Promise<string | null>;
  /**
   * The first document of this company to hold a file keeps it: returns that document's id —
   * `documentId` when it is the first, the earlier one when it is not.
   */
  claimContent(companyId: Id, sha256: string, documentId: Id): Promise<Id>;
  /** One draft per document. */
  insertDraft(draft: ExtractionDraft): Promise<void>;
  draftFor(companyId: Id, documentId: Id): Promise<ExtractionDraft | null>;
}

export const inboxDocumentAlreadyStored = () =>
  conflict("INBOX_DOCUMENT_DUPLICATE", "This document has already been received, so it has not been added twice.");
export const inboxDraftAlreadyStored = () =>
  conflict("INBOX_DRAFT_DUPLICATE", "A draft has already been prepared for this document.");
export const inboxDocumentFinal = () =>
  conflict("INBOX_DOCUMENT_FINAL", "This document has already been dealt with, so it cannot be changed.");
/** Where the service never moves a document again, so neither store lets it change. */
const FINAL: ReadonlySet<InboundStatus> = new Set(["draft_ready", "discarded"]);
export const inboxDocumentNotFound = () => notFound("INBOX_DOCUMENT_UNKNOWN", "That document was not found.");

interface Stored { readonly document: InboundDocument; readonly keys: InboxDocumentKeys }
interface State { documents: Map<Id, Stored>; contents: Map<string, Id>; drafts: Map<Id, ExtractionDraft> }

const sorted = (rows: readonly InboundDocument[]): InboundDocument[] =>
  [...rows].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** The default store. `snapshot`/`restore` let a test (or the ledger store) roll it back with an action. */
export class InMemoryInboxStore implements InboxStore {
  #state: State = { documents: new Map(), contents: new Map(), drafts: new Map() };

  snapshot(): unknown {
    return { documents: new Map(this.#state.documents), contents: new Map(this.#state.contents), drafts: new Map(this.#state.drafts) };
  }

  restore(taken: unknown): void {
    this.#state = taken as State;
  }

  async insertDocument(document: InboundDocument, keys: InboxDocumentKeys): Promise<void> {
    const clash = [...this.#state.documents.values()].some((stored) =>
      stored.document.id === document.id
      || (keys.messageKey !== null && stored.document.companyId === document.companyId && stored.keys.messageKey === keys.messageKey));
    if (clash) throw inboxDocumentAlreadyStored();
    this.#state.documents.set(document.id, { document: Object.freeze(document), keys });
  }

  async updateDocument(document: InboundDocument): Promise<void> {
    const stored = this.#state.documents.get(document.id);
    if (!stored || stored.document.companyId !== document.companyId) throw inboxDocumentNotFound();
    if (FINAL.has(stored.document.status)) throw inboxDocumentFinal();
    this.#state.documents.set(document.id, { document: Object.freeze(document), keys: stored.keys });
  }

  async document(companyId: Id, id: Id): Promise<InboundDocument | null> {
    const stored = this.#state.documents.get(id);
    return stored && stored.document.companyId === companyId ? stored.document : null;
  }

  async documents(companyId: Id, status?: InboundStatus, page?: Page): Promise<readonly InboundDocument[]> {
    const rows = [...this.#state.documents.values()].map((stored) => stored.document)
      .filter((document) => document.companyId === companyId && (status === undefined || document.status === status));
    return pageOf(sorted(rows), page, (document) => document.receivedAt, (document) => document.id);
  }

  async documentByMessageKey(companyId: Id, messageKey: string): Promise<InboundDocument | null> {
    return [...this.#state.documents.values()].find((stored) => stored.document.companyId === companyId && stored.keys.messageKey === messageKey)?.document ?? null;
  }

  async intakeKey(companyId: Id, documentId: Id): Promise<string | null> {
    const stored = this.#state.documents.get(documentId);
    return stored && stored.document.companyId === companyId ? stored.keys.intakeKey : null;
  }

  async claimContent(companyId: Id, sha256: string, documentId: Id): Promise<Id> {
    if (!(await this.document(companyId, documentId))) throw inboxDocumentNotFound();
    const key = `${companyId}:${sha256}`;
    const earlier = this.#state.contents.get(key);
    if (earlier !== undefined) return earlier;
    this.#state.contents.set(key, documentId);
    return documentId;
  }

  async insertDraft(draft: ExtractionDraft): Promise<void> {
    if (!(await this.document(draft.companyId, draft.documentId))) throw inboxDocumentNotFound();
    const clash = [...this.#state.drafts.values()].some((stored) => stored.id === draft.id || stored.documentId === draft.documentId);
    if (clash) throw inboxDraftAlreadyStored();
    this.#state.drafts.set(draft.id, Object.freeze(draft));
  }

  async draftFor(companyId: Id, documentId: Id): Promise<ExtractionDraft | null> {
    return [...this.#state.drafts.values()].find((draft) => draft.companyId === companyId && draft.documentId === documentId) ?? null;
  }
}
