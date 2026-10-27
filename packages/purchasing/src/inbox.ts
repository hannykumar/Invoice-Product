// The omnichannel purchase-invoice inbox (issue #15).
//
// A document arrives from WhatsApp, email, a camera, an upload or an e-invoice JSON
// file. This service screens it, decides which company it belongs to, reads it, and
// produces a reviewable draft. It posts nothing: no ledger entry, no stock movement, no
// payable. Validation is issue #16 and posting is issue #17.
//
// One deliberate ordering choice: a document is routed to a company *before* its pages
// are sent to the OCR provider, so no company's paperwork is ever processed under
// another company's tenant.
//
// Issue #400: only facts the sender cannot write route a document — the uploader's
// session, or the address the provider delivered it to (routing.ts). The GST numbers
// printed in it are then a cross-check that can *hold* the document in that company, never
// move it to another. Every later command (`retry`, `assignCompany`) takes the caller's
// `RequestContext` and works only on that company's documents.

import { createHash, randomUUID } from "node:crypto";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { PlatformError } from "../../platform/src/types.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import type { AuditLog, PlatformCommandService } from "../../platform/src/platform.ts";
import type { Id } from "../../masters/src/types.ts";
import { NO_IRP_SIGNING_KEY } from "../../gst/src/irp-signature.ts";
import type { IrpSignatureVerifier } from "../../gst/src/irp-signature.ts";
import { screenAttachment } from "./safety.ts";
import type { ScanVerdict, SupportedType } from "./safety.ts";
import { assertDistinctChannels, deliveryKey, routeDocument } from "./routing.ts";
import type { CompanyRoutingProfile } from "./routing.ts";
import { readEInvoiceJson } from "./einvoice.ts";
import type { EInvoiceReadResult } from "./einvoice.ts";
import { crossCheck, readInvoiceFromOcr } from "./extraction.ts";
import type { OcrReadResult } from "./extraction.ts";
import type { OcrAdapter } from "./ocr.ts";
import { InMemoryInboxStore } from "./inbox-store.ts";
import type { InboxStore } from "./inbox-store.ts";
import { InMemoryInboxHolding, UNROUTED } from "./inbox-holding.ts";
import type { HeldRecord, InboxHolding, WaitingItem } from "./inbox-holding.ts";
import type { Page } from "./paging.ts";
import type { Attachment, ExtractedField, ExtractionDraft, InboundDocument, InboundSender, InboundStatus, IntakeChannel, LogicalInvoiceKey, QuarantineReason } from "./inbox-types.ts";

export class InboxError extends Error {
  public readonly code: "NOT_FOUND" | "TENANT_ISOLATION" | "INVALID_STATE";
  constructor(code: InboxError["code"], message: string) { super(message); this.code = code; }
}

export interface ReceiveInput {
  readonly channel: IntakeChannel;
  readonly sender: InboundSender;
  readonly attachment: Attachment;
  /**
   * The whole file. Its size and SHA-256 are measured here from the bytes — the
   * `sizeBytes`/`sha256` the caller declared on `attachment` are never trusted (#401).
   * For an e-invoice JSON this is also the parsed body.
   */
  readonly bytes: Uint8Array;
  readonly scanVerdict?: ScanVerdict;
  /**
   * The alias or number the document was delivered to, for channel routing. The channel
   * adapter must take it from the provider's delivery record (SMTP envelope recipient,
   * WhatsApp Business phone-number id), never from a header the sender wrote.
   */
  readonly deliveredTo?: string;
  /**
   * The signed-in user who uploaded this. The company is taken from this context and
   * nowhere else (#400: a caller-supplied company id is never authority).
   */
  readonly uploader?: RequestContext;
  /** Required. A resend of the same provider message returns the original document. */
  readonly idempotencyKey: string;
}

export interface ReceiveResult {
  readonly document: InboundDocument;
  readonly draft?: ExtractionDraft;
  /** True when this exact file had already been received for this company. */
  readonly duplicate: boolean;
}

export interface PurchaseInboxOptions {
  /**
   * Checks the Invoice Registration Portal's signature on e-invoice JSON. Without one, no
   * file is ever treated as signed (packages/gst/src/irp-signature.ts).
   */
  readonly irpSignatures?: IrpSignatureVerifier;
  /**
   * Where a document is kept once it belongs to a company (#366). In memory unless given; the app
   * passes `PostgresInboxStore` when it runs on PostgreSQL.
   */
  readonly store?: InboxStore;
  /**
   * Runs one step's writes for a company in one transaction: on PostgreSQL,
   * `(companyId, work) => db.unitOfWork(companyId, () => work())`. The inbox calls it itself, one
   * short step at a time, because the company is only known after routing and the OCR read must
   * never run inside a transaction. Without it the steps simply run.
   */
  readonly unitOfWork?: <T>(companyId: Id, work: () => Promise<T>) => Promise<T>;
  /**
   * Where a document is kept while its company is not known yet (#488). In memory unless given;
   * the app passes `PostgresInboxHolding`, so a message held for a shared address survives a restart.
   */
  readonly holding?: InboxHolding;
  /**
   * Reads a held file back from private object storage by its key. Given, the service never keeps
   * a held file's bytes in memory, which is what lets a restart carry on with a file that was
   * waiting for the virus scanner. Without it the bytes are kept in this process, as before.
   */
  readonly readBytes?: (storageKey: string) => Promise<Uint8Array | null>;
}

/** Below this confidence a field must be looked at before the draft moves on. */
export const REVIEW_CONFIDENCE = 0.8;
/** Below this, the document is not worth reviewing at all and is quarantined. */
export const QUARANTINE_CONFIDENCE = 0.4;

/** Claiming a held document, or asking for it to be read again (#400). */
export const INBOX_MANAGE_PERMISSION: Permission = "purchase.inbox.manage";

/**
 * One answer for "does not exist" and "belongs to another company", so a document id from
 * another company cannot be probed for (#400).
 */
const notFound = (): InboxError => new InboxError("NOT_FOUND", "That document was not found.");

/** The quarantine reasons a person may resolve by saying which company a document is for. */
const ASSIGNABLE: ReadonlySet<QuarantineReason> = new Set(["COMPANY_NOT_IDENTIFIED", "COMPANY_MISMATCH"]);

const same = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * The redelivery dedup key, built only from facts the sender cannot write (#406): the company
 * an upload was made into, or the channel and destination the provider delivered to — plus the
 * file itself. A provider message id is never trusted on its own: an email `Message-ID` is the
 * sender's own text and a camera or upload id is the client's, so two different bills can carry
 * the same id. Scoped this way, a resend of one delivery is still one document, while the same
 * id on another channel, another destination or another file is a new document — never a
 * "duplicate" answer that returns a different company's paperwork or drops a real bill.
 */
const providerMessageKey = (input: ReceiveInput): string | null => {
  const id = input.sender.providerMessageId?.trim();
  if (!id) return null;
  const scope = input.uploader ? `uploader:${input.uploader.companyId}` : `delivery:${deliveryKey(input.channel, input.deliveredTo) ?? "unbound"}`;
  return `${input.channel}:${scope}:${id}:${input.attachment.sha256}`;
};

export class PurchaseInboxService {
  readonly #commands: PlatformCommandService;
  readonly #audit: AuditLog;
  readonly #ocr: OcrAdapter;
  readonly #companies: readonly CompanyRoutingProfile[];
  readonly #signatures: IrpSignatureVerifier;
  /** Routed documents, their drafts, and the company-scoped duplicate keys (#366). */
  readonly #store: InboxStore;
  readonly #unitOfWork: <T>(companyId: Id, work: () => Promise<T>) => Promise<T>;
  /** The unrouted holding (#488): documents whose company is not known yet, durable where the app gives it a database. */
  readonly #holding: InboxHolding;
  readonly #readBytes: ((storageKey: string) => Promise<Uint8Array | null>) | undefined;
  /** Held files' bytes, only when there is no object store to read them back from. */
  readonly #heldBytes = new Map<Id, Uint8Array>();

  constructor(commands: PlatformCommandService, audit: AuditLog, ocr: OcrAdapter, companies: readonly CompanyRoutingProfile[], options: PurchaseInboxOptions = {}) {
    this.#commands = commands;
    this.#audit = audit;
    this.#ocr = ocr;
    // An address under two businesses that do not share an owner would let one claim the
    // other's documents (#400 review), so that configuration is refused outright.
    assertDistinctChannels(companies);
    this.#companies = companies;
    this.#signatures = options.irpSignatures ?? NO_IRP_SIGNING_KEY;
    this.#store = options.store ?? new InMemoryInboxStore();
    this.#unitOfWork = options.unitOfWork ?? ((_companyId, work) => work());
    this.#holding = options.holding ?? new InMemoryInboxHolding();
    this.#readBytes = options.readBytes;
  }

  // ------------------------------------------------------------------ reading

  async document(context: RequestContext, id: Id): Promise<InboundDocument> {
    const found = await this.#store.document(context.companyId, id);
    if (!found) throw notFound();
    return found;
  }

  async draft(context: RequestContext, documentId: Id): Promise<ExtractionDraft> {
    const document = await this.document(context, documentId);
    const draft = await this.#store.draftFor(document.companyId, document.id);
    if (!draft) throw new InboxError("NOT_FOUND", "This document has no draft yet.");
    return draft;
  }

  /** Oldest first. Leave `page` out for the whole inbox, as before (#366). */
  inbox(context: RequestContext, status?: InboundStatus, page?: Page): Promise<readonly InboundDocument[]> {
    return this.#store.documents(context.companyId, status, page);
  }

  /**
   * Documents that arrived on an address this company shares with another (so routing could
   * not choose) and are waiting for someone to claim them. Only the file name, size, channel
   * and time are shown: nothing has been read from them, and no storage key or hash leaves.
   */
  awaitingAssignment(context: RequestContext): Promise<readonly WaitingItem[]> {
    return this.#holding.waitingFor(context.companyId);
  }

  /** The key #16 will use to spot the same invoice arriving twice through two channels. */
  logicalKey(draft: ExtractionDraft): LogicalInvoiceKey | null {
    const supplier = draft.supplierGstin?.value;
    const number = draft.invoiceNumber?.value;
    const date = draft.invoiceDate?.value;
    const total = draft.invoiceTotalPaise?.value;
    if (!supplier || !number || !date || total === undefined) return null;
    return { supplierGstin: supplier, invoiceNumber: number.toUpperCase(), invoiceDate: date, invoiceTotalPaise: total.toString() };
  }

  // ------------------------------------------------------------------ writing

  async receive(input: ReceiveInput): Promise<ReceiveResult> {
    // The file is measured before anything trusts it: the size and hash the caller
    // declared are replaced by what the bytes actually contain (#401). Dedup keys,
    // the size cap and the stored record all use the measured values, so a lying
    // upload cannot smuggle a bigger file past the cap or claim another file's hash.
    const measured: Attachment = {
      ...input.attachment,
      sizeBytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
    };
    const checked: ReceiveInput = { ...input, attachment: measured };

    const messageKey = providerMessageKey(checked);
    if (messageKey) {
      // The key is scoped to this delivery's destination and file, so the document found is
      // always one that arrived on this same binding — never another company's document (#406).
      const stored = await this.#storedByMessage(checked, messageKey);
      if (stored) return stored;
      const held = await this.#holding.byMessage(messageKey);
      if (held) return { document: held.document, duplicate: true };
    }

    const id = randomUUID();
    const record: HeldRecord = {
      // Screening starts at once, so that is where it is kept from the first moment.
      document: Object.freeze({
        id,
        companyId: UNROUTED,
        channel: input.channel,
        sender: input.sender,
        attachment: measured,
        receivedAt: new Date().toISOString(),
        status: "screening",
        attempts: 1,
      }) as InboundDocument,
      keys: { messageKey, intakeKey: input.idempotencyKey },
      delivery: {
        ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
        ...(input.scanVerdict === undefined ? {} : { scanVerdict: input.scanVerdict }),
        ...(input.uploader === undefined ? {} : { uploader: { companyId: input.uploader.companyId, actorId: input.uploader.actorId } }),
      },
    };
    // Written before anything else happens, so a restart cannot lose it. Two copies of one message
    // arriving at once make one document: the second is told about the first (#406).
    const put = await this.#holding.put(record, []);
    if (!put.created) return { document: put.record.document, duplicate: true };
    if (!this.#readBytes) this.#heldBytes.set(id, input.bytes);
    return this.#screenAndRoute(record, checked);
  }

  /**
   * The virus scanner has answered for a document that was held as `AWAITING_SCAN`
   * (#401). A clean verdict runs it through the identical pipeline any other file
   * takes — routing, duplicate check, reading — so a held document can never skip a
   * step. An infected verdict holds it for good. Called by the scanner integration,
   * not by a tenant: the document is still unrouted, so no RequestContext exists yet.
   * The document is read from the holding, so the answer may arrive after a restart (#488).
   */
  async scanAnswered(documentId: Id, verdict: ScanVerdict): Promise<ReceiveResult> {
    const record = await this.#holding.get(documentId);
    const document = record?.document;
    if (!record || !document || document.status !== "quarantined" || document.quarantineReason !== "AWAITING_SCAN") {
      throw new InboxError("INVALID_STATE", "This document is not waiting for a virus check.");
    }
    if (verdict === "unscanned") throw new InboxError("INVALID_STATE", "A scan answer must be clean or infected.");
    const waiting = { status: "quarantined", quarantineReason: "AWAITING_SCAN" } as const;
    if (verdict === "infected") {
      const held = await this.#saveHeld(record, { status: "quarantined", quarantineReason: "MALWARE_SUSPECTED", statusMessage: "This file was flagged as unsafe by the virus scanner, so it has not been opened." }, [], waiting);
      if (!held) throw new InboxError("INVALID_STATE", "This document is not waiting for a virus check.");
      this.#record(held.document, "purchase.inbox.quarantined", { reason: "MALWARE_SUSPECTED", message: held.document.statusMessage ?? "" });
      return { document: held.document, duplicate: false };
    }
    // The hold is lifted: its reason and message go, everything else is kept. Only the first of
    // two answers to the same question gets through.
    const { quarantineReason: _hold, statusMessage: _holdMessage, ...fields } = document;
    const released = await this.#saveHeld({ ...record, document: fields as InboundDocument }, { status: "screening" }, [], waiting);
    if (!released) throw new InboxError("INVALID_STATE", "This document is not waiting for a virus check.");
    const input = await this.#inputFor(released);
    if (!input) return this.#fileGone(released);
    return this.#screenAndRoute(released, { ...input, scanVerdict: "clean" });
  }

  /**
   * Carries on with documents a process stopped on: still being screened since before `before`.
   * Each is read back from private object storage and goes through the same screening, routing and
   * reading as a new arrival. A document whose file cannot be found is held with a plain message.
   */
  async resumeInterrupted(before: Date): Promise<number> {
    let resumed = 0;
    for (const record of await this.#holding.stalled(before)) {
      const input = await this.#inputFor(record);
      if (!input) { await this.#fileGone(record); continue; }
      try { await this.#screenAndRoute(record, input); resumed += 1; } catch (error) {
        // Another process got there first, or this one failed: the document stays held and is tried again.
        if ((error as { code?: string }).code !== "INBOX_DOCUMENT_DUPLICATE") throw error;
      }
    }
    return resumed;
  }

  /** The delivery as it was, rebuilt from the holding and the stored file; null when the file is gone. */
  async #inputFor(record: HeldRecord): Promise<ReceiveInput | null> {
    const document = record.document;
    const bytes = this.#heldBytes.get(document.id) ?? (this.#readBytes ? await this.#readBytes(document.attachment.storageKey) : null);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== document.attachment.sha256) return null;
    const { deliveredTo, scanVerdict, uploader } = record.delivery;
    return {
      channel: document.channel,
      sender: document.sender,
      attachment: document.attachment,
      bytes,
      idempotencyKey: record.keys.intakeKey,
      ...(deliveredTo === undefined ? {} : { deliveredTo }),
      ...(scanVerdict === undefined ? {} : { scanVerdict }),
      // Only the company and the person survive a restart, which is all routing and the audit trail use.
      ...(uploader === undefined ? {} : { uploader: { companyId: uploader.companyId, branchId: uploader.companyId, actorId: uploader.actorId, permissions: new Set<Permission>(), sessionId: document.id } }),
    };
  }

  async #fileGone(record: HeldRecord): Promise<ReceiveResult> {
    const held = await this.#saveHeld(record, { status: "quarantined", quarantineReason: "UNREADABLE", statusMessage: "The file for this document could not be found any more, so it could not be checked. Please send it again." }, []);
    return { document: (held ?? record).document, duplicate: false };
  }

  /** Screening, then routing and reading: what every held document goes through. */
  async #screenAndRoute(record: HeldRecord, checked: ReceiveInput): Promise<ReceiveResult> {
    let held = record;
    const screening = await screenAttachment(held.document.attachment, checked.bytes, checked.scanVerdict ?? "unscanned");
    if (!screening.ok) {
      // A file waiting on the scanner keeps its place in the holding so "clean" can release it
      // back into this same pipeline (#401), even after a restart; every other hold ends here.
      const quarantined = await this.#saveHeld(held, { status: "quarantined", quarantineReason: screening.reason, statusMessage: screening.message }, []);
      this.#record((quarantined ?? held).document, "purchase.inbox.quarantined", { reason: screening.reason, message: screening.message });
      return { document: (quarantined ?? held).document, duplicate: false };
    }
    if (screening.pageCount !== undefined) {
      held = await this.#saveHeld(held, { attachment: { ...held.document.attachment, pageCount: screening.pageCount } }, []) ?? held;
    }
    return this.#routeAndDraft(held, checked, screening.detectedType);
  }

  /**
   * Everything after a file has passed screening: route to a company, drop a file
   * the company already has, then read and draft. `scanAnswered` releases a held
   * document into exactly this path, so a released file is never read differently.
   */
  async #routeAndDraft(record: HeldRecord, input: ReceiveInput, detectedType: SupportedType): Promise<ReceiveResult> {
    const document = record.document;
    // 2. Routing, from the uploader's session or the delivery address only. Nothing inside
    //    the file is consulted (#400).
    const routing = this.#route(input);
    if (!routing.ok) {
      // Kept with the companies that may claim it, so it can be found again after a restart.
      const held = await this.#saveHeld(record, { status: "quarantined", quarantineReason: routing.reason, statusMessage: routing.message }, routing.channelOwners);
      this.#record((held ?? record).document, "purchase.inbox.quarantined", { reason: routing.reason, message: routing.message });
      return { document: (held ?? record).document, duplicate: false };
    }
    const companyId = routing.companyId;
    const routed = Object.freeze({ ...document, companyId, routing: routing.decision }) as InboundDocument;
    const messageKey = record.keys.messageKey;
    const intakeKey = record.keys.intakeKey;
    // The company that routing chose is the one that may take it out of the holding.
    await this.#saveHeld(record, {}, [companyId]);

    // From here the document belongs to a company and is stored in that company's books (#366).
    // 3. Attachment-level duplicate check, scoped to the company that owns the file.
    //    The hash was measured from the bytes at intake (#401), not taken from the sender.
    const outcome = await this.#unitOfWork(companyId, async (): Promise<ReceiveResult | null> => {
      // Out of the holding and into this company's books in one unit of work (#488): both happen
      // or neither does. Nothing is left behind in the holding, and nothing is lost.
      await this.#holding.claim(companyId, document.id);
      // The same delivery, stored by another server while this one was screening it (#406).
      const redelivered = messageKey ? await this.#store.documentByMessageKey(companyId, messageKey) : null;
      if (redelivered) return this.#withDraft(redelivered);
      await this.#store.insertDocument(routed, { messageKey, intakeKey });
      const earlier = await this.#store.claimContent(companyId, routed.attachment.sha256, routed.id);
      if (earlier === routed.id) return null;
      const original = await this.#store.document(companyId, earlier) as InboundDocument;
      const marked = await this.#update(routed, {
        status: "discarded",
        duplicateOfId: earlier,
        statusMessage: `This is the same file you already received on ${new Date(original.receivedAt).toDateString()} through ${original.channel.replace("_", " ")}, so it has not been added twice.`,
      });
      this.#record(marked, "purchase.inbox.duplicate_discarded", { duplicateOfId: earlier });
      return { document: marked, duplicate: true };
    }).catch(async (error: unknown) => {
      // The store's unique key refused a second copy written at the same moment (#406): the
      // first one is the document, so answer with it.
      const redelivered = messageKey && (error as { code?: string }).code === "INBOX_DOCUMENT_DUPLICATE"
        ? await this.#store.documentByMessageKey(companyId, messageKey) : null;
      if (!redelivered) throw error;
      return this.#withDraft(redelivered);
    });
    this.#heldBytes.delete(document.id);
    if (outcome) return outcome;

    // 4-6. Reading, cross-checking and drafting.
    const company = this.#companies.find((candidate) => candidate.companyId === companyId) as CompanyRoutingProfile;
    return this.#readAndDraft(routed, company, {
      // An e-invoice JSON file is its own body; the text comes from the received bytes.
      json: detectedType === "json" ? { body: new TextDecoder("utf-8").decode(input.bytes) } : null,
      ...(input.uploader === undefined ? {} : { actor: input.uploader }),
    });
  }

  /**
   * Retries a failed document of the caller's own company. The OCR idempotency key is
   * derived from the document id, so a provider that already produced a result returns the
   * same one instead of charging for a second read. The retry goes through exactly the same
   * reading, cross-check and review rules as the first attempt (#400): a retry is never a way
   * round the company check or the review list.
   */
  async retry(context: RequestContext, documentId: Id): Promise<ReceiveResult> {
    const document = await this.document(context, documentId);
    this.#require(context);
    if (document.status !== "failed") throw new InboxError("INVALID_STATE", "Only a document that failed can be tried again.");
    const company = this.#companies.find((candidate) => candidate.companyId === document.companyId);
    if (!company) throw new InboxError("INVALID_STATE", "This document has not been routed to a company yet.");
    const attempted = await this.#update(document, { attempts: document.attempts + 1 });
    return this.#readAndDraft(attempted, company, { json: null, actor: context });
  }

  /**
   * A person in the caller's company deciding that a document held for its company is
   * theirs after all. Allowed only for a document that is already in this company, or one
   * that arrived on an address this company owns (#400). A document that arrived on nobody's
   * address cannot be claimed by anybody, however its id was learned.
   */
  async assignCompany(context: RequestContext, documentId: Id, reason: string): Promise<InboundDocument> {
    // Held, still unrouted — or already in this company's books (quarantined COMPANY_MISMATCH).
    const held = await this.#holding.get(documentId);
    const document = held?.document ?? await this.#store.document(context.companyId, documentId);
    if (!document) throw notFound();
    // The ids of the companies whose channel it arrived on, from the narrow audited lookup (#488).
    const mayClaim = held
      ? (await this.#holding.channelOwners(documentId)).includes(context.companyId)
      : document.companyId === context.companyId;
    if (!mayClaim) throw notFound();
    this.#require(context);
    if (document.status !== "quarantined" || !document.quarantineReason || !ASSIGNABLE.has(document.quarantineReason)) {
      throw new InboxError("INVALID_STATE", "Only a document held because its business was unclear can be assigned. Other holds, such as an unsafe file, cannot be cleared this way.");
    }
    if (!reason.trim()) throw new InboxError("INVALID_STATE", "Please say why this document belongs to this business.");
    // The hold is lifted, so its reason goes; the decision and who made it are kept.
    const { quarantineReason, ...rest } = document;
    const assigned = Object.freeze({
      ...rest,
      companyId: context.companyId,
      status: "received",
      statusMessage: "Assigned to this business by hand. Nothing has been read or posted yet.",
      routing: { basis: "explicit_company", evidence: `Assigned by ${context.actorId}: ${reason.trim()}`, confidence: 1 },
    }) as InboundDocument;
    await this.#unitOfWork(context.companyId, async () => {
      if (held) {
        // Out of the unrouted holding and into this company's books, with the keys it arrived with,
        // in one unit of work. If another person took it first there is nothing left to assign.
        if (!(await this.#holding.claim(context.companyId, documentId))) throw notFound();
        await this.#store.insertDocument(assigned, held.keys);
      } else {
        await this.#store.updateDocument(assigned);
      }
      // The file now belongs to this company, so the same file arriving again is a duplicate here.
      await this.#store.claimContent(context.companyId, document.attachment.sha256, document.id);
      this.#record(assigned, "purchase.inbox.company_assigned", { reason: reason.trim(), quarantineReason }, context.actorId);
    });
    this.#heldBytes.delete(documentId);
    return assigned;
  }

  // ---------------------------------------------------------------- internals

  async #readAndDraft(
    routed: InboundDocument,
    company: CompanyRoutingProfile,
    options: { readonly json: { readonly body: string } | null; readonly actor?: RequestContext },
  ): Promise<ReceiveResult> {
    let document = await this.#update(routed, { status: "extracting" });

    // Reading. e-invoice JSON is parsed locally, its IRP signature checked first.
    let eInvoice: EInvoiceReadResult | null = null;
    let read: OcrReadResult | null = null;
    if (options.json) {
      eInvoice = options.json.body ? readEInvoiceJson(options.json.body, { signatures: this.#signatures }) : null;
      if (eInvoice?.signature === "invalid") {
        return { document: await this.#hold(document, "SIGNATURE_INVALID", `This e-invoice file carries a government signature that does not match what is written in it, so it may have been altered. It has been held. Ask the supplier for the original. (${eInvoice.signatureMessage ?? ""})`.replace(" ()", "")), duplicate: false };
      }
      if (!eInvoice?.invoiceNumber) {
        return { document: await this.#hold(document, "NOT_AN_INVOICE", eInvoice?.problems[0] ?? "This JSON file is not a GST e-invoice."), duplicate: false };
      }
    } else {
      try {
        const ocr = await this.#ocr.read({ companyId: company.companyId, storageKey: document.attachment.storageKey, idempotencyKey: `ocr:${document.id}`, correlationId: document.id });
        read = readInvoiceFromOcr(ocr.pages, { companyGstins: company.gstins });
      } catch (error) {
        const connectorError = error instanceof ConnectorError ? error : null;
        const firstAttempt = document.attempts <= 1;
        const failed = await this.#update(document, {
          status: "failed",
          statusMessage: connectorError?.retryable
            ? (firstAttempt ? "The document reader is temporarily unavailable. This will be tried again automatically." : "Still unavailable. This will be tried again.")
            : "This document could not be read.",
        });
        this.#record(failed, "purchase.inbox.extraction_failed", { code: connectorError?.code ?? "UNKNOWN", retryable: connectorError?.retryable ?? false, attempt: failed.attempts });
        return { document: failed, duplicate: false };
      }
      if (read.unreadable) return { document: await this.#hold(document, "UNREADABLE", read.problems[0] ?? "This document could not be read."), duplicate: false };
    }

    // Cross-check against what is printed. It can hold the document here; it never moves it.
    // The other business is never named: the list of companies is every tenant, and naming
    // one would tell this company who else uses the product (#400).
    const readFields = eInvoice ?? read;
    if (!readFields) return { document: await this.#hold(document, "UNREADABLE", "This document could not be read."), duplicate: false };
    const buyer = readFields.buyerGstin?.value;
    const printed = readFields.allGstins;
    const namesThisCompany = company.gstins.some((gstin) => printed.some((seen) => same(seen, gstin)));
    if (buyer && !company.gstins.some((gstin) => same(gstin, buyer))) {
      return {
        document: await this.#hold(document, "COMPANY_MISMATCH", `This invoice is addressed to GST number ${buyer.trim().toUpperCase()}, which is not one of ${company.legalName}'s GST numbers. It has been held rather than filed in the wrong books.`),
        duplicate: false,
      };
    }
    if (routed.routing?.basis === "channel_binding" && printed.length > 0 && !namesThisCompany) {
      return {
        document: await this.#hold(document, "COMPANY_MISMATCH", `This invoice does not name ${company.legalName}'s GST number, so it has been held for you to confirm which business it belongs to.`),
        duplicate: false,
      };
    }

    // Draft.
    const source = eInvoice ? "einvoice_json" : "ocr";
    const fields = {
      ...(readFields.supplierGstin ? { supplierGstin: readFields.supplierGstin } : {}),
      ...(readFields.supplierName ? { supplierName: readFields.supplierName } : {}),
      ...(readFields.buyerGstin ? { buyerGstin: readFields.buyerGstin } : {}),
      ...(readFields.invoiceNumber ? { invoiceNumber: readFields.invoiceNumber } : {}),
      ...(readFields.invoiceDate ? { invoiceDate: readFields.invoiceDate } : {}),
      ...(readFields.taxableValuePaise ? { taxableValuePaise: readFields.taxableValuePaise } : {}),
      ...(readFields.totalTaxPaise ? { totalTaxPaise: readFields.totalTaxPaise } : {}),
      ...(readFields.invoiceTotalPaise ? { invoiceTotalPaise: readFields.invoiceTotalPaise } : {}),
      ...(readFields.irn ? { irn: readFields.irn } : {}),
    };
    const named: readonly [string, ExtractedField<unknown> | undefined][] = Object.entries(fields);
    const fieldsNeedingReview = named.filter(([, value]) => value !== undefined && value.confidence < REVIEW_CONFIDENCE).map(([name]) => name);
    const essential = ["supplierGstin", "invoiceNumber", "invoiceDate", "invoiceTotalPaise"] as const;
    const missing = essential.filter((name) => fields[name] === undefined);
    const worst = named.reduce((lowest, [, value]) => (value && value.confidence < lowest ? value.confidence : lowest), 1);

    if (source === "ocr" && (missing.length >= 3 || worst < QUARANTINE_CONFIDENCE)) {
      return {
        document: await this.#hold(document, "EXTRACTION_TOO_UNCERTAIN", `Too little could be read from this document to prepare a draft${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. Please send a clearer copy or enter it by hand.`),
        duplicate: false,
      };
    }

    const signatureNote = eInvoice && eInvoice.signature !== "verified"
      ? [eInvoice.signatureMessage ?? "This e-invoice file carries no government signature, so every value in it needs checking."]
      : [];
    const draft: ExtractionDraft = {
      id: randomUUID(),
      companyId: company.companyId,
      documentId: document.id,
      source,
      ...(eInvoice ? { signature: eInvoice.signature } : {}),
      ...fields,
      lines: readFields.lines,
      fieldsNeedingReview: [...fieldsNeedingReview, ...missing.map((name) => `${name} (not found)`)],
      arithmeticProblems: [...crossCheck({ ...fields, lines: readFields.lines }), ...readFields.problems, ...signatureNote],
      createdAt: new Date().toISOString(),
    };
    const extracted = document;
    // The draft, the document's move to "draft ready" and the command are saved together (#366).
    return this.#unitOfWork(company.companyId, async () => {
      await this.#store.insertDraft(Object.freeze(draft));
      const retried = extracted.attempts > 1;
      const ready = await this.#update(extracted, {
        status: "draft_ready",
        statusMessage: draft.fieldsNeedingReview.length === 0 && draft.arithmeticProblems.length === 0
          ? `Read successfully${retried ? " on retry" : ""}. Nothing has been posted yet — please review and approve.`
          : `Read${retried ? " on retry" : ""}, but ${draft.fieldsNeedingReview.length + draft.arithmeticProblems.length} thing(s) need your eye. Nothing has been posted yet.`,
      });
      // A command records the intake for audit and idempotency. It finalises at "draft
      // prepared"; approving and posting the purchase are separate commands in #16/#17.
      const context: RequestContext = options.actor && options.actor.companyId === company.companyId
        ? options.actor
        : { companyId: company.companyId, branchId: company.companyId, actorId: ready.sender.address, permissions: new Set(), sessionId: ready.id };
      const command = this.#commands.create(context, {
        action: "purchase.inbox.draft_prepared",
        risk: "low",
        idempotencyKey: (await this.#store.intakeKey(ready.companyId, ready.id)) ?? ready.id,
        payload: { documentId: ready.id, sha256: ready.attachment.sha256, supplierGstin: readFields.supplierGstin?.value ?? null },
      });
      this.#record(ready, "purchase.inbox.draft_ready", { draftId: draft.id, command: command.id, needsReview: draft.fieldsNeedingReview, attempt: ready.attempts }, options.actor?.actorId);
      return { document: ready, draft, duplicate: false };
    });
  }

  #require(context: RequestContext): void {
    if (!context.permissions.has(INBOX_MANAGE_PERMISSION)) {
      throw new PlatformError("FORBIDDEN", "You do not have permission to manage held purchase documents. Ask the owner to give you access.");
    }
  }

  #route(input: ReceiveInput) {
    return routeDocument({
      companies: this.#companies,
      channel: input.channel,
      sender: input.sender,
      ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
      ...(input.uploader === undefined ? {} : { uploader: input.uploader }),
    });
  }

  /**
   * A redelivery already filed in a company (#406). Only the companies it could have reached are
   * asked: the one its delivery routes to, or — when the address is shared — the ones that own the
   * address and so may have claimed it. Routing is a pure function of the delivery, so this is the
   * same answer the in-memory index gave.
   */
  async #storedByMessage(input: ReceiveInput, messageKey: string): Promise<ReceiveResult | null> {
    const routing = this.#route(input);
    for (const companyId of routing.ok ? [routing.companyId] : routing.channelOwners) {
      const found = await this.#store.documentByMessageKey(companyId, messageKey);
      if (found) return this.#withDraft(found);
    }
    return null;
  }

  async #withDraft(document: InboundDocument): Promise<ReceiveResult> {
    const draft = await this.#store.draftFor(document.companyId, document.id);
    return { document, duplicate: true, ...(draft ? { draft } : {}) };
  }

  /**
   * A document in the unrouted holding, with its next state saved before anything else happens.
   * `owners` are the companies that may claim it. Null when `from` was given and the document had
   * already moved on, or when it is no longer held.
   */
  async #saveHeld(
    record: HeldRecord,
    changes: Partial<InboundDocument>,
    owners: readonly Id[],
    from?: { readonly status: "quarantined"; readonly quarantineReason: QuarantineReason },
  ): Promise<HeldRecord | null> {
    const next: HeldRecord = { ...record, document: Object.freeze({ ...record.document, ...changes }) as InboundDocument };
    const saved = await this.#holding.save(next, owners, from);
    return saved ? next : null;
  }

  /** A routed document's next step, saved in its company's unit of work. */
  #update(document: InboundDocument, changes: Partial<InboundDocument>): Promise<InboundDocument> {
    const updated = Object.freeze({ ...document, ...changes }) as InboundDocument;
    return this.#unitOfWork(updated.companyId, async () => {
      await this.#store.updateDocument(updated);
      return updated;
    });
  }

  /** `#quarantine` for a routed document. */
  #hold(document: InboundDocument, reason: QuarantineReason, message: string): Promise<InboundDocument> {
    return this.#unitOfWork(document.companyId, async () => {
      const held = await this.#update(document, { status: "quarantined", quarantineReason: reason, statusMessage: message });
      this.#record(held, "purchase.inbox.quarantined", { reason, message });
      return held;
    });
  }

  /** Audit entries are written against the owning company; unrouted ones are not leaked. */
  #record(document: InboundDocument, action: string, after: Record<string, unknown>, actorId?: Id): void {
    if (document.companyId === UNROUTED) return;
    this.#audit.append({
      companyId: document.companyId,
      actorId: actorId ?? document.sender.address,
      action,
      correlationId: document.id,
      before: { status: document.status },
      after: { ...after, fileName: document.attachment.fileName, channel: document.channel },
    });
  }
}
