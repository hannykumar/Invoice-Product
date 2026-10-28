/**
 * Issue #489 — the purchase inbox (#15) in the running app: a supplier's bill arrives by upload,
 * email or WhatsApp, is read, and waits here for a person to look at it and record it.
 *
 * The service is built once for the whole process, not per company: it routes a document to a
 * company before anything reads it, so it must see every company's address (#487). It opens its own
 * short units of work (the routes that call it are `ownUnitsOfWork`), and the reading of a bill by
 * the OCR vendor never runs inside one (the bank-feed pattern, #440).
 *
 * What this file does not do: post anything. A bill leaves the inbox only through the purchase flow
 * the Purchase screen uses (`previewPurchase`: #16 checks, `recordPurchase`: #17 posts and receives
 * stock), so a bill from the inbox is checked and posted exactly like a typed one. The inbox keeps
 * the note of what was decided (`InboxDecisionStore`).
 *
 * Law applied (CGST Act, 2017): a purchase from a registered supplier is an inward supply, and the
 * credit on it is conditional on holding a tax invoice or other prescribed document (s.16(2)(a),
 * Rule 36(1)) and on the goods being received (s.16(2)(b)). The inbox therefore never decides credit:
 * the recorded bill goes on to the purchase check (#31) and the received-goods confirmation (#18).
 * Not verified here: the e-invoice requirement for the supplier's turnover (that is #26's rule).
 */
import { createHash, randomUUID } from 'node:crypto';
import { conflict, invalid, notFound } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { ConnectorError, HmacWebhookVerifier, isLocalEnvironment, type WebhookSigningSecrets } from '../../../packages/platform/src/connectors.ts';
import { registerSecretValues } from '../../../packages/platform/src/credentials.ts';
import { AuditLog, PlatformCommandService } from '../../../packages/platform/src/platform.ts';
import type { Permission, RequestContext } from '../../../packages/platform/src/types.ts';
import { pageFromLines } from '../../../packages/purchasing/src/ocr.ts';
import { PurchaseInboxService, REVIEW_CONFIDENCE, type ReceiveResult } from '../../../packages/purchasing/src/inbox.ts';
import { InMemoryInboxStore } from '../../../packages/purchasing/src/inbox-store.ts';
import { PostgresInboxStore } from '../../../packages/purchasing/src/inbox-postgres.ts';
import { PostgresInboxHolding } from '../../../packages/purchasing/src/inbox-holding-postgres.ts';
import { InMemoryInboxDecisionStore, PostgresInboxDecisionStore, type InboxDecision, type InboxDecisionStore } from '../../../packages/purchasing/src/inbox-decisions.ts';
import { formatPaise } from '../../../packages/purchasing/src/money.ts';
import type { CompanyRoutingProfile } from '../../../packages/purchasing/src/routing.ts';
import type { ExtractedField, ExtractionDraft, InboundDocument, IntakeChannel } from '../../../packages/purchasing/src/inbox-types.ts';
import { SYNTHETIC_PLATFORM_COMPANIES } from '../../../packages/platform/src/seed.ts';
import { appClock } from './app-clock.ts';
import type { ApiRuntime } from './runtime.ts';
import { MAX_STORED_FILE_BYTES, availableBill, malwareScanner, objectStore, putObject } from './files-application.ts';
import { DevelopmentOcr, inboxOcr, sampleBillLines, sampleBillPdf } from './inbox-ocr.ts';
import { billingAddressOf, items as itemsOf, suppliers as suppliersOf } from './catalogue-application.ts';

// ------------------------------------------------------------------ where bills are delivered

/**
 * The addresses a company's suppliers can send bills to. Invented, and unable to receive mail or
 * messages (`.invalid`; 90000 numbers are not allocated). A real company's alias and WhatsApp
 * number are set up with the provider (#51); until then these stand in for them.
 */
const DELIVERY: Readonly<Record<string, { readonly email: string; readonly whatsapp: string }>> = {
  '00000000-0000-4000-8000-000000000001': { email: 'bills-sampoorna@inbox.example.invalid', whatsapp: '+91 90000 00001' },
  '00000000-0000-4000-8000-000000000011': { email: 'bills-konkan@inbox.example.invalid', whatsapp: '+91 90000 00011' },
};

/** Where a delivered file waits before its company is known: a namespace of its own, belonging to no company. */
const HOLDING = '00000000-0000-4000-8000-000000000000';

export type WebhookChannel = 'email' | 'whatsapp';
export const isWebhookChannel = (value: string): value is WebhookChannel => value === 'email' || value === 'whatsapp';

/** Publicly known, so used only where nothing real can arrive: development and tests. */
export const DEVELOPMENT_INBOX_WEBHOOK_SECRET = 'karobar-development-inbox-webhook-secret';
const secretVariable = (channel: WebhookChannel): string => `PURCHASE_INBOX_WEBHOOK_SECRET_${channel.toUpperCase()}`;

/** Each channel's signing secrets, read at each delivery. A channel with none refuses every delivery. */
export const inboxWebhookSecrets = (env: NodeJS.ProcessEnv = process.env): WebhookSigningSecrets => ({
  async webhookSecrets(kind) {
    if (kind !== 'email' && kind !== 'whatsapp') return [];
    const configured = (env[secretVariable(kind)] ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
    registerSecretValues(configured);
    return configured.length > 0 ? configured : isLocalEnvironment(env.NODE_ENV) ? [DEVELOPMENT_INBOX_WEBHOOK_SECRET] : [];
  },
});

// ------------------------------------------------------------------ what the screen is told

const CHANNEL_WORDS: Readonly<Record<IntakeChannel, string>> = {
  manual_upload: 'Uploaded here', camera: 'Photo taken here', email: 'Emailed', whatsapp: 'WhatsApp', einvoice_json: 'e-invoice file', api: 'Sent by another program',
};

/** What a shopkeeper sees a document as. One word, then a sentence saying what to do. */
export type InboxState = 'ready' | 'reading' | 'held' | 'failed' | 'duplicate' | 'billed' | 'rejected';

const FIELD_LABELS: Readonly<Record<string, string>> = {
  supplierName: 'Supplier', supplierGstin: 'Supplier’s GST number', buyerGstin: 'Your GST number on the bill', invoiceNumber: 'Bill number',
  invoiceDate: 'Bill date', taxableValuePaise: 'Value before GST', totalTaxPaise: 'GST on the bill', invoiceTotalPaise: 'Bill total', irn: 'e-invoice number (IRN)',
};

const confidenceWords = (confidence: number): { readonly level: 'clear' | 'check' | 'unclear'; readonly words: string } =>
  confidence >= REVIEW_CONFIDENCE ? { level: 'clear', words: 'Read clearly' }
    : confidence >= 0.4 ? { level: 'check', words: 'Please check this one' }
      : { level: 'unclear', words: 'Hard to read — please check it against the bill' };

const displayOf = (value: unknown): string => (typeof value === 'bigint' ? formatPaise(value) : String(value));

const fieldView = (key: string, field: ExtractedField<unknown> | undefined, needsReview: ReadonlySet<string>) => {
  if (field === undefined) return null;
  return {
    key, label: FIELD_LABELS[key] ?? key, display: displayOf(field.value),
    // The value as the form takes it: rupees as text, never a float.
    value: typeof field.value === 'bigint' ? `${field.value / 100n}.${String(field.value % 100n).padStart(2, '0')}` : String(field.value),
    confidence: Number(field.confidence.toFixed(2)), ...confidenceWords(field.confidence),
    needsCheck: needsReview.has(key) || field.confidence < REVIEW_CONFIDENCE,
    evidence: { text: field.evidence.text, page: field.evidence.page, ...(field.evidence.jsonPath === undefined ? {} : { jsonPath: field.evidence.jsonPath }) },
    ...(field.warning === undefined ? {} : { warning: field.warning }),
  };
};

const rupees = (paise: bigint): string => `${paise / 100n}.${String(paise % 100n).padStart(2, '0')}`;

const lineView = (line: ExtractionDraft['lines'][number], index: number, needsReview: ReadonlySet<string>) => {
  const pick = <T,>(field: ExtractedField<T> | undefined) => field === undefined ? null : { value: field.value, confidence: Number(field.confidence.toFixed(2)), evidence: field.evidence.text, ...confidenceWords(field.confidence) };
  const rate = line.ratePaise;
  return {
    number: index + 1,
    description: pick(line.description), hsnSac: pick(line.hsnSac), unit: pick(line.unit),
    quantity: pick(line.quantity),
    rate: rate === undefined ? null : { ...pick(rate)!, value: rupees(rate.value), display: formatPaise(rate.value) },
    taxableValue: line.taxableValuePaise === undefined ? null : { ...pick(line.taxableValuePaise)!, display: formatPaise(line.taxableValuePaise.value) },
    gstRateBasisPoints: line.gstRateBasisPoints === undefined ? null : pick(line.gstRateBasisPoints),
    needsCheck: [line.description, line.hsnSac, line.quantity, line.ratePaise, line.taxableValuePaise, line.gstRateBasisPoints].some((field) => field !== undefined && field.confidence < REVIEW_CONFIDENCE) || needsReview.has(`lines.${index}`),
  };
};

const stateOf = (document: InboundDocument, decision: InboxDecision | undefined): { state: InboxState; next: string } => {
  if (decision?.kind === 'billed') return { state: 'billed', next: `Recorded as bill ${decision.billNumber}. Nothing more to do here.` };
  if (decision?.kind === 'rejected') return { state: 'rejected', next: `Set aside: ${decision.reason}` };
  switch (document.status) {
    case 'draft_ready': return { state: 'ready', next: 'Check what was read against the bill, then record it.' };
    case 'discarded': return { state: 'duplicate', next: 'Nothing to do. You already have this one.' };
    case 'failed': return { state: 'failed', next: 'The reading service did not answer. Try again in a moment.' };
    case 'quarantined': return {
      state: 'held',
      next: document.quarantineReason === 'COMPANY_NOT_IDENTIFIED' || document.quarantineReason === 'COMPANY_MISMATCH'
        ? 'Say whether this bill is for your business. Until you do, it stays here and is not read.'
        : document.quarantineReason === 'AWAITING_SCAN' ? 'This is being checked for viruses. It will move on by itself once the check is done.'
          : 'This was held back. Ask the supplier to send it again, clearer or in another form.',
    };
    default: return { state: 'reading', next: 'Being read now. This page updates by itself.' };
  }
};

const summaryOf = (document: InboundDocument, decision: InboxDecision | undefined, draft?: ExtractionDraft, sameBillAs?: { id: string; fileName: string }) => {
  const { state, next } = stateOf(document, decision);
  return {
    id: document.id, fileName: document.attachment.fileName, sizeBytes: document.attachment.sizeBytes, channel: document.channel,
    channelWords: CHANNEL_WORDS[document.channel], receivedAt: document.receivedAt, state, next,
    message: document.statusMessage ?? '',
    ...(document.quarantineReason === undefined ? {} : { holdReason: document.quarantineReason }),
    ...(document.duplicateOfId === undefined ? {} : { duplicateOfId: document.duplicateOfId }),
    ...(draft === undefined ? {} : {
      supplier: draft.supplierName?.value ?? null, billNumber: draft.invoiceNumber?.value ?? null,
      total: draft.invoiceTotalPaise === undefined ? null : formatPaise(draft.invoiceTotalPaise.value),
      checks: draft.fieldsNeedingReview.length + draft.arithmeticProblems.length,
    }),
    ...(sameBillAs === undefined ? {} : { sameBillAs }),
    ...(decision === undefined ? {} : { decision: { kind: decision.kind, ...(decision.billNumber === undefined ? {} : { billNumber: decision.billNumber }), ...(decision.reason === undefined ? {} : { reason: decision.reason }), at: decision.decidedAt } }),
    actions: {
      review: state === 'ready',
      retry: state === 'failed',
      assign: state === 'held' && (document.quarantineReason === 'COMPANY_NOT_IDENTIFIED' || document.quarantineReason === 'COMPANY_MISMATCH'),
      reject: state === 'ready' || state === 'held' || state === 'failed',
    },
  };
};

// ------------------------------------------------------------------ the application

const normalise = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class PurchaseInboxApplication {
  readonly #runtime: ApiRuntime;
  readonly service: PurchaseInboxService;
  readonly #decisions: InboxDecisionStore;
  readonly #ocr: ReturnType<typeof inboxOcr>;
  readonly #verifier: HmacWebhookVerifier;
  /** Development and tests: the made-up bills are in the inbox before anyone looks. */
  readonly ready: Promise<void>;

  constructor(runtime: ApiRuntime) {
    this.#runtime = runtime;
    const db = runtime.database;
    const audit = new AuditLog();
    this.#ocr = inboxOcr();
    this.#decisions = db === null ? new InMemoryInboxDecisionStore() : new PostgresInboxDecisionStore(db);
    const companies: CompanyRoutingProfile[] = SYNTHETIC_PLATFORM_COMPANIES.map((company) => ({
      companyId: company.companyId, legalName: company.legalName, gstins: [runtime.companyIdentity(company.companyId).gstin],
      emailAliases: [DELIVERY[company.companyId]!.email], whatsappNumbers: [DELIVERY[company.companyId]!.whatsapp],
    }));
    this.service = new PurchaseInboxService(new PlatformCommandService(audit, []), audit, this.#ocr, companies, {
      store: db === null ? new InMemoryInboxStore() : new PostgresInboxStore(db),
      // #488 — documents whose company is not known yet are kept in PostgreSQL (in memory without it), and their file is
      // read back from private storage rather than held in memory, so a restart loses neither.
      ...(db === null ? {} : { holding: new PostgresInboxHolding(db) }),
      readBytes: async (key: string) => (await objectStore().read(key, MAX_STORED_FILE_BYTES).catch(() => null))?.bytes ?? null,
      ...(db === null ? {} : { unitOfWork: <T,>(companyId: string, work: () => Promise<T>) => db.unitOfWork(companyId, () => work()) }),
    });
    this.#verifier = new HmacWebhookVerifier(inboxWebhookSecrets(), () => appClock.now());
    // The made-up bills are for a developer's machine: a database never receives them.
    this.ready = db === null && this.#ocr instanceof DevelopmentOcr ? this.#seed(this.#ocr) : Promise.resolve();
  }

  // ---------------------------------------------------------------------------- reading

  /** Where this company's suppliers can send bills, for the screen's "send your bills to" panel. */
  deliveryOf(companyId: string): { readonly email: string; readonly whatsapp: string } | null {
    return DELIVERY[companyId] ?? null;
  }

  async list(context: RequestContext) {
    await this.ready;
    const documents = [...await this.service.inbox(context)].reverse();
    const decisions = await this.#decisions.forDocuments(context.companyId, documents.map((document) => document.id));
    // The same bill arriving as a photo and as a PDF is two files but one bill: the second says so.
    const drafts = new Map<string, ExtractionDraft>();
    for (const document of documents) {
      if (document.status !== 'draft_ready') continue;
      const draft = await this.service.draft(context, document.id).catch(() => null);
      if (draft !== null) drafts.set(document.id, draft);
    }
    const firstSeen = new Map<string, { id: string; fileName: string }>();
    const sameBill = new Map<string, { id: string; fileName: string }>();
    for (const document of [...documents].reverse()) {
      const draft = drafts.get(document.id);
      const key = draft === undefined ? null : this.service.logicalKey(draft);
      if (key === null) continue;
      const text = JSON.stringify(key);
      const earlier = firstSeen.get(text);
      if (earlier === undefined) firstSeen.set(text, { id: document.id, fileName: document.attachment.fileName });
      else sameBill.set(document.id, earlier);
    }
    const items = documents.map((document) => summaryOf(document, decisions.get(document.id), drafts.get(document.id), sameBill.get(document.id)));
    const waiting = (await this.service.awaitingAssignment(context)).map((held) => ({
      id: held.id, fileName: held.fileName, sizeBytes: held.sizeBytes, channel: held.channel, channelWords: CHANNEL_WORDS[held.channel], receivedAt: held.receivedAt,
      state: 'held' as const, next: 'This arrived on an address your business shares. Say whether it is yours.', message: 'Nothing has been read from it yet.',
      actions: { review: false, retry: false, assign: true, reject: false },
    }));
    return {
      items: [...waiting, ...items],
      counts: {
        ready: items.filter((item) => item.state === 'ready').length,
        held: items.filter((item) => item.state === 'held').length + waiting.length,
        failed: items.filter((item) => item.state === 'failed').length,
      },
      deliverTo: this.deliveryOf(context.companyId),
    };
  }

  async detail(context: RequestContext, id: string) {
    await this.ready;
    const document = await this.service.document(context, id);
    const decision = (await this.#decisions.forDocuments(context.companyId, [id])).get(id);
    const draft = document.status === 'draft_ready' ? await this.service.draft(context, id).catch(() => null) : null;
    const summary = summaryOf(document, decision, draft ?? undefined);
    if (draft === null) return { document: summary, draft: null };
    const needs = new Set(draft.fieldsNeedingReview);
    const fields = (['supplierName', 'supplierGstin', 'buyerGstin', 'invoiceNumber', 'invoiceDate', 'taxableValuePaise', 'totalTaxPaise', 'invoiceTotalPaise', 'irn'] as const)
      .map((key) => fieldView(key, draft[key] as ExtractedField<unknown> | undefined, needs)).filter((field) => field !== null);
    // Essential figures the reader could not find at all: said plainly, so the person types them from the bill.
    const notFound = draft.fieldsNeedingReview.filter((name) => name.endsWith(' (not found)')).map((name) => name.slice(0, -' (not found)'.length)).map((key) => ({ key, label: FIELD_LABELS[key] ?? key }));
    const lines = draft.lines.map((line, index) => lineView(line, index, needs));
    const suggestion = this.#suggest(context.companyId, draft);
    return {
      document: summary,
      draft: {
        source: draft.source, ...(draft.signature === undefined ? {} : { signature: draft.signature }),
        fields, notFound, lines,
        // Sums that do not add up, in the reader's words; they are reported, never fixed.
        problems: draft.arithmeticProblems,
        // The form the person corrects and records: every value starts as what was read.
        form: {
          supplierId: suggestion.supplier?.id ?? '', reference: draft.invoiceNumber?.value ?? '', date: draft.invoiceDate?.value ?? '',
          lines: lines.map((line, index) => ({
            itemId: suggestion.items[index]?.id ?? '', description: String(line.description?.value ?? ''),
            quantity: String(line.quantity?.value ?? ''), rate: line.rate?.value ?? '', gst: line.gstRateBasisPoints === null ? '' : String(line.gstRateBasisPoints.value),
          })),
        },
        suggestions: { supplier: suggestion.supplier, items: suggestion.items },
      },
    };
  }

  /** Suggestions only: the supplier whose saved GST number is the one printed, and an item per line by name. The person confirms. */
  #suggest(companyId: string, draft: ExtractionDraft) {
    const printed = draft.supplierGstin?.value === undefined ? '' : normalise(draft.supplierGstin.value);
    const supplier = printed === '' ? undefined : suppliersOf(companyId).find((party) => normalise(billingAddressOf(companyId, party.id)?.gstin ?? '') === printed);
    const known = itemsOf(companyId).filter((item) => item.active);
    const items = draft.lines.map((line) => {
      const words = normalise(String(line.description.value));
      const hsn = line.hsnSac?.value === undefined ? '' : normalise(String(line.hsnSac.value));
      const match = known.find((item) => normalise(item.name) !== '' && (words.includes(normalise(item.name)) || normalise(item.name).includes(words)))
        ?? (hsn === '' ? undefined : known.find((item) => normalise(item.hsnSac) === hsn));
      return match === undefined ? null : { id: match.id, name: match.name };
    });
    return { supplier: supplier === undefined ? null : { id: supplier.id, name: supplier.legalName }, items };
  }

  // ---------------------------------------------------------------------------- receiving

  async #receive(context: RequestContext | null, input: {
    readonly channel: IntakeChannel; readonly address: string; readonly displayName?: string; readonly providerMessageId: string;
    readonly fileName: string; readonly mimeType: string; readonly bytes: Uint8Array; readonly storageKey: string; readonly deliveredTo?: string;
  }): Promise<ReceiveResult> {
    await this.ready;
    const scan = await malwareScanner().scan(input.bytes);
    return this.service.receive({
      channel: input.channel,
      sender: { channel: input.channel, address: input.address, ...(input.displayName === undefined ? {} : { displayName: input.displayName }), providerMessageId: input.providerMessageId },
      attachment: { id: randomUUID(), fileName: input.fileName, declaredMimeType: input.mimeType, sizeBytes: input.bytes.length, sha256: '', storageKey: input.storageKey },
      bytes: input.bytes, scanVerdict: scan,
      ...(context === null ? {} : { uploader: context }),
      ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
      idempotencyKey: `${input.channel}:${input.providerMessageId}`,
    });
  }

  /**
   * An upload from the signed-in shop: a stored, screened bill (`fileId`, #341) or an e-invoice file
   * pasted as text. The company is the session's, whatever else the request says (rule 6).
   */
  async upload(context: RequestContext, actor: ActorContext, input: Record<string, unknown>, db: ApiRuntime['database']) {
    const fileId = String(input.fileId ?? '').trim();
    const json = typeof input.einvoiceJson === 'string' ? input.einvoiceJson : '';
    if ((fileId === '') === (json.trim() === '')) throw invalid('INBOX_UPLOAD_WHAT', 'Choose the bill to add: a photo or a PDF, or an e-invoice file.');
    const source: IntakeChannel = input.source === 'camera' ? 'camera' : 'manual_upload';
    let result: ReceiveResult;
    if (fileId !== '') {
      const { file, bytes } = await availableBill(db, actor, fileId);
      result = await this.#receive(context, {
        channel: source, address: context.actorId, providerMessageId: file.id, fileName: file.fileName, mimeType: file.declaredType, bytes, storageKey: file.objectKey,
      });
    } else {
      const bytes = new TextEncoder().encode(json);
      const fileName = String(input.fileName ?? '').trim() || 'e-invoice.json';
      // A resend of the same file text is the same delivery; the file itself is the key.
      const sha = createHash('sha256').update(bytes).digest('hex');
      // Kept in private storage like any other file, so a document held for the virus check can be read again later.
      const storageKey = `${context.companyId}/inbox_json/${sha.slice(0, 8)}-${sha.slice(8, 12)}-${sha.slice(12, 16)}-${sha.slice(16, 20)}-${sha.slice(20, 32)}`;
      await putObject(storageKey, bytes, 'application/json');
      result = await this.#receive(context, {
        channel: 'einvoice_json', address: context.actorId, providerMessageId: `json:${sha}`, fileName, mimeType: 'application/json', bytes, storageKey,
      });
    }
    return this.#received(context, result);
  }

  async #received(context: RequestContext, result: ReceiveResult) {
    const decision = (await this.#decisions.forDocuments(context.companyId, [result.document.id])).get(result.document.id);
    const summary = summaryOf(result.document, decision);
    const title = result.duplicate ? 'You already have this one'
      : summary.state === 'ready' ? 'Bill added to your inbox'
        : summary.state === 'held' ? 'Bill held back' : summary.state === 'failed' ? 'Bill added, but not read yet' : 'Bill added';
    return { state: 'recorded' as const, title, message: summary.message || summary.next, duplicate: result.duplicate, document: summary };
  }

  /**
   * A signed delivery from the email or WhatsApp provider's adapter. No session: the signature over
   * the raw bytes is the proof, and the company comes from the address it was delivered to, which
   * the provider's delivery record names, never from anything the sender wrote.
   *
   * The payload is the adapter's normal form (connector-v1 `ConnectorWebhook.payload`):
   * `{ providerMessageId, from, displayName?, deliveredTo, fileName, mimeType, contentBase64 }`.
   */
  async receiveDelivery(channel: WebhookChannel, rawBody: string, signature: string) {
    const webhook = await this.#verifier.verify(channel, rawBody, signature);
    const payload = webhook.payload;
    const text = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string).trim() : '');
    const content = text('contentBase64');
    if (text('deliveredTo') === '' || text('fileName') === '' || content === '' || !/^[A-Za-z0-9+/=\r\n]+$/.test(content)) throw new ConnectorError('INVALID_REQUEST', false);
    const bytes = new Uint8Array(Buffer.from(content, 'base64'));
    if (bytes.length === 0) throw new ConnectorError('INVALID_REQUEST', false);
    const sha = createHash('sha256').update(bytes).digest('hex');
    // The company is not known until the inbox has routed it, so the file waits under a holding prefix, named by its own hash.
    const storageKey = `${HOLDING}/inbox_delivery/${sha.slice(0, 8)}-${sha.slice(8, 12)}-${sha.slice(12, 16)}-${sha.slice(16, 20)}-${sha.slice(20, 32)}`;
    await putObject(storageKey, bytes, text('mimeType') || 'application/octet-stream');
    const result = await this.#receive(null, {
      channel, address: text('from') || 'unknown', ...(text('displayName') === '' ? {} : { displayName: text('displayName') }),
      providerMessageId: text('providerMessageId') || webhook.eventId, fileName: text('fileName').slice(0, 200), mimeType: text('mimeType') || 'application/octet-stream',
      bytes, storageKey, deliveredTo: text('deliveredTo'),
    });
    // Only that it arrived: the provider is told nothing about which company, or what the file said.
    return { received: true, duplicate: result.duplicate };
  }

  // ---------------------------------------------------------------------------- deciding

  async retry(context: RequestContext, id: string) {
    await this.ready;
    return this.#received(context, await this.service.retry(context, id));
  }

  async assign(context: RequestContext, id: string, reason: string) {
    await this.ready;
    await this.service.assignCompany(context, id, reason);
    // Reading an assigned document is not built into the service: it is received again so that it is.
    const document = await this.service.document(context, id);
    return { state: 'recorded' as const, title: 'Added to your business', message: 'This bill is now yours. Ask the sender to send it again so it can be read.', document: summaryOf(document, undefined) };
  }

  async reject(context: RequestContext, id: string, reason: string, db: ApiRuntime['database']) {
    await this.ready;
    // Looked up first: another company's document is "not found" whatever else is wrong with the request.
    const document = await this.service.document(context, id);
    const why = reason.trim();
    if (why === '') throw invalid('INBOX_REJECT_REASON', 'Say why this bill is being set aside, so the next person knows.');
    const record = async () => this.#decisions.record({ companyId: context.companyId, documentId: id, kind: 'rejected', reason: why, decidedBy: context.actorId, decidedAt: new Date().toISOString() });
    const decision = db === null ? await record() : await db.unitOfWork(context.companyId, record);
    return { state: 'recorded' as const, title: 'Bill set aside', message: 'It stays in the inbox, marked as set aside, so the record is kept.', document: summaryOf(document, decision) };
  }

  /** The note that a document became a bill. Runs inside the recording request's own unit of work. */
  async markBilled(context: RequestContext, id: string, bill: { readonly billNumber: string; readonly supplierName: string }) {
    return this.#decisions.record({
      companyId: context.companyId, documentId: id, kind: 'billed', billNumber: bill.billNumber, supplierName: bill.supplierName,
      decidedBy: context.actorId, decidedAt: new Date().toISOString(),
    });
  }

  /** A document that can still become a bill: read, and neither billed nor set aside. Another company's is "not found". */
  async requireBillable(context: RequestContext, id: string): Promise<ExtractionDraft> {
    await this.ready;
    const document = await this.service.document(context, id);
    const decision = (await this.#decisions.forDocuments(context.companyId, [id])).get(id);
    if (decision?.kind === 'billed') throw conflict('INBOX_ALREADY_BILLED', `This was already recorded as bill ${decision.billNumber}. Nothing more needs doing.`);
    if (decision?.kind === 'rejected') throw conflict('INBOX_SET_ASIDE', 'This bill was set aside, so it cannot be recorded.');
    if (document.status !== 'draft_ready') throw conflict('INBOX_NOT_READY', 'This bill has not been read yet, so there is nothing to record. Open it again in a moment.');
    return this.service.draft(context, id);
  }

  /** What the person changed from what was read, in their words: shown after the bill is recorded. */
  corrections(draft: ExtractionDraft, form: { readonly reference?: unknown; readonly date?: unknown }): readonly string[] {
    const changes: string[] = [];
    const bill = String(form.reference ?? '').trim();
    if (draft.invoiceNumber !== undefined && bill !== '' && bill !== draft.invoiceNumber.value) changes.push(`Bill number: read as ${draft.invoiceNumber.value}, recorded as ${bill}.`);
    const date = String(form.date ?? '').trim();
    if (draft.invoiceDate !== undefined && date !== '' && date !== draft.invoiceDate.value) changes.push(`Bill date: read as ${draft.invoiceDate.value}, recorded as ${date}.`);
    return changes;
  }

  notFound(): never { throw notFound('INBOX_DOCUMENT_UNKNOWN', 'That document was not found.'); }

  // ---------------------------------------------------------------------------- development

  /**
   * Four made-up bills per demo company, through the same pipeline a real one takes, so a developer
   * opening the screen sees every state: ready, ready with a doubtful figure, a duplicate, and one
   * held for being unreadable. In memory only; a database never receives them.
   */
  async #seed(ocr: DevelopmentOcr): Promise<void> {
    for (const company of SYNTHETIC_PLATFORM_COMPANIES) {
      const identity = this.#runtime.companyIdentity(company.companyId);
      const context: RequestContext = { companyId: company.companyId, branchId: company.branchId, actorId: company.userId, sessionId: `inbox-seed:${company.companyId}`, permissions: new Set<Permission>(['purchase.inbox.manage']) };
      const delivery = DELIVERY[company.companyId]!;
      const supplierGstin = '27AAECS5678D1Z4';
      const bill = (number: string, date: string, total = '37,760.00') => sampleBillLines({
        supplierName: 'Shree Ram Steels Private Limited', supplierGstin, buyerGstin: identity.gstin, number, date,
        item: 'TMT Steel Bar 12mm', hsn: '72142090', quantity: '500', unit: 'KGS', rate: '64.00', taxable: '32,000.00', igst: '5,760.00', total,
      });
      const send = async (channel: IntakeChannel, id: string, fileName: string, bytes: Uint8Array, mime: string, extra: { readonly deliveredTo?: string; readonly uploader?: boolean } = {}) => {
        const sha = createHash('sha256').update(bytes).digest('hex');
        const storageKey = `${company.companyId}/inbox_seed/${sha}`;
        return this.service.receive({
          channel, sender: { channel, address: channel === 'email' ? 'accounts@shreeram.example.invalid' : channel === 'whatsapp' ? '+919000000999' : company.userId, providerMessageId: id },
          attachment: { id: randomUUID(), fileName, declaredMimeType: mime, sizeBytes: bytes.length, sha256: '', storageKey },
          bytes, scanVerdict: 'clean', idempotencyKey: `seed:${company.companyId}:${id}`,
          ...(extra.deliveredTo === undefined ? {} : { deliveredTo: extra.deliveredTo }), ...(extra.uploader === true ? { uploader: context } : {}),
        });
      };
      const first = sampleBillPdf(bill('SRS/2026/1001', '21/09/2026'), `${company.companyId}-1`);
      ocr.set(`${company.companyId}/inbox_seed/${createHash('sha256').update(first).digest('hex')}`, [pageFromLines(1, bill('SRS/2026/1001', '21/09/2026'))]);
      await send('whatsapp', 'wamid.seed.1', 'Shree Ram Steels bill 1001.pdf', first, 'application/pdf', { deliveredTo: delivery.whatsapp });
      // The same file emailed as well: recognised as the one already here.
      await send('email', 'mail.seed.1', 'Shree Ram Steels bill 1001.pdf', first, 'application/pdf', { deliveredTo: delivery.email });
      // A bill whose total and date were printed faintly: read, but with figures to check.
      const faint = sampleBillPdf(bill('SRS/2026/1002', '04/10/2026', '37,760.00'), `${company.companyId}-2`);
      ocr.set(`${company.companyId}/inbox_seed/${createHash('sha256').update(faint).digest('hex')}`, [pageFromLines(1, bill('SRS/2026/1002', '04/10/2026').map((line) => line.startsWith('Grand Total') || line.startsWith('Invoice Date') ? { text: line, confidence: 0.62 } : line))]);
      await send('manual_upload', 'upload.seed.2', 'bill-photo-1002.pdf', faint, 'application/pdf', { uploader: true });
      // A photo too blurred to read.
      const blurred = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
      ocr.set(`${company.companyId}/inbox_seed/${createHash('sha256').update(blurred).digest('hex')}`, [pageFromLines(1, [{ text: 'TAX INVOICE', confidence: 0.3 }, { text: 'Total 100.00', confidence: 0.22 }])]);
      await send('camera', 'camera.seed.3', 'photo-of-bill.jpg', blurred, 'image/jpeg', { uploader: true });
    }
  }
}

let instance: { readonly runtime: ApiRuntime; readonly application: PurchaseInboxApplication } | undefined;
/** The one inbox this process keeps (rebuilt only if the runtime was replaced, as tests do). */
export const purchaseInbox = (runtime: ApiRuntime): PurchaseInboxApplication => {
  if (instance === undefined || instance.runtime !== runtime) instance = { runtime, application: new PurchaseInboxApplication(runtime) };
  return instance.application;
};
