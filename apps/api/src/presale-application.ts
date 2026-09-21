/**
 * Issue #142 — the quotation and proforma desk behind the web screen.
 *
 * Takes what the counter clerk typed, turns it into a quotation or proforma through the real
 * service, and prints it through the real rendering engine. Nothing here decides a rule: the service
 * decides what may be issued, and the renderer decides what prints.
 *
 * Issue #181 — the buyer and the item are the ones that were chosen, taken from the same customer
 * and item lists the Sale screen uses, and nothing else about these two documents changed: the
 * standing instruction is that the quotation and the proforma are kept working, not developed.
 */
import { formatINR, invalid, isoDate, money, mulDiv, notFound, quantityFromString, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import { GOODS_ADVANCE_NO_TAX, unusedOf, type AdvanceReceipt, type AdvanceService, type PaymentMode, type TaxHeads } from '@invoice/receivables';
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
  escapeHtml,
  renderPreSale,
  templateById,
  toPreSalePrint,
  type RenderableParty,
  type TemplateSnapshot,
} from '@invoice/invoice-templates';
import { STATE_NAMES } from '@invoice/transport';
import { requireIssuable, sellerPrint } from './business-details-application.ts';
import { customerPrint, resolveCustomer, resolveItem } from './catalogue-application.ts';

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
}

/** What is frozen onto a document when it is issued, besides the document itself. */
interface PrintFacts {
  readonly buyer: RenderableParty;
  readonly bankDetails: readonly string[];
  readonly snapshot: TemplateSnapshot;
}

export class PreSaleDesk {
  readonly #config: PreSaleDeskConfig;
  readonly #service: PreSaleService;
  readonly #facts = new Map<string, PrintFacts>();
  readonly #advances: AdvanceService;

  constructor(config: PreSaleDeskConfig, service: PreSaleService, advances: AdvanceService) {
    this.#config = config;
    this.#service = service;
    this.#advances = advances;
  }

  #kind(input: Record<string, unknown>): PreSaleKind {
    const kind = String(input.kind ?? '');
    if (!isPreSaleKind(kind)) throw invalid('API_PRESALE_KIND', 'Choose a quotation or a proforma invoice.');
    return kind;
  }

  #buyer(input: Record<string, unknown>) {
    return resolveCustomer(this.#config.companyId, String(input.customerId ?? input.customer ?? input.party ?? ''));
  }

  #input(input: Record<string, unknown>): PreSaleInput {
    const buyer = this.#buyer(input);
    const item = resolveItem(this.#config.companyId, String(input.itemId ?? input.item ?? ''));
    return {
      partyId: buyer.id as PartyId,
      customerType: buyer.gstRegistrationType === 'unregistered' ? 'B2C' : 'B2B',
      // Issue #165 — a service is taxed on its advance and goods are not, so this must be the item's own.
      supplyKind: item.kind === 'service' ? 'SERVICES' : 'GOODS',
      documentDate: isoDate(String(input.date ?? '')),
      validUntil: optionalDate(input.validUntil),
      lines: [{
        lineId: 'line-1',
        itemId: item.id,
        quantity: quantityFromString(String(input.quantity ?? ''), String(input.unit ?? '').trim().toUpperCase() || item.baseUnit),
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
    // Issue #180 — checked first, so a quotation number is never spent on a refusal.
    requireIssuable(this.#config.companyId);
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
        buyer: customerPrint(this.#config.companyId, this.#buyer(input).id),
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

  /** The printed quotation or proforma. One copy: neither is a paper that travels with goods. */
  async print(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.#require(actor, String(input.document ?? ''));
    const facts = this.#facts.get(document.id);
    if (facts === undefined) throw notFound('API_PRESALE_PRINT_FACTS', 'This document was issued before its address was recorded, so it cannot be printed here.');
    const locale = input.locale === 'hi-IN' ? 'hi-IN' as const : 'en-IN' as const;
    const format = input.format === 'MOBILE' ? 'MOBILE' as const : 'A4' as const;
    const place = document.pricing.placeOfSupplyStateCode;
    const printable = toPreSalePrint(document, {
      // Issue #180 — the same seller block the tax invoice carries, from the one saved source.
      seller: sellerPrint(this.#config.companyId, { name: this.#config.name, gstin: this.#config.gstin }).seller,
      buyer: facts.buyer,
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
    // Issue #165 — what happened to money already taken against the proforma.
    const applied = (await this.#advances.forProforma(actor, proforma.id)).flatMap((a) => a.application === null ? [] : [
      `${formatINR(a.application.amount)} of advance ${a.number} applied to the invoice.${total(a.application.taxSetOff).minor === 0n ? '' : ` GST of ${formatINR(total(a.application.taxSetOff))} already paid on it was set off, so it is not paid twice.`}${unusedOf(a).minor === 0n ? '' : ` ${formatINR(unusedOf(a))} is left over; pay it back with a refund voucher.`}`,
    ]);
    return {
      state: 'recorded' as const,
      title: differences.length === 0 ? 'Invoice linked' : 'Invoice linked — with differences',
      message: `${proforma.number} is billed on invoice ${proforma.invoice?.invoiceNumber}.`,
      effects: [...applied, ...differences],
      document: this.describe(proforma),
    };
  }

  // ------------------------------------------------------ issue #165: money received against a proforma

  async advances(actor: ActorContext, input: Record<string, unknown>) {
    const list = await this.#advances.forProforma(actor, String(input.document ?? ''));
    return { advances: list.map((a) => advanceView(a)) };
  }

  #money(input: Record<string, unknown>): { mode: PaymentMode; bankAccountCode: string | null } {
    // The demo business has one bank account; money that did not come in cash went into it.
    const mode = String(input.mode ?? 'CASH');
    if (mode === 'CASH') return { mode: 'CASH', bankAccountCode: null };
    if (mode === 'UPI' || mode === 'BANK_TRANSFER') return { mode, bankAccountCode: '1121' };
    throw invalid('API_PAYMENT_MODE', 'Choose cash, UPI or a bank transfer.');
  }

  async recordAdvance(actor: ActorContext, input: Record<string, unknown>) {
    const advance = await this.#advances.record(actor, {
      idempotencyKey: `web-advance:${String(input.reference || crypto.randomUUID())}`,
      proformaId: String(input.document ?? ''),
      amount: money(paise(input.amount)),
      date: isoDate(String(input.date ?? '')),
      reference: optionalText(input.utr),
      ...this.#money(input),
    });
    return {
      state: 'recorded' as const,
      title: `Receipt voucher ${advance.number} issued`,
      message: advance.tax === null
        ? `${formatINR(advance.amount)} received against ${advance.proformaNumber}. ${GOODS_ADVANCE_NO_TAX['en-IN']}`
        : `${formatINR(advance.amount)} received against ${advance.proformaNumber}. It includes GST of ${formatINR(advance.tax.totalTax)}, which is due now and is set off when you link the tax invoice.`,
      advance: advanceView(advance),
    };
  }

  async refundAdvance(actor: ActorContext, input: Record<string, unknown>) {
    const advance = await this.#advances.refund(actor, {
      idempotencyKey: `web-refund:${String(input.reference || crypto.randomUUID())}`,
      advanceId: String(input.advance ?? ''),
      date: isoDate(String(input.date ?? '')),
      reason: String(input.reason ?? ''),
      reference: optionalText(input.utr),
      ...this.#money(input),
    });
    const refund = advance.refund;
    return {
      state: 'recorded' as const,
      title: `Refund voucher ${refund?.number} issued`,
      message: `${formatINR(refund?.amount as Money)} of advance ${advance.number} paid back.${
        advance.tax === null ? '' : ` GST of ${formatINR(total(refund?.taxRefunded as TaxHeads))} paid on it is taken back.`
      }`,
      advance: advanceView(advance),
    };
  }

  /** The receipt voucher (Rule 50) or refund voucher (Rule 51) as a printable page. */
  async printVoucher(actor: ActorContext, input: Record<string, unknown>) {
    const found = (await this.#advances.forProforma(actor, String(input.document ?? ''))).find((a) => a.id === String(input.advance ?? ''));
    if (found === undefined) throw notFound('API_ADVANCE_NOT_FOUND', 'We could not find that advance.');
    const refund = input.which === 'REFUND';
    if (refund && found.refund === null) throw notFound('API_REFUND_NOT_FOUND', 'This advance has not been refunded.');
    const seller = sellerPrint(this.#config.companyId, { name: this.#config.name, gstin: this.#config.gstin }).seller;
    const buyer = customerPrint(this.#config.companyId, found.partyId);
    return { state: 'print' as const, html: voucherHtml(found, refund, seller, buyer) };
  }

  async cancel(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.#service.cancel(actor, { id: String(input.document ?? ''), reason: String(input.reason ?? '') });
    return { state: 'recorded' as const, title: `${preSaleKind(document.kind).label['en-IN']} cancelled`, message: `${document.number} is cancelled. Its number stays used, so the series has no gap.`, document: this.describe(document) };
  }
}

// ---------------------------------------------------------------- issue #165: the two vouchers

const total = (heads: TaxHeads): Money => money(heads.cgst.minor + heads.sgst.minor + heads.utgst.minor + heads.igst.minor + heads.cess.minor);
const rateText = (rate: bigint | null): string => (rate === null ? 'No rate' : `${Number(rate) / 100}%`);
const placeText = (code: string): string => `${STATE_NAMES[code] ?? code} (${code})`;

/** An advance as the screen lists it, with every particular its voucher carries. */
const advanceView = (a: AdvanceReceipt) => ({
  id: a.id,
  number: a.number,
  date: a.date,
  proformaNumber: a.proformaNumber,
  amount: jsonAmount(a.amount.minor),
  description: a.description,
  supplyKind: a.supplyKind,
  placeOfSupply: placeText(a.placeOfSupplyStateCode),
  noTax: a.tax === null ? GOODS_ADVANCE_NO_TAX : null,
  tax: a.tax === null ? null : {
    taxableValue: jsonAmount(a.tax.taxableValue.minor),
    total: jsonAmount(a.tax.totalTax.minor),
    lines: a.tax.lines.map((l) => ({
      rate: rateText(l.ratePercentTimes100), reverseCharge: l.reverseCharge, taxableValue: jsonAmount(l.taxableValue.minor),
      cgst: jsonAmount(l.cgst.minor), sgst: jsonAmount(l.sgst.minor + l.utgst.minor), igst: jsonAmount(l.igst.minor), cess: jsonAmount(l.cess.minor),
    })),
  },
  application: a.application === null ? null : {
    invoiceNumber: a.application.invoiceNumber, amount: jsonAmount(a.application.amount.minor), taxSetOff: jsonAmount(total(a.application.taxSetOff).minor),
  },
  refund: a.refund === null ? null : {
    number: a.refund.number, date: a.refund.date, amount: jsonAmount(a.refund.amount.minor), taxRefunded: jsonAmount(total(a.refund.taxRefunded).minor), reason: a.refund.reason,
  },
  unused: jsonAmount(unusedOf(a).minor),
});

const partyBlock = (title: string, party: RenderableParty): string =>
  `<td><strong>${escapeHtml(title)}</strong><br>${escapeHtml(party.name)}<br>${party.addressLines.map(escapeHtml).join('<br>')}<br>GSTIN: ${escapeHtml(party.gstin ?? 'Not registered')}<br>State: ${escapeHtml(party.stateName)} (${escapeHtml(party.stateCode)})</td>`;

/**
 * Rule 50's particulars for a receipt voucher, or Rule 51's for a refund voucher: supplier and
 * recipient with GSTINs, number and date, description, amount, rate and tax, place of supply,
 * reverse charge, and a place to sign. A refund voucher also names the receipt voucher it refunds.
 */
const voucherHtml = (a: AdvanceReceipt, refund: boolean, seller: RenderableParty, buyer: RenderableParty): string => {
  const r = a.refund;
  const amount = refund && r !== null ? r.amount : a.amount;
  // A refund takes back the tax on the refunded part only, so its rows are scaled to that.
  const scale = (m: Money): Money => (refund && r !== null && a.amount.minor > 0n ? mulDiv(m, r.amount.minor, a.amount.minor) : m);
  const rows = a.tax === null
    ? `<tr><td colspan="6">${escapeHtml(GOODS_ADVANCE_NO_TAX['en-IN'])}</td></tr>`
    : a.tax.lines.map((l) => `<tr><td>${rateText(l.ratePercentTimes100)}</td><td>${formatINR(scale(l.taxableValue))}</td><td>${formatINR(scale(l.cgst))}</td><td>${formatINR(scale(money(l.sgst.minor + l.utgst.minor)))}</td><td>${formatINR(scale(l.igst))}</td><td>${formatINR(scale(l.cess))}</td></tr>`).join('');
  const taxTotal = a.tax === null ? null : refund && r !== null ? total(r.taxRefunded) : a.tax.totalTax;
  const reverse = a.tax?.lines.some((l) => l.reverseCharge) === true ? 'Yes' : 'No';
  const facts: [string, string][] = [
    [refund ? 'Refund voucher number' : 'Receipt voucher number', refund && r !== null ? r.number : a.number],
    ['Date', refund && r !== null ? r.date : a.date],
    ...(refund ? [['Receipt voucher refunded', `${a.number} dated ${a.date}`] as [string, string]] : []),
    ['Against proforma invoice', a.proformaNumber],
    ['Description', a.description],
    [refund ? 'Amount refunded' : 'Amount of advance received', formatINR(amount)],
    ...(taxTotal === null ? [] : [[refund ? 'Tax refunded' : 'Tax on the advance', formatINR(taxTotal)] as [string, string]]),
    ['Place of supply', placeText(a.placeOfSupplyStateCode)],
    ['Tax payable on reverse charge', reverse],
    ...(refund && r !== null ? [['Reason', r.reason] as [string, string]] : []),
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(refund && r !== null ? r.number : a.number)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}h1{font-size:20px;margin:0}</style></head><body>
<h1>${refund ? 'Refund Voucher' : 'Receipt Voucher'}</h1><p>${refund ? 'Issued under CGST Rule 51 to pay back an advance, or the part of it, for which no supply was made.' : 'Issued under CGST Rule 50 for an advance received. This is not a tax invoice.'}</p>
<table><tr>${partyBlock('Supplier', seller)}${partyBlock('Recipient', buyer)}</tr></table>
<table>${facts.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<table><tr><th>Rate</th><th>Taxable value</th><th>CGST</th><th>SGST / UTGST</th><th>IGST</th><th>Cess</th></tr>${rows}</table>
<p style="margin-top:48px;text-align:right">For ${escapeHtml(seller.name)}<br><br>Authorised signatory</p></body></html>`;
};
