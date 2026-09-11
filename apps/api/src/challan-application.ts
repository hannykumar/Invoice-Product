/**
 * Issue #141 — the delivery challan desk behind the web screen.
 *
 * Takes what the dispatch clerk typed, turns it into a challan through the real challan service,
 * and prints it through the real rendering engine. Nothing here decides a rule: the service decides
 * what the law allows, and the renderer decides nothing a template could change.
 *
 * The consignee's address is typed on the form and kept with the challan as it was on the day the
 * goods left, the way the printed page must show it. This local app has no customer address book
 * yet, and printing a made-up address on a document that travels with goods is not an option.
 */
import { invalid, isoDate, money, notFound, quantityFromString, type CompanyId, type PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import {
  CHALLAN_REASONS,
  challanReason,
  isChallanReason,
  type ChallanInput,
  type ChallanService,
  type DeliveryChallan,
} from '@invoice/sales';
import {
  captureSnapshot,
  renderChallan,
  renderChallanCopies,
  templateById,
  toChallanDocument,
  type RenderableParty,
  type TemplateSnapshot,
} from '@invoice/invoice-templates';
import { consignmentFromChallan, STATE_NAMES, type ConsignmentDocument, type MovementReason } from '@invoice/transport';

const jsonAmount = (minor: bigint): number => Number(minor) / 100;

/** Rupees as typed, "1,250.50" included. Zero is allowed: goods sent free still move on a challan. */
const paise = (value: unknown): bigint => {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw invalid('API_AMOUNT', `"${text}" is not an amount in rupees and paise.`);
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

export interface ChallanDeskConfig {
  readonly companyId: CompanyId;
  readonly name: string;
  readonly location: string;
  readonly gstin: string;
  readonly customerId: PartyId;
  readonly customerName: string;
  readonly customerGstin: string;
}

/** What is frozen onto a challan when it is issued, besides the challan itself. */
interface PrintFacts {
  readonly consigneeAddress: readonly string[];
  readonly deliveryPlace: string | null;
  readonly snapshot: TemplateSnapshot;
}

/** The only item this local company stocks, as the demo masters hold it. */
const DEMO_ITEM = { itemId: 'SOAP', unit: 'PCS' } as const;

export class ChallanDesk {
  readonly #config: ChallanDeskConfig;
  readonly #service: ChallanService;
  readonly #facts = new Map<string, PrintFacts>();

  constructor(config: ChallanDeskConfig, service: ChallanService) {
    this.#config = config;
    this.#service = service;
  }

  /** The reasons GST allows, for the picker. The same table the service decides from. */
  static reasons() {
    return {
      reasons: CHALLAN_REASONS.map((r) => ({
        reason: r.reason,
        label: r.label,
        legalBasis: r.legalBasis,
        showsTax: r.showsTax,
        invoiceFollows: r.invoiceFollows,
        needsNote: r.needsNote,
      })),
    };
  }

  #input(input: Record<string, unknown>): ChallanInput {
    const reason = String(input.reason ?? '');
    if (!isChallanReason(reason)) throw invalid('API_CHALLAN_REASON', 'Choose why the goods are moving.');
    const deliveryState = String(input.deliveryState ?? '').trim();
    return {
      partyId: this.#config.customerId,
      reason,
      reasonNote: String(input.reasonNote ?? '').trim() || null,
      documentDate: isoDate(String(input.date ?? '')),
      deliveryStateCode: deliveryState === '' ? null : deliveryState,
      lines: [{
        lineId: 'line-1',
        itemId: DEMO_ITEM.itemId,
        quantity: quantityFromString(String(input.quantity ?? ''), DEMO_ITEM.unit),
        unitPrice: money(paise(input.rate)),
        warehouseId: 'wh-main',
      }],
    };
  }

  #addressOf(input: Record<string, unknown>): string[] {
    const lines = String(input.consigneeAddress ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) {
      throw invalid('API_CHALLAN_ADDRESS', 'Type the consignee’s address. A challan must show where the goods are going (CGST Rule 55).');
    }
    return lines;
  }

  async preview(actor: ActorContext, input: Record<string, unknown>) {
    const working = await this.#service.preview(actor, this.#input(input));
    const rule = challanReason(String(input.reason) as DeliveryChallan['reason']);
    if (!working.ok) {
      return {
        state: 'problems' as const,
        title: 'This challan cannot be issued yet',
        message: 'Everything stopping it is listed below. Nothing was saved and no number was used.',
        problems: working.problems.map((p) => ({ code: p.code, message: p.message })),
      };
    }
    const c = working.challan;
    return {
      state: 'preview' as const,
      title: rule.showsTax ? 'Challan checked — tax will show on it' : 'Challan checked — no tax on it',
      // Two different provisions, named separately: the one that allows this movement on a challan,
      // and Rule 55(1)(vii), which decides whether the tax prints on it.
      message: rule.showsTax
        ? `Allowed by ${rule.legalBasis}. These goods are moving as a sale, so the tax rate and amount must be on the challan (CGST Rule 55(1)(vii)). The tax invoice follows later.`
        : `Allowed by ${rule.legalBasis}. These goods are not being sold, so the challan shows their value and no tax (CGST Rule 55(1)(vii)). No tax invoice follows it.`,
      legalBasis: rule.legalBasis,
      showsTax: c.showsTax,
      interState: c.interState,
      placeOfSupply: c.placeOfSupplyStateCode === null ? null : `${STATE_NAMES[c.placeOfSupplyStateCode] ?? ''} (${c.placeOfSupplyStateCode})`,
      value: jsonAmount(c.totals.taxableValue.minor),
      tax: jsonAmount(c.totals.totalTax.minor),
      lines: c.lines.map((l) => ({
        item: l.itemName,
        hsn: l.hsnOrSac,
        quantity: `${Number(l.quantity.scaled) / 1_000_000} ${l.quantity.unit}${l.quantityProvisional ? ' (provisional)' : ''}`,
        value: jsonAmount(l.taxableValue.minor),
        rate: l.ratePercentTimes100 === null ? null : Number(l.ratePercentTimes100) / 100,
      })),
      problems: [],
    };
  }

  async issue(actor: ActorContext, input: Record<string, unknown>) {
    const address = this.#addressOf(input);
    const challan = await this.#service.issue(actor, {
      idempotencyKey: `web-challan:${String(input.reference || crypto.randomUUID())}`,
      input: this.#input(input),
    });
    if (!this.#facts.has(challan.id)) {
      const template = templateById('india-standard');
      if (template === undefined) throw notFound('API_TEMPLATE', 'The India-standard design is missing.');
      this.#facts.set(challan.id, {
        consigneeAddress: address,
        deliveryPlace: String(input.deliveryPlace ?? '').trim() || null,
        snapshot: captureSnapshot(template, 'en-IN', challan.createdAt.slice(0, 10)),
      });
    }
    return { state: 'recorded' as const, title: 'Challan issued', message: `${challan.number} was issued. The goods may move on it.`, challan: this.#json(challan) };
  }

  async list(actor: ActorContext) {
    const challans = await this.#service.list(actor);
    return { challans: challans.sort((a, b) => b.number.localeCompare(a.number)).map((c) => this.#json(c)) };
  }

  #json(c: DeliveryChallan) {
    const rule = challanReason(c.reason);
    return {
      id: c.id,
      number: c.number,
      date: c.documentDate,
      state: c.state,
      reason: rule.label,
      legalBasis: rule.legalBasis,
      invoiceFollows: rule.invoiceFollows,
      showsTax: c.showsTax,
      value: jsonAmount(c.totals.taxableValue.minor),
      tax: jsonAmount(c.totals.totalTax.minor),
      ewayBill: c.ewayBill === null ? null : { number: c.ewayBill.number, vehicle: c.ewayBill.vehicleNumber, source: c.ewayBill.source },
      invoice: c.invoice === null ? null : { number: c.invoice.invoiceNumber, date: c.invoice.invoiceDate, differences: c.invoice.differences },
      cancelReason: c.cancelReason,
    };
  }

  async #require(actor: ActorContext, id: string): Promise<DeliveryChallan> {
    const challan = await this.#service.get(actor, id);
    if (challan === null) throw notFound('API_CHALLAN_NOT_FOUND', 'We could not find that challan.');
    return challan;
  }

  #party(stateCode: string, name: string, gstin: string, addressLines: readonly string[]): RenderableParty {
    return { name, addressLines, gstin, stateCode, stateName: STATE_NAMES[stateCode] ?? stateCode };
  }

  /** The printed challan: one copy, or all three in one document for one press of Print. */
  async print(actor: ActorContext, input: Record<string, unknown>) {
    const challan = await this.#require(actor, String(input.challan ?? ''));
    const facts = this.#facts.get(challan.id);
    if (facts === undefined) throw notFound('API_CHALLAN_PRINT_FACTS', 'This challan was issued before the address was recorded, so it cannot be printed here.');
    const locale = input.locale === 'hi-IN' ? 'hi-IN' as const : 'en-IN' as const;
    const format = input.format === 'MOBILE' ? 'MOBILE' as const : 'A4' as const;
    const consigneeState = this.#config.customerGstin.slice(0, 2);
    const deliveryState = challan.deliveryStateCode;
    const document = toChallanDocument(challan, {
      consigner: this.#party(this.#config.gstin.slice(0, 2), this.#config.name, this.#config.gstin, [this.#config.location]),
      consignee: this.#party(consigneeState, this.#config.customerName, this.#config.customerGstin, facts.consigneeAddress),
      // Only when the goods go somewhere other than the consignee's own state and address.
      deliveryAddress: deliveryState === null || deliveryState === consigneeState
        ? null
        : this.#party(deliveryState, this.#config.customerName, this.#config.customerGstin, facts.deliveryPlace === null ? [] : [facts.deliveryPlace]),
      placeOfSupplyStateName: challan.placeOfSupplyStateCode === null ? null : STATE_NAMES[challan.placeOfSupplyStateCode] ?? null,
    });
    const copy = String(input.copy ?? 'ALL');
    const html = copy === 'ORIGINAL' || copy === 'DUPLICATE' || copy === 'TRIPLICATE'
      ? renderChallan(document, facts.snapshot, { format, locale, copy })
      : renderChallanCopies(document, facts.snapshot, { format, locale });
    return { state: 'print' as const, number: challan.number, html };
  }

  /** A person types the e-way bill number in, for when it was raised somewhere else. */
  async attachEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const challan = await this.#service.attachEwayBill(actor, {
      challanId: String(input.challan ?? ''),
      ewayBillNumber: String(input.ewayBillNumber ?? ''),
      vehicleNumber: String(input.vehicle ?? '').trim().toUpperCase() || null,
      transporter: String(input.transporter ?? '').trim() || null,
      source: 'TYPED',
    });
    return { state: 'recorded' as const, title: 'E-way bill recorded', message: `E-way bill ${challan.ewayBill?.number} will print on ${challan.number}.`, challan: this.#json(challan) };
  }

  /** Called after the e-way bill service raised one for this challan, so the number lands on it. */
  async recordPortalEwayBill(actor: ActorContext, challanId: string, ewayBillNumber: string, vehicle: string | null): Promise<void> {
    await this.#service.attachEwayBill(actor, { challanId, ewayBillNumber, vehicleNumber: vehicle, source: 'PORTAL' });
  }

  async linkInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const challan = await this.#service.linkInvoice(actor, { challanId: String(input.challan ?? ''), invoiceId: String(input.invoice ?? '') });
    const differences = challan.invoice?.differences ?? [];
    return {
      state: 'recorded' as const,
      title: differences.length === 0 ? 'Invoice linked' : 'Invoice linked — with differences',
      message: `${challan.number} is billed on invoice ${challan.invoice?.invoiceNumber}.`,
      effects: differences,
      challan: this.#json(challan),
    };
  }

  async cancel(actor: ActorContext, input: Record<string, unknown>) {
    const challan = await this.#service.cancel(actor, {
      challanId: String(input.challan ?? ''),
      reason: String(input.reason ?? ''),
      ewayBillCancelledOnPortal: input.ewayBillCancelledOnPortal === true || input.ewayBillCancelledOnPortal === 'yes',
    });
    return { state: 'recorded' as const, title: 'Challan cancelled', message: `${challan.number} is cancelled. Its number stays used, so the series has no gap.`, challan: this.#json(challan) };
  }

  /** Issued challans the goods may still move on, for the e-way bill screen's picker. */
  async movable(actor: ActorContext) {
    return (await this.#service.list(actor, { state: 'ISSUED' })).map((c) => ({ id: c.id, number: c.number, value: jsonAmount(c.totals.taxableValue.minor + c.totals.totalTax.minor) }));
  }

  /**
   * The challan as an e-way bill carries it: the document and the reason for moving it, both taken
   * from the challan so nobody answers them twice. `null` when the id is not a challan, so the
   * caller can look for an invoice instead.
   */
  async forMovement(actor: ActorContext, id: string): Promise<{ document: ConsignmentDocument; reason: MovementReason } | null> {
    const challan = await this.#service.get(actor, id);
    if (challan === null) return null;
    if (challan.state !== 'ISSUED') {
      throw invalid('API_CHALLAN_NOT_OPEN', `Challan ${challan.number} is ${challan.state === 'CANCELLED' ? 'cancelled' : 'already billed'}, so no goods move on it.`);
    }
    return { document: consignmentFromChallan(challan), reason: challanReason(challan.reason).movementReason };
  }
}
