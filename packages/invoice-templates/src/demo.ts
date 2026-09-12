/**
 * Issue #13 [E13] — a walkthrough you can look at.
 *
 * Runs the whole chain for real: master data, the rules engine in **production** mode, GST worked
 * out from rates the business declared (#54 option C), a sales invoice finalised through the
 * ledger, then printed on four different papers. Nothing here is a mock-up; every figure comes out
 * of the same code a real bill would use.
 *
 *   npm run demo:invoice
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asId, fixedClock, isoDate, quantityFromString, rupees, type CompanyId } from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  permissionPortFromActor,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { DEFAULT_TCS_POLICY, GstCalculator, InMemoryDeclaredRates, InMemoryMasterData, RateTable } from '@invoice/gst-calc';
import { InMemorySalesRepository, SalesService, noComplianceHooks, permissiveInventory } from '@invoice/sales';
import { captureSnapshot } from './snapshot.ts';
import { renderInvoice, renderInvoiceCopies, renderInvoiceCopySet } from './render.ts';
import { shipToFromDelivery, toInvoiceDocument } from './from-sales.ts';
import { searchTradeMarks, tradeMarkFromLibrary, tradeMarkPictures, tradeMarkSvg } from './marks.ts';
import { recommendTemplates, templateById, type PageFormat } from './template.ts';

const COMPANY: CompanyId = asId<'Company'>('demo-sharma');
const OWNER = asId<'User'>('demo-owner');
const PERMISSIONS = ['ledger.setup', 'ledger.post.sale', 'sales.draft.write', 'sales.finalise', 'sales.cancel'];

const actor: ActorContext = {
  companyId: COMPANY,
  branchId: asId<'Branch'>('kb'),
  userId: OWNER,
  permissions: PERMISSIONS,
};

const main = async (): Promise<void> => {
  const store = new InMemoryLedgerStore();
  const repository = new InMemorySalesRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:30:00.000Z');
  let n = 0;
  const idFactory = (): string => `demo-${String((n += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  const chart = buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY));
  const customer: Account = {
    id: asId<'Account'>(`${COMPANY}:acc:1201`),
    companyId: COMPANY,
    code: '1201',
    name: 'ABC Traders',
    type: 'ASSET',
    parentId: asId<'Account'>(`${COMPANY}:acc:1200`),
    isGroup: false,
    active: true,
    partyId: asId<'Party'>('abc-traders'),
    systemRole: null,
  };
  await ledger.initialiseCompany(actor, { booksStartDate: isoDate('2026-04-01'), accounts: [...chart, customer] });

  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId: COMPANY, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  masterData.putParty(COMPANY, { partyId: 'abc-traders', gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' });
  masterData.putItem(COMPANY, { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', kind: 'GOODS', hsnOrSac: '0808', treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'BOX' });
  masterData.putItem(COMPANY, { itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });
  masterData.putItem(COMPANY, { itemId: 'JUICE-1L', name: 'Packaged apple juice, 1 litre', kind: 'GOODS', hsnOrSac: '2009', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });

  // Option C: the business tells us the rates it charges. Nothing here claims to be law, and the
  // printed bill says so.
  const declaredRates = new InMemoryDeclaredRates()
    .declare({
      companyId: COMPANY, code: '3923', kind: 'GOODS', ratePercentTimes100: 1800n,
      effectiveFrom: isoDate('2026-04-01'), effectiveTo: null,
      declaredBy: OWNER, declaredOn: isoDate('2026-04-01'),
      basis: 'The rate our accountant has always used for plastic crates',
    })
    .declare({
      companyId: COMPANY, code: '2009', kind: 'GOODS', ratePercentTimes100: 500n,
      effectiveFrom: isoDate('2026-04-01'), effectiveTo: null,
      declaredBy: OWNER, declaredOn: isoDate('2026-04-01'),
      basis: 'The rate printed on our supplier’s bills',
    });

  const calculator = new GstCalculator({
    masterData,
    // Production, and the register has approved no rate yet — so every figure below comes from
    // what the business declared, and is labelled as such.
    rates: new RateTable([]),
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
    declaredRates,
  });

  const sales = new SalesService({
    store, ledger, calculator, repository,
    inventory: permissiveInventory,
    compliance: noComplianceHooks,
    permissions: permissionPortFromActor,
    audit, clock,
    policy: {
      series: { prefix: 'INV', branchCode: '' },
      approvalRequiredAtOrAbove: null,
      cancellationWindowDays: 7,
      allowCancelAfterGovernmentRegistration: false,
      defaultDueDays: 30,
      tcs: DEFAULT_TCS_POLICY,
      roundToWholeRupee: true,
    },
    idFactory,
  });

  const draft = await sales.createDraft(actor, {
    idempotencyKey: 'demo-bill-1',
    input: {
      partyId: asId<'Party'>('abc-traders'),
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-20'),
      lines: [
        { lineId: 'l1', itemId: 'APL-BOX-10', quantity: quantityFromString('70', 'BOX'), unitPrice: rupees(800), priceBasis: 'EXCLUSIVE' },
        { lineId: 'l2', itemId: 'CRATE-P', quantity: quantityFromString('40', 'PCS'), unitPrice: rupees(210), priceBasis: 'EXCLUSIVE' },
        { lineId: 'l3', itemId: 'JUICE-1L', quantity: quantityFromString('120', 'PCS'), unitPrice: rupees(95), priceBasis: 'EXCLUSIVE', discount: { kind: 'PERCENT', percentTimes100: 500n } },
      ],
      freight: rupees(1500),
      narration: 'Weekly supply',
    },
  });

  if (draft.state === 'NEEDS_INFO') {
    console.error('The bill could not be priced:');
    for (const p of draft.problems) console.error(`  - ${p.message['en-IN']}`);
    process.exitCode = 1;
    return;
  }

  const issued = await sales.finalise(actor, { idempotencyKey: 'demo-finalise-1', invoiceId: draft.id });
  const invoice = issued.invoice;

  const seller = {
    name: 'Sharma Fruit Traders',
    addressLines: ['12/4, Ajmal Khan Road', 'Karol Bagh, New Delhi 110005'],
    gstin: '07AAAAA0000A1Z4',
    pan: 'AAAAA0000A',
    stateCode: '07',
    stateName: 'Delhi',
    phone: '011 4000 1234',
    email: 'billing@sharmafruit.example',
  };
  const buyer = {
    name: 'ABC Traders',
    addressLines: ['Shop 8, Azadpur Mandi', 'New Delhi 110033'],
    gstin: '07DDDDD3333D1ZV',
    stateCode: '07',
    stateName: 'Delhi',
    phone: '98110 55221',
  };

  const document = toInvoiceDocument(invoice, {
    title: 'TAX_INVOICE',
    seller,
    buyer,
    placeOfSupplyStateName: 'Delhi',
    transport: {
      transporter: 'Sharma Roadlines',
      vehicleNumber: 'DL01AB1234',
      eWayBillNumber: null,
      lrNumber: 'SRL/2026/44120',
      documentNumber: 'GC-88213',
      documentDate: isoDate('2026-08-20'),
      destination: 'Azadpur Mandi, New Delhi',
    },
    // Issue #156 — named bank fields, the way a buyer's clerk can safely copy them.
    bank: {
      bankName: 'HDFC Bank Ltd.',
      accountNumber: '50200012345678',
      branch: 'Karol Bagh',
      ifsc: 'HDFC0000123',
    },
    references: {
      deliveryNoteNumber: 'DN/2026/0912',
      deliveryNoteDate: isoDate('2026-08-19'),
      dispatchDocNumber: 'DSP-4471',
      referenceNumber: 'ABC/REF/2026/77',
      referenceDate: isoDate('2026-08-18'),
      otherReferences: 'Weekly supply contract',
      termsOfDelivery: 'Delivered at the buyer godown',
      paymentTerms: 'Credit, 30 days',
    },
    // Sample text, invented for this walkthrough. A real bill carries the terms the business itself
    // wrote and nothing else — this product never puts words in its mouth.
    terms: 'SAMPLE TERMS, not a real business\u2019s: payment within 30 days.',
    declaration: 'SAMPLE DECLARATION, not a real business\u2019s: the particulars above are true.',
    poReference: 'ABC/PO/2026/188',
    amountPaid: rupees(50000),
    // In real use this comes from the calculator in both languages; the demo renders each file in
    // its own locale below, so it picks the matching sentence.
    declaredRateNotice: null,
    // Issue #134 — the goods go to a cold store, not to the buyer's shop. This is the same delivery
    // party the e-way bill is built from, passed through unchanged.
    shipTo: null,
    // Issue #147 — the mark of the trade. Sharma Fruit Traders sells fruit, so for this walkthrough
    // it has gone and picked the apple. Nothing chose it for them: a business that picks nothing
    // prints no mark, and the bill is complete either way.
    tradeMark: tradeMarkFromLibrary('apple'),
    batchByLineId: { l1: 'AP-2608', l3: 'JU-1912' },
    packagesByLineId: { l1: '70 Boxes', l2: '8 Bundles', l3: '10 Cartons' },
  });

  const outDir = join(process.cwd(), 'tmp', 'invoices');
  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  const jobs: { templateId: string; format: PageFormat; locale: 'en-IN' | 'hi-IN' }[] = [
    // Issue #140 — the boxed India-standard design, first because it is now what a wholesaler gets.
    { templateId: 'india-standard', format: 'A4', locale: 'en-IN' },
    { templateId: 'india-standard', format: 'A4', locale: 'hi-IN' },
    { templateId: 'india-standard', format: 'THERMAL_80MM', locale: 'en-IN' },
    { templateId: 'india-standard', format: 'MOBILE', locale: 'en-IN' },
    { templateId: 'bakery-warm', format: 'THERMAL_80MM', locale: 'en-IN' },
    { templateId: 'counter-thermal', format: 'THERMAL_58MM', locale: 'hi-IN' },
    { templateId: 'services-simple', format: 'A4', locale: 'en-IN' },
  ];

  for (const job of jobs) {
    const template = templateById(job.templateId);
    if (template === undefined) continue;
    const snapshot = captureSnapshot(template, job.locale, '2026-08-29');
    const localised = {
      ...document,
      declaredRateNotice:
        job.locale === 'hi-IN'
          ? 'Is bill ke GST rate aapke business ne tay kiye hain. Humne inhe sarkari notification se nahin jaancha.'
          : 'The GST rates on this bill are the ones your business set. We have not checked them against a government notification.',
    };
    const html = renderInvoice(localised, snapshot, { format: job.format, locale: job.locale });
    const file = join(outDir, `${job.templateId}-${job.format.toLowerCase()}-${job.locale}.html`);
    writeFileSync(file, html, 'utf8');
    written.push(file);
  }

  // Issue #137 — the three marked copies GST asks for, as one document. One press of Print in the
  // browser produces the buyer's copy, the transporter's and the one the business keeps.
  const standard = templateById('india-standard');
  if (standard !== undefined) {
    const file = join(outDir, 'india-standard-three-copies.html');
    writeFileSync(
      file,
      renderInvoiceCopies(document, captureSnapshot(standard, 'en-IN', '2026-09-09'), {
        format: 'A4',
        locale: 'en-IN',
      }),
      'utf8',
    );
    written.push(file);

    // And each copy on its own, for the business that has to send them to three different people.
    for (const { copy, html } of renderInvoiceCopySet(
      document,
      captureSnapshot(standard, 'en-IN', '2026-09-09'),
      { format: 'A4', locale: 'en-IN' },
    )) {
      const each = join(outDir, `india-standard-copy-${copy.toLowerCase()}.html`);
      writeFileSync(each, html, 'utf8');
      written.push(each);
    }
  }

  // Issue #148 — one page with every reserved slot showing at once, so the finished layout can be
  // reviewed as a picture before any provider is connected. Nothing here is filled in: this is
  // exactly what a bill looks like today, with the space blocked out for what is still coming.
  const wholesaleTemplate = templateById('india-standard');
  if (wholesaleTemplate !== undefined) {
    const everySlot = captureSnapshot(
      { ...wholesaleTemplate, optionalFields: [...wholesaleTemplate.optionalFields, 'qr.upi'] },
      'en-IN',
      '2026-08-29',
    );
    const file = join(outDir, 'reserved-slots.html');
    writeFileSync(
      file,
      renderInvoice({ ...document, eInvoice: null }, everySlot, { format: 'A4', locale: 'en-IN' }),
      'utf8',
    );
    written.push(file);
  }

  // Issue #147 — a page showing what a business sees when it looks for its mark: it types what it
  // sells, and gets drawings to choose from. Written out so the search can be looked at rather than
  // taken on trust.
  {
    const searches = ['fruit', 'mithai', 'kapda', 'plastic', 'tyre', 'dawa', 'kirana', 'hardware', 'bakery', 'transport'];
    const sections = searches
      .map((query) => {
        const found = searchTradeMarks(query, 10);
        const pictures = found
          .map((r) => `<figure><div class="pic">${tradeMarkSvg(r.picture, '#1f2933')}</div><figcaption>${r.picture.id}</figcaption></figure>`)
          .join('');
        return `<section><h2>Typed: &ldquo;${query}&rdquo;</h2><div class="row">${pictures}</div></section>`;
      })
      .join('');
    const file = join(outDir, 'trade-marks.html');
    writeFileSync(
      file,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pick the mark of your trade</title>
<style>
 body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2933; background: #f7f7f7; }
 h1 { font-size: 20px; } h2 { font-size: 14px; font-weight: 600; margin: 20px 0 8px; }
 .row { display: flex; flex-wrap: wrap; gap: 10px; }
 figure { margin: 0; width: 96px; background: #fff; border: 1px solid #dcdcdc; border-radius: 6px; padding: 8px; text-align: center; }
 .pic svg { width: 44px; height: 44px; }
 figcaption { font-size: 10px; color: #62707d; margin-top: 6px; overflow-wrap: anywhere; }
 p.note { font-size: 13px; color: #47525d; max-width: 60em; }
</style></head><body>
<h1>Pick the mark of your trade</h1>
<p class="note">${tradeMarkPictures().length} drawings, searched by what a business actually sells. Nothing is chosen for a business: a bill carries a mark only after somebody picks one here, and a bill with no mark is a complete bill.</p>
${sections}
</body></html>`,
      'utf8',
    );
    written.push(file);
  }

  // A hundred-line bill, to show the A4 layout still holds up.
  const longLines = Array.from({ length: 100 }, (_unused, i) => ({
    ...(document.lines[1] as (typeof document.lines)[number]),
    lineId: `long-${i}`,
    description: `Plastic crate, size ${i + 1}`,
  }));
  const longDocument = { ...document, lines: longLines, number: 'INV/26-27/000099' };
  for (const id of ['india-standard']) {
    const template = templateById(id);
    if (template === undefined) continue;
    const snapshot = captureSnapshot(template, 'en-IN', '2026-08-29');
    const file = join(outDir, `${id}-a4-100-items.html`);
    writeFileSync(file, renderInvoice(longDocument, snapshot, { format: 'A4', locale: 'en-IN' }), 'utf8');
    written.push(file);
  }

  console.log(`Bill ${invoice.number} issued for ${document.totals.invoiceValue.minor / 100n} rupees.`);
  console.log(`Tax treatment: ${invoice.pricing?.split}, place of supply ${document.placeOfSupplyStateName}.`);
  console.log(`Rates: declared by the business, not yet checked against a notification.\n`);
  // Issue #147 — what a business actually sees when it goes looking for its mark. The words are
  // the ones a shopkeeper would type, including the Hindi ones.
  console.log('Pictures found for what a business sells:');
  for (const query of ['fruit', 'mithai', 'kapda', 'plastic dana', 'tyre', 'dawa']) {
    const found = searchTradeMarks(query, 5).map((r) => r.picture.id);
    console.log(`  "${query}" -> ${found.join(', ')}`);
  }
  console.log('');
  console.log('Templates suggested for a wholesaler, best first:');
  for (const t of recommendTemplates('WHOLESALE')) console.log(`  - ${t.name['en-IN']} (${t.id})`);
  console.log('\nOpen any of these in a browser. Use the browser’s print dialogue to get a PDF.\n');
  for (const file of written) console.log(`  ${file}`);
};

await main();
