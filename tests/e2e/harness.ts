/**
 * Issue #44 — one business, wired the way production wires it, for every end-to-end scenario.
 *
 * The point of an end-to-end test here is that it composes the *real* services across package
 * boundaries. A scenario that stubs the ledger proves nothing about whether a sale and its return
 * agree, because the disagreement would live in exactly the seam the stub replaced. So this builds
 * one shop with the real ledger, inventory, purchase posting, sales, receivables and returns
 * services joined to a single unit-of-work store, and each scenario drives it.
 *
 * The only stand-ins are at the edges the product itself replaces: the government portals and the
 * bank, which are the synthetic connectors the adapters were built against, reached through the
 * same gateway production uses. That is what makes failure injection meaningful — flipping the
 * synthetic IRP to `outage` exercises the real retry, the real idempotency and the real recovery.
 *
 * The wiring lives here rather than in each test so that a scenario file reads as the business
 * story it is testing, and so that adding a scenario does not mean copying eighty lines of setup
 * and quietly letting it drift from the last one.
 */
import { asId, isoDate, rupees, type PartyId } from '@invoice/kernel';
import { permissionPortFromActor, type Account, type ActorContext } from '@invoice/ledger';
import { GstCalculator, InMemoryDeclaredRates, InMemoryMasterData, RateTable } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository, SalesService, noComplianceHooks, type ComplianceHookPort } from '@invoice/sales';
import type { EInvoiceService } from '../../packages/gst/src/einvoice-service.ts';
import type { EInvoiceDocument } from '../../packages/gst/src/payload.ts';
import { salesInventoryAdapter } from '@invoice/inventory';
import {
  InMemoryReturnNoteRepository, ReturnService, returnInventoryAdapter, salesReturnSource,
  purchaseReturnSource,
} from '@invoice/returns';
import {
  InMemoryPaymentRepository,
  ReceivablesService,
  type DocumentLedgerPort,
  type OpenDocument,
} from '@invoice/receivables';
import {
  ALL_PERMISSIONS,
  COMPANY,
  makeShop,
} from '../../packages/purchasing/src/posting-fixtures.ts';

export {
  ALL_PERMISSIONS, COMPANY, SUPPLIER, SUPPLIER_GSTIN, makeShop, purchase, steelLine,
} from '../../packages/purchasing/src/posting-fixtures.ts';

export const CUSTOMER = asId<'Party'>('e2e-customer');
export const CUSTOMER_NAME = 'ABC Traders';

/** The company's own registration, and the customer's. Both in Karnataka, so a sale is intra-state. */
export const COMPANY_GSTIN = '29AAAAA0000A1ZQ';
export const COMPANY_STATE = '29';
export const CUSTOMER_GSTIN = '29DDDDD3333D1ZS';

/** The moment every scenario runs at, so a date-sensitive rule cannot drift with the wall clock. */
export const NOW = '2026-08-29T10:00:00.000Z';

/**
 * Everything the scenarios are allowed to do.
 *
 * Deliberately a single generous actor: these tests are about whether the modules agree with each
 * other, not about whether permissions are enforced — that is each module's own test, and #44's
 * non-goals say so. The one thing this list must not do is grow a permission the product does not
 * define, so it is assembled from the modules' own constants where they exist.
 */
export const E2E_PERMISSIONS = [
  ...ALL_PERMISSIONS,
  'ledger.post.sale', 'ledger.post.credit_note', 'ledger.post.debit_note',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel',
  'payments.record', 'payments.allocate', 'ledger.post.receipt', 'ledger.post.payment',
  'returns.create',
  'einvoice.view', 'einvoice.generate', 'einvoice.cancel',
  'eway.view', 'eway.generate', 'eway.update', 'eway.cancel',
];

export type Business = Awaited<ReturnType<typeof makeBusiness>>;

/**
 * One shop, with every service the scenarios need joined to the same store.
 *
 * `store.join` is what makes the cross-module guarantee testable at all: sales, payments and return
 * notes take part in the same unit of work as the ledger and the stock, so a refused sale cannot
 * leave a payable behind. A scenario that could not see that seam would not be an end-to-end test.
 */
export const makeBusiness = async (options: {
  readonly now?: string;
  /** Wire the real e-invoice service in here to exercise the government seam. */
  readonly compliance?: ComplianceHookPort;
} = {}) => {
  const at = options.now ?? NOW;
  const clock = { now: () => new Date(at) };
  const shop = await makeShop();
  const actor: ActorContext = { ...shop.actor, permissions: E2E_PERMISSIONS };

  await shop.ledger.openPartyAccount(actor, { partyId: CUSTOMER, name: CUSTOMER_NAME, kind: 'CUSTOMER' });

  // A real bank account under the standard chart's bank heading, so a receipt has somewhere to land
  // and the bank reconciliation has a code to match against.
  await shop.store.transaction(COMPANY, async (uow) => {
    const bankHeading = await uow.accounts.findByCode(COMPANY, '1120');
    if (bankHeading === null || bankHeading === undefined) throw new Error('the standard chart must have a bank-account heading');
    const bankAccount: Account = {
      id: asId<'Account'>(`${COMPANY}:acc:1121`),
      companyId: COMPANY,
      code: '1121',
      name: 'Current bank account',
      type: 'ASSET',
      parentId: bankHeading.id,
      isGroup: false,
      active: true,
      partyId: null,
      systemRole: null,
    };
    await uow.accounts.insertMany([bankAccount]);
  });

  const salesRepository = new InMemorySalesRepository();
  const paymentRepository = new InMemoryPaymentRepository();
  const returnRepository = new InMemoryReturnNoteRepository();
  shop.store.join(salesRepository).join(paymentRepository).join(returnRepository);

  const taxMasters = new InMemoryMasterData();
  taxMasters.putCompany({ companyId: COMPANY, gstin: COMPANY_GSTIN, stateCode: COMPANY_STATE, registration: 'REGULAR' });
  taxMasters.putParty(COMPANY, { partyId: CUSTOMER, gstin: CUSTOMER_GSTIN, stateCode: COMPANY_STATE, registration: 'REGULAR' });
  taxMasters.putItem(COMPANY, {
    itemId: 'TMT12', name: 'TMT Steel Bar 12mm', kind: 'GOODS', hsnOrSac: '72142090',
    treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'KGS',
  });

  // The business's own declared rate, marked as such. A test must never assert against a rate this
  // repository claims is the law: the compliance register (#54) is the only thing allowed to do that.
  const declaredRates = new InMemoryDeclaredRates();
  declaredRates.declare({
    companyId: COMPANY,
    code: '72142090',
    kind: 'GOODS',
    ratePercentTimes100: 1800n,
    effectiveFrom: isoDate('2026-04-01'),
    effectiveTo: null,
    declaredBy: actor.userId,
    declaredOn: isoDate('2026-04-01'),
    basis: 'Synthetic E2E business declaration; not a legal rate source.',
  });

  const calculator = new GstCalculator({
    masterData: taxMasters,
    rates: new RateTable([]),
    declaredRates,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
  });

  const sales = new SalesService({
    store: shop.store,
    ledger: shop.ledger,
    calculator,
    repository: salesRepository,
    inventory: salesInventoryAdapter(shop.inventoryService, { defaultWarehouseId: 'wh-main' }),
    compliance: options.compliance ?? noComplianceHooks,
    permissions: permissionPortFromActor,
    audit: shop.audit,
    clock,
  });

  const documents: DocumentLedgerPort = {
    async openDocuments(companyId, partyId): Promise<readonly OpenDocument[]> {
      const invoices = await salesRepository.list(companyId, { partyId, state: 'FINAL' });
      return invoices.map((invoice) => ({
        documentId: invoice.id,
        kind: 'SALES_INVOICE',
        number: invoice.number ?? invoice.id,
        partyId,
        date: invoice.documentDate,
        dueDate: invoice.dueDate,
        value: invoice.pricing?.totals.invoiceValue ?? rupees(0),
        side: 'RECEIVABLE',
      }));
    },
    async parties(): Promise<readonly PartyId[]> { return [CUSTOMER]; },
    async nameOf(_companyId, partyId): Promise<string> { return partyId === CUSTOMER ? CUSTOMER_NAME : String(partyId); },
  };

  const receivables = new ReceivablesService({
    store: shop.store,
    ledger: shop.ledger,
    repository: paymentRepository,
    documents,
    permissions: permissionPortFromActor,
    audit: shop.audit,
    clock,
  });

  const returns = new ReturnService({
    store: shop.store,
    ledger: shop.ledger,
    repository: returnRepository,
    sales: salesReturnSource(salesRepository),
    purchases: purchaseReturnSource(shop.bills),
    inventory: returnInventoryAdapter(shop.inventoryService),
    permissions: permissionPortFromActor,
    audit: shop.audit,
    clock,
  });

  return {
    ...shop,
    actor, clock, calculator, taxMasters, declaredRates,
    sales, salesRepository,
    receivables, paymentRepository,
    returns, returnRepository,
  };
};

// ----------------------------------------------------------------- the government-facing seam

/**
 * The sales module's compliance hook, wired to the real e-invoice service.
 *
 * This is the seam #44 exists to test. `ComplianceHookPort` in the sales module carries a comment
 * saying the books must not wait for a government service — and whether that is actually true is
 * not something either module's own tests can answer, because each one stubs the other. Composing
 * them here is the only place the guarantee is provable.
 *
 * The adapter is written for the test rather than shipped from a package on purpose: #26 owns the
 * production wiring, and inventing it in the test directory would be doing another issue's work in
 * the wrong place. What this proves is that the contract between them holds.
 */
export const salesInvoiceToEInvoiceDocument = (invoice: {
  readonly id: string;
  readonly number: string | null;
  readonly documentDate: string;
  readonly lines: readonly { readonly lineId: string; readonly itemId: string; readonly quantity: { readonly scaled: bigint; readonly unit: string } }[];
  readonly pricing: {
    readonly lines: readonly {
      readonly lineId: string; readonly itemName: string; readonly hsnOrSac: string | null;
      readonly ratePercentTimes100: bigint | null;
      readonly taxableValue: { readonly minor: bigint };
      readonly cgst: { readonly minor: bigint }; readonly sgst: { readonly minor: bigint };
      readonly igst: { readonly minor: bigint }; readonly cess: { readonly minor: bigint };
      readonly lineTotal: { readonly minor: bigint };
    }[];
    readonly totals: { readonly invoiceValue: { readonly minor: bigint } };
  } | null;
}): EInvoiceDocument => {
  if (invoice.number === null || invoice.pricing === null) {
    throw new Error(`Invoice ${invoice.id} is not final, so it cannot be sent to the government.`);
  }
  const priced = invoice.pricing;
  const total = (pick: (line: (typeof priced.lines)[number]) => { readonly minor: bigint }): bigint =>
    priced.lines.reduce((running, line) => running + pick(line).minor, 0n);

  return {
    documentId: invoice.id,
    documentType: 'INVOICE',
    documentNumber: invoice.number,
    documentDate: invoice.documentDate as EInvoiceDocument['documentDate'],
    recipientKind: 'B2B',
    supplier: {
      gstin: COMPANY_GSTIN, legalName: 'Sampoorna Traders Private Limited',
      address1: '14 Peenya Industrial Area', location: 'Bengaluru', pincode: '560058', stateCode: COMPANY_STATE,
    },
    recipient: {
      gstin: CUSTOMER_GSTIN, legalName: CUSTOMER_NAME,
      address1: '7 Avenue Road', location: 'Bengaluru', pincode: '560002', stateCode: COMPANY_STATE,
    },
    placeOfSupplyStateCode: COMPANY_STATE,
    reverseCharge: false,
    lines: priced.lines.map((line, index) => {
      const source = invoice.lines.find((item) => item.lineId === line.lineId);
      if (source === undefined) throw new Error(`Priced line ${line.lineId} has no line on the bill.`);
      return {
        lineNumber: index + 1,
        description: line.itemName,
        isService: false,
        hsnOrSac: line.hsnOrSac ?? '72142090',
        quantity: (source.quantity.scaled / 1_000000n).toString(),
        unit: source.quantity.unit,
        unitPricePaise: line.taxableValue.minor / (source.quantity.scaled / 1_000000n),
        grossAmountPaise: line.taxableValue.minor,
        discountPaise: 0n,
        taxableValuePaise: line.taxableValue.minor,
        gstRatePercentTimes100: line.ratePercentTimes100 ?? 0n,
        cgstPaise: line.cgst.minor,
        sgstPaise: line.sgst.minor,
        igstPaise: line.igst.minor,
        cessPaise: line.cess.minor,
        lineTotalPaise: line.lineTotal.minor,
      };
    }),
    totalTaxableValuePaise: total((line) => line.taxableValue),
    totalCgstPaise: total((line) => line.cgst),
    totalSgstPaise: total((line) => line.sgst),
    totalIgstPaise: total((line) => line.igst),
    totalCessPaise: total((line) => line.cess),
    roundOffPaise: 0n,
    invoiceValuePaise: priced.totals.invoiceValue.minor,
  };
};

/**
 * What the business tells the applicability rules about itself.
 *
 * Turnover above the threshold, stated rather than inferred, so the decision is `APPLICABLE` for a
 * reason a person could check. A scenario that wants the other answer overrides the turnover.
 */
export const einvoiceApplicability = (documentDate: string, turnoverPaise = 8_00_00_000_00n) => ({
  documentType: 'INVOICE' as const,
  documentDate: documentDate as EInvoiceDocument['documentDate'],
  recipientKind: 'B2B' as const,
  recipientGstin: CUSTOMER_GSTIN,
  supplier: {
    gstin: COMPANY_GSTIN,
    aggregateTurnoverPaise: turnoverPaise,
    turnoverFinancialYear: '2025-2026',
  },
});

/**
 * The compliance hook the sales service calls when a bill becomes final.
 *
 * It never throws. A government service being down is not a reason to refuse a sale that is already
 * a valid GST bill — it is a reason to say the e-invoice number is still to come, which is what the
 * returned registration says.
 */
export const einvoiceHooks = (
  service: EInvoiceService,
  actor: ActorContext,
  options: { readonly turnoverPaise?: bigint } = {},
): ComplianceHookPort => ({
  async onInvoiceFinalised(invoice) {
    let record: Awaited<ReturnType<EInvoiceService['register']>>;
    try {
      record = await service.register(actor, {
        document: salesInvoiceToEInvoiceDocument(invoice as Parameters<typeof salesInvoiceToEInvoiceDocument>[0]),
        applicability: einvoiceApplicability(
          invoice.documentDate,
          ...(options.turnoverPaise === undefined ? [] : [options.turnoverPaise] as const),
        ),
      });
    } catch (error) {
      // A bill that does not need an IRN, or that the rules cannot decide about, is not a failed
      // sale. It is a sale with nothing to report, and the message says which.
      return [{
        kind: 'E_INVOICE',
        status: 'NOT_APPLICABLE',
        reference: null,
        message: error instanceof Error ? error.message : 'The e-invoice decision could not be made.',
      }];
    }
    return [{
      kind: 'E_INVOICE',
      status: record.status === 'REGISTERED' ? 'REGISTERED' : record.status === 'FAILED' ? 'FAILED' : 'PENDING',
      reference: record.acknowledgement?.irn ?? null,
      message: record.message,
    }];
  },
  async onInvoiceCancelled() {},
});
