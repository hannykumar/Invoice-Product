/**
 * Issue #142 — the quotation and proforma desk behind the web screen.
 *
 * Takes what the counter clerk typed, turns it into a quotation or proforma through the real
 * service, and prints it through the real rendering engine. Nothing here decides a rule: the service
 * decides what may be issued, and the renderer decides what prints.
 *
 * The buyer's address and the business's bank lines are typed on the form and kept with the document
 * as they were on the day it was sent, the way the printed page must show them. This local app has
 * no customer address book or bank setup yet, and printing made-up details is not an option.
 */
import { invalid, isoDate, money, notFound, quantityFromString, type CompanyId, type IsoDate, type PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import {
  hasLapsed,
  isPreSaleKind,
  preSaleKind,
  type ConversionResult,
  type PreSaleDocument,
  type PreSaleInput,
  type PreSaleKind,
  type PreSaleService,
} from '@invoice/sales';
import {
  captureSnapshot,
  renderPreSale,
  templateById,
  toPreSalePrint,
  type RenderableParty,
  type TemplateSnapshot,
} from '@invoice/invoice-templates';
import { STATE_NAMES } from '@invoice/transport';

const jsonAmount = (minor: bigint): number => Number(minor) / 100;

/** Rupees as typed, "1,250.50" included. */
const paise = (value: unknown): bigint => {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw invalid('API_AMOUNT', `"${text}" is not an amount in rupees and paise.`);
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const linesOf = (value: unknown): string[] => String(value ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
const optionalText = (value: unknown): string | null => String(value ?? '').trim() || null;
const optionalDate = (value: unknown): IsoDate | null => (String(value ?? '').trim() === '' ? null : isoDate(String(value)));

export interface PreSaleDeskConfig {
  readonly companyId: CompanyId;
  readonly name: string;
  readonly location: string;
  readonly gstin: string;
  readonly customerId: PartyId;
  readonly customerName: string;
  readonly customerGstin: string;
}

/** What is frozen onto a document when it is issued, besides the document itself. */
interface PrintFacts {
  readonly buyerAddress: readonly string[];
  readonly bankDetails: readonly string[];
  readonly snapshot: TemplateSnapshot;
}

/** The only item this local company stocks, as the demo masters hold it. */
const DEMO_ITEM = { itemId: 'SOAP', unit: 'PCS' } as const;

export class PreSaleDesk {
  readonly #config: PreSaleDeskConfig;
  readonly #service: PreSaleService;
  readonly #facts = new Map<string, PrintFacts>();

  constructor(config: PreSaleDeskConfig, service: PreSaleService) {
    this.#config = config;
    this.#service = service;
  }

  #kind(input: Record<string, unknown>): PreSaleKind {
    const kind = String(input.kind ?? '');
    if (!isPreSaleKind(kind)) throw invalid('API_PRESALE_KIND', 'Choose a quotation or a proforma invoice.');
    return kind;
  }

  #input(input: Record<string, unknown>): PreSaleInput {
    return {
      partyId: this.#config.customerId,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate(String(input.date ?? '')),
      validUntil: optionalDate(input.validUntil),
      lines: [{
        lineId: 'line-1',
        itemId: DEMO_ITEM.itemId,
        quantity: quantityFromString(String(input.quantity ?? ''), DEMO_ITEM.unit),
        unitPrice: money(paise(input.rate)),
        priceBasis: 'EXCLUSIVE',
        warehouseId: 'wh-main',
      }],
      terms: optionalText(input.terms),
      purpose: optionalText(input.purpose),
      buyerOrderNumber: optionalText(input.buyerOrderNumber),
      paymentTerms: optionalText(input.paymentTerms),
    };
  }

  async preview(actor: ActorContext, input: Record<string, unknown>) {
    const kind = this.#kind(input);
    const label = preSaleKind(kind).label['en-IN'];
    const working = await this.#service.preview(actor, kind, this.#input(input));
    if (!working.ok) {
      return {
        state: 'problems' as const,
        title: `This ${label.toLowerCase()} cannot be issued yet`,
        message: 'Everything stopping it is listed below. Nothing was saved and no number was used.',
        problems: working.problems.map((p) => ({ code: p.code, message: p.message })),
      };
    }
    const d = working.document;
    const totals = d.pricing.totals;
    return {
      state: 'preview' as const,
      kind,
      title: `${label} checked`,
      message: kind === 'QUOTATION'
        ? 'A price offer. Nothing goes into your books, your stock or GST until the customer accepts and you issue the bill.'
        : 'A request for payment before the goods go. It is not a tax invoice: nothing goes into your books, your stock or GST until you issue the tax invoice.',
      placeOfSupply: `${STATE_NAMES[d.pricing.placeOfSupplyStateCode] ?? ''} (${d.pricing.placeOfSupplyStateCode})`,
      value: jsonAmount(totals.taxableValue.minor),
      tax: jsonAmount(totals.totalTax.minor),
      total: jsonAmount(totals.invoiceValue.minor),
      validUntil: d.validUntil,
      lines: d.pricing.lines.map((l) => ({
        item: l.itemName,
        hsn: l.hsnOrSac,
        quantity: `${Number(l.quantity.scaled) / 1_000_000} ${l.quantity.unit}`,
        value: jsonAmount(l.taxableValue.minor),
        rate: l.ratePercentTimes100 === null ? null : Number(l.ratePercentTimes100) / 100,
      })),
      problems: [],
    };
  }

  async issue(actor: ActorContext, input: Record<string, unknown>) {
    const kind = this.#kind(input);
    const document = await this.#service.issue(actor, {
      kind,
      idempotencyKey: `web-presale:${String(input.reference || crypto.randomUUID())}`,
      input: this.#input(input),
    });
    if (!this.#facts.has(document.id)) {
      const template = templateById('india-standard');
      if (template === undefined) throw notFound('API_TEMPLATE', 'The India-standard design is missing.');
      this.#facts.set(document.id, {
        buyerAddress: linesOf(input.buyerAddress),
        // A price offer asks for no money, so bank lines typed on a quotation are not kept.
        bankDetails: kind === 'PROFORMA' ? linesOf(input.bankDetails) : [],
        snapshot: captureSnapshot(template, 'en-IN', document.createdAt.slice(0, 10)),
      });
    }
    const label = preSaleKind(kind).label['en-IN'];
    return { state: 'recorded' as const, title: `${label} issued`, message: `${document.number} was issued. Nothing was posted to your books.`, document: this.describe(document) };
  }

  async list(actor: ActorContext) {
    const documents = await this.#service.list(actor);
    return { documents: documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number.localeCompare(a.number)).map((d) => this.describe(d)) };
  }

  /** The document as the screen shows it in a list. */
  describe(d: PreSaleDocument) {
    const today = isoDate(new Date().toISOString().slice(0, 10));
    return {
      id: d.id,
      kind: d.kind,
      label: preSaleKind(d.kind).label,
      number: d.number,
      date: d.documentDate,
      validUntil: d.validUntil,
      lapsed: d.state === 'ISSUED' && hasLapsed(d, today),
      state: d.state,
      total: jsonAmount(d.pricing.totals.invoiceValue.minor),
      tax: jsonAmount(d.pricing.totals.totalTax.minor),
      purpose: d.purpose,
      buyerOrderNumber: d.buyerOrderNumber,
      sale: d.sale === null ? null : { invoiceId: d.sale.invoiceId },
      invoice: d.invoice === null ? null : { number: d.invoice.invoiceNumber, date: d.invoice.invoiceDate, differences: d.invoice.differences },
      cancelReason: d.cancelReason,
    };
  }

  async #require(actor: ActorContext, id: string): Promise<PreSaleDocument> {
    const document = await this.#service.get(actor, id);
    if (document === null) throw notFound('API_PRESALE_NOT_FOUND', 'We could not find that quotation or proforma.');
    return document;
  }

  #party(stateCode: string, name: string, gstin: string, addressLines: readonly string[]): RenderableParty {
    return { name, addressLines, gstin, stateCode, stateName: STATE_NAMES[stateCode] ?? stateCode };
  }

  /** The printed quotation or proforma. One copy: neither is a paper that travels with goods. */
  async print(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.#require(actor, String(input.document ?? ''));
    const facts = this.#facts.get(document.id);
    if (facts === undefined) throw notFound('API_PRESALE_PRINT_FACTS', 'This document was issued before its address was recorded, so it cannot be printed here.');
    const locale = input.locale === 'hi-IN' ? 'hi-IN' as const : 'en-IN' as const;
    const format = input.format === 'MOBILE' ? 'MOBILE' as const : 'A4' as const;
    const place = document.pricing.placeOfSupplyStateCode;
    const printable = toPreSalePrint(document, {
      seller: this.#party(this.#config.gstin.slice(0, 2), this.#config.name, this.#config.gstin, [this.#config.location]),
      buyer: this.#party(this.#config.customerGstin.slice(0, 2), this.#config.customerName, this.#config.customerGstin, facts.buyerAddress),
      placeOfSupplyStateName: STATE_NAMES[place] ?? place,
      bankDetails: facts.bankDetails.length === 0 ? null : facts.bankDetails,
    });
    return { state: 'print' as const, number: document.number, html: renderPreSale(printable, facts.snapshot, { format, locale }) };
  }

  /** Turns an accepted quotation into a draft bill. The caller checks and issues the bill as a sale. */
  async convert(actor: ActorContext, input: Record<string, unknown>): Promise<ConversionResult> {
    const date = optionalDate(input.date);
    return this.#service.convertToSale(actor, { quotationId: String(input.document ?? ''), ...(date === null ? {} : { documentDate: date }) });
  }

  async linkInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const proforma = await this.#service.linkInvoice(actor, { proformaId: String(input.document ?? ''), invoiceId: String(input.invoice ?? '') });
    const differences = proforma.invoice?.differences ?? [];
    return {
      state: 'recorded' as const,
      title: differences.length === 0 ? 'Invoice linked' : 'Invoice linked — with differences',
      message: `${proforma.number} is billed on invoice ${proforma.invoice?.invoiceNumber}.`,
      effects: differences,
      document: this.describe(proforma),
    };
  }

  async cancel(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.#service.cancel(actor, { id: String(input.document ?? ''), reason: String(input.reason ?? '') });
    return { state: 'recorded' as const, title: `${preSaleKind(document.kind).label['en-IN']} cancelled`, message: `${document.number} is cancelled. Its number stays used, so the series has no gap.`, document: this.describe(document) };
  }
}
