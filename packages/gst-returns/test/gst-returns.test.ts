/**
 * Issue #30 [E30] acceptance criteria, enforced automatically.
 *
 *  - "Every return number traces to source vouchers"
 *  - "Locked/approved periods cannot change silently"
 *  - "Manual export works without production GSP access"
 *
 * plus the tests the issue asks for by name: the four-invoice small-business example, B2B, B2C,
 * note and amendment cases, and book-to-return reconciliation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, asId, fixedClock, isoDate, quantityFromString } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import { B2clThresholdTable, InMemoryDeclaredThresholds } from '../src/thresholds.ts';
import { classifyDocument } from '../src/classify.ts';
import { buildGstr1, sourcesOfSection } from '../src/gstr1.ts';
import { buildGstr3b } from '../src/gstr3b.ts';
import { reconcile } from '../src/reconcile.ts';
import { validateDocuments } from '../src/validate.ts';
import { toGstr1Json, toGstr3bJson } from '../src/json-export.ts';
import { GstReturnService } from '../src/service.ts';
import {
  InMemoryBookTax, InMemoryInwardTax, InMemoryOutwardSupplies, InMemoryPeriodLocks,
  InMemoryReturnPreparations, StaticReturnPolicy, SyntheticGspChannel, salesInvoiceToDocument,
} from '../src/adapters.ts';
import { DEFAULT_RETURN_POLICY } from '../src/ports.ts';
import {
  AMENDMENT_INVOICE, BENGALURU_KIRANA_GSTIN, CN_001, INV_001, INV_002, INV_003, INV_004,
  PUNE_RETAIL_GSTIN, SUNRISE_BOOK_TAX, SUNRISE_COMPANY, SUNRISE_DOCUMENTS, SUNRISE_GSTIN,
  SUNRISE_INWARD, SUNRISE_PERIOD, SUNRISE_STATE, UNRESOLVED_INVOICE,
} from '../src/fixtures.ts';
import { GST_RETURN_PERMISSIONS, taxPeriod, totalTaxOf, type OutwardDocument } from '../src/types.ts';

const CLOCK = fixedClock('2026-08-11T09:30:00.000Z');
const ALL_PERMISSIONS = Object.values(GST_RETURN_PERMISSIONS);

const actorWith = (...permissions: readonly string[]): ActorContext => ({
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: [...permissions],
});

const owner = actorWith(...ALL_PERMISSIONS);
const context = { thresholds: new B2clThresholdTable(), mode: 'development' as const };
const workspaceInput = { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE };

interface Desk {
  readonly service: GstReturnService;
  readonly outward: InMemoryOutwardSupplies;
  readonly books: InMemoryBookTax;
  readonly gsp: SyntheticGspChannel;
  readonly locks: InMemoryPeriodLocks;
  readonly audit: InMemoryAuditPort;
}

const makeDesk = (options: { withGsp?: boolean; policy?: typeof DEFAULT_RETURN_POLICY } = {}): Desk => {
  const outward = new InMemoryOutwardSupplies();
  outward.add(...SUNRISE_DOCUMENTS);
  const inward = new InMemoryInwardTax();
  inward.set(SUNRISE_COMPANY, SUNRISE_INWARD);
  const books = new InMemoryBookTax();
  books.set(SUNRISE_COMPANY, SUNRISE_BOOK_TAX);
  const gsp = new SyntheticGspChannel(() => CLOCK.now().toISOString());
  const locks = new InMemoryPeriodLocks();
  const audit = new InMemoryAuditPort();

  const service = new GstReturnService({
    outward,
    inward,
    books,
    repository: new InMemoryReturnPreparations(),
    audit,
    clock: CLOCK,
    periods: locks,
    policy: new StaticReturnPolicy(options.policy ?? DEFAULT_RETURN_POLICY),
    idFactory: (() => { let n = 0; return () => `prep-${++n}`; })(),
    ...(options.withGsp === false ? {} : { government: gsp }),
  });

  return { service, outward, books, gsp, locks, audit };
};

// ------------------------------------------------------- the four-invoice small business

test('the four-invoice example lands in four different parts of GSTR-1', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const sections = built.return.sections.map((section) => section.id);

  assert.deepEqual(sections, ['B2B', 'B2CL', 'B2CS', 'CDNR']);
  assert.equal(built.unresolved.length, 0);
  assert.equal(built.return.documentCount, 5);
});

test('the month adds up to the figures a person would get off the bills', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const totals = built.return.totals;

  // 50,000 + 10,000 + 1,20,000 + 75,000 less the 5,000 that came back.
  assert.equal(totals.taxableValue.minor, 25_000_000n);
  assert.equal(totals.cgst.minor, 495_000n);
  assert.equal(totals.sgst.minor, 495_000n);
  assert.equal(totals.igst.minor, 3_510_000n);
  assert.equal(totalTaxOf(totals).minor, 4_500_000n);
});

test('the headline sentence is one a shopkeeper can read', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  assert.match(built.return.sentence['en-IN'], /^July 2026: 5 documents worth ₹2,50,000\.00 before tax/);
  assert.match(built.return.sentence['en-IN'], /₹45,000\.00 of GST/);
});

// ------------------------------------------------------- B2B, B2C, notes and amendments

test('a buyer with a GST number is reported bill by bill', () => {
  const decision = classifyDocument(INV_001, context);
  assert.equal(decision.outcome, 'CLASSIFIED');
  assert.equal(decision.outcome === 'CLASSIFIED' && decision.section, 'B2B');
  assert.match(
    decision.outcome === 'CLASSIFIED' ? decision.reason['en-IN'] : '',
    /Pune Retail Stores has a GST number/,
  );
});

test('a consumer in your own state is added into the rate-wise total, with no bill number on the row', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: [INV_002] }, context);
  const b2cs = built.return.sections.find((section) => section.id === 'B2CS');
  assert.ok(b2cs);
  assert.equal(b2cs.rows.length, 1);
  assert.equal(b2cs.rows[0]?.documentNumber, null);
  assert.equal(b2cs.rows[0]?.placeOfSupplyStateCode, '27');
  // The bill is still reachable from the summary row, which is the whole traceability promise.
  assert.deepEqual(b2cs.rows[0]?.sources.map((s) => s.number), ['INV-002']);
});

test('a large sale to a consumer in another state is listed on its own, and a small one is not', () => {
  const large = classifyDocument(INV_003, context);
  assert.equal(large.outcome === 'CLASSIFIED' && large.section, 'B2CL');
  assert.match(large.outcome === 'CLASSIFIED' ? large.reason['en-IN'] : '', /above the ₹1,00,000\.00 limit/);

  const small: OutwardDocument = { ...INV_003, sourceId: 'inv-003-small', invoiceValue: { currency: 'INR', minor: 5_900_000n } };
  const under = classifyDocument(small, context);
  assert.equal(under.outcome === 'CLASSIFIED' && under.section, 'B2CS');
  assert.match(under.outcome === 'CLASSIFIED' ? under.reason['en-IN'] : '', /under the ₹1,00,000\.00 limit/);
});

test('the B2CL limit is effective-dated, so an older month uses the older figure', () => {
  const table = new B2clThresholdTable();
  const older = table.find(SUNRISE_COMPANY, isoDate('2024-05-15'), 'development');
  const newer = table.find(SUNRISE_COMPANY, isoDate('2026-07-15'), 'development');
  assert.equal(older.found && older.threshold.aboveValue.minor, 25_000_000n);
  assert.equal(newer.found && newer.threshold.aboveValue.minor, 10_000_000n);
});

test('in production an unreviewed limit is refused, and the bill becomes a question in plain words', () => {
  const strict = { thresholds: new B2clThresholdTable(), mode: 'production' as const };
  const decision = classifyDocument(INV_003, strict);
  assert.equal(decision.outcome, 'UNRESOLVED');
  assert.equal(decision.findings[0]?.code, 'GSTR1_THRESHOLD_NOT_REVIEWED');
  assert.match(decision.findings[0]?.whatToDo['en-IN'] ?? '', /The app will not choose between the two tables on its own/);
});

test("a business may set the limit itself, and the return says whose figure it is", () => {
  const declared = new InMemoryDeclaredThresholds();
  declared.declare({
    companyId: SUNRISE_COMPANY,
    aboveValue: { currency: 'INR', minor: 10_000_000n },
    effectiveFrom: isoDate('2026-04-01'),
    effectiveTo: null,
    declaredBy: 'Anita, the accountant',
    declaredOn: isoDate('2026-04-02'),
    basis: 'Told to us by our chartered accountant',
  });
  const decision = classifyDocument(INV_003, {
    thresholds: new B2clThresholdTable(undefined, declared),
    mode: 'production',
  });
  assert.equal(decision.outcome === 'CLASSIFIED' && decision.section, 'B2CL');
  const note = decision.outcome === 'CLASSIFIED' ? decision.findings.find((f) => f.code === 'GSTR1_THRESHOLD_BUSINESS_DECLARED') : undefined;
  assert.ok(note);
  assert.match(note.message['en-IN'], /Anita, the accountant entered it/);
});

test('a threshold a business declares must say who set it and where it came from', () => {
  const declared = new InMemoryDeclaredThresholds();
  assert.throws(
    () => declared.declare({
      companyId: SUNRISE_COMPANY,
      aboveValue: { currency: 'INR', minor: 10_000_000n },
      effectiveFrom: isoDate('2026-04-01'),
      effectiveTo: null,
      declaredBy: '   ',
      declaredOn: isoDate('2026-04-02'),
      basis: 'somebody said so',
    }),
    (error: unknown) => error instanceof DomainError && error.code === 'DECLARED_THRESHOLD_NO_AUTHOR',
  );
});

test('a credit note reduces the month and sits with the notes to registered buyers', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: [INV_001, CN_001] }, context);
  const cdnr = built.return.sections.find((section) => section.id === 'CDNR');
  assert.ok(cdnr);
  assert.equal(cdnr.totals.taxableValue.minor, -500_000n);
  assert.equal(cdnr.totals.cgst.minor, -45_000n);
  // The B2B side is untouched: the note reduces the return, it does not edit the bill.
  const b2b = built.return.sections.find((section) => section.id === 'B2B');
  assert.equal(b2b?.totals.taxableValue.minor, 5_000_000n);
});

test('a correction to a month already filed goes in the corrections table and names the month', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: [AMENDMENT_INVOICE] }, context);
  const amendments = built.return.sections.find((section) => section.id === 'B2BA');
  assert.ok(amendments);
  assert.equal(amendments.rows[0]?.amendmentOf?.period, '2026-06');
  assert.equal(amendments.rows[0]?.amendmentOf?.number, 'INV-JUN-014');
  // And it is not in the ordinary B2B table, which would report the sale twice.
  assert.equal(built.return.sections.find((section) => section.id === 'B2B'), undefined);
});

test('a note against a bill from an earlier month is pointed out without blocking anything', () => {
  const note: OutwardDocument = {
    ...CN_001,
    originalDocument: { number: 'INV-JUN-014', date: isoDate('2026-06-14') },
  };
  const findings = validateDocuments({
    period: SUNRISE_PERIOD, supplierGstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE, documents: [note],
  });
  const found = findings.find((finding) => finding.code === 'GSTR1_NOTE_AGAINST_EARLIER_MONTH');
  assert.ok(found);
  assert.equal(found.severity, 'INFORMATION');
});

// ------------------------------------------------------- never guessing

test('a customer with no GST number that nobody confirmed becomes a question, not a B2C sale', () => {
  const decision = classifyDocument(UNRESOLVED_INVOICE, context);
  assert.equal(decision.outcome, 'UNRESOLVED');
  assert.equal(decision.findings[0]?.code, 'GSTR1_GSTIN_NOT_CONFIRMED');
  assert.match(decision.findings[0]?.whatToDo['en-IN'] ?? '', /the difference cannot be guessed/);
});

test('a bill with no place of supply stops the return rather than being assumed local', () => {
  const decision = classifyDocument({ ...INV_001, placeOfSupplyStateCode: null }, context);
  assert.equal(decision.outcome, 'UNRESOLVED');
  assert.equal(decision.findings[0]?.code, 'GSTR1_NO_PLACE_OF_SUPPLY');
});

test('every question about a document is asked at once, not one at a time', () => {
  const decision = classifyDocument(
    { ...UNRESOLVED_INVOICE, placeOfSupplyStateCode: null, lines: [] },
    context,
  );
  assert.equal(decision.outcome, 'UNRESOLVED');
  assert.deepEqual(
    decision.findings.map((finding) => finding.code).sort(),
    ['GSTR1_GSTIN_NOT_CONFIRMED', 'GSTR1_NO_LINES', 'GSTR1_NO_PLACE_OF_SUPPLY'],
  );
});

test('an out-of-state bill charged local tax is refused before it can be filed', () => {
  const wrong: OutwardDocument = { ...INV_003, lines: INV_001.lines };
  const findings = validateDocuments({
    period: SUNRISE_PERIOD, supplierGstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE, documents: [wrong],
  });
  const found = findings.find((finding) => finding.code === 'GSTR1_SPLIT_SHOULD_BE_IGST');
  assert.ok(found);
  assert.equal(found.severity, 'BLOCKING');
  assert.match(found.whatToDo['en-IN'], /your buyer cannot claim the credit/);
});

test('two bills sharing a number are refused', () => {
  const findings = validateDocuments({
    period: SUNRISE_PERIOD,
    supplierGstin: SUNRISE_GSTIN,
    supplierStateCode: SUNRISE_STATE,
    documents: [INV_001, { ...INV_001, sourceId: 'inv-001-again' }],
  });
  assert.ok(findings.some((finding) => finding.code === 'GSTR1_DUPLICATE_NUMBER'));
});

// ------------------------------------------------------- acceptance criterion 1: traceability

test('every figure on the return can be walked back to the bills behind it', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  for (const section of built.return.sections) {
    for (const row of section.rows) {
      assert.ok(row.sources.length > 0, `${section.id} has a row with no source documents`);
      for (const source of row.sources) {
        assert.ok(source.voucherId !== null, `${source.number} does not name a ledger voucher`);
      }
    }
  }
  const b2b = built.return.sections.find((section) => section.id === 'B2B');
  assert.deepEqual(sourcesOfSection(b2b!).map((source) => source.number), ['INV-001', 'INV-004']);
});

test('the code-wise summary keeps its sources too, and says so when a code is missing', () => {
  const built = buildGstr1(
    { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: [INV_001, { ...INV_002, sourceId: 'inv-002-nohsn', lines: [{ ...INV_002.lines[0]!, hsnOrSac: null }] }] },
    context,
  );
  assert.equal(built.return.hsn.length, 1);
  assert.equal(built.return.hsn[0]?.hsnOrSac, '3401');
  assert.ok(built.findings.some((finding) => finding.code === 'GSTR1_HSN_MISSING'));
});

// ------------------------------------------------------- book-to-return reconciliation

test('the return and the books agree on the four-invoice month', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const result = reconcile({
    period: SUNRISE_PERIOD,
    returnTotals: built.return.totals,
    books: SUNRISE_BOOK_TAX,
    returnSources: SUNRISE_DOCUMENTS.map((document) => ({
      sourceKind: document.sourceKind, sourceId: document.sourceId, number: document.number,
      date: document.documentDate, voucherId: document.voucherId, amount: document.invoiceValue,
    })),
  });
  assert.equal(result.agrees, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.sentence['en-IN'], /both show ₹45,000\.00 of GST on sales/);
});

test('a sale posted straight into the accounts is caught, and the difference points the right way', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const result = reconcile({
    period: SUNRISE_PERIOD,
    returnTotals: built.return.totals,
    books: {
      ...SUNRISE_BOOK_TAX,
      igst: { currency: 'INR', minor: SUNRISE_BOOK_TAX.igst.minor + 90_000n },
      contributions: [
        ...SUNRISE_BOOK_TAX.contributions,
        { sourceKind: 'journal', sourceId: 'jv-9', number: 'JV-9', date: isoDate('2026-07-31'), voucherId: 'vch-jv-9', amount: { currency: 'INR', minor: 90_000n } },
      ],
    },
    returnSources: SUNRISE_DOCUMENTS.map((document) => ({
      sourceKind: document.sourceKind, sourceId: document.sourceId, number: document.number,
      date: document.documentDate, voucherId: document.voucherId, amount: document.invoiceValue,
    })),
  });
  assert.equal(result.agrees, false);
  const igst = result.heads.find((head) => head.head === 'IGST');
  assert.equal(igst?.difference.minor, -90_000n);
  assert.match(result.findings[0]?.whatToDo['en-IN'] ?? '', /entered straight into the accounts as a journal/);
  assert.deepEqual(result.unexplainedVouchers.map((voucher) => voucher.number), ['JV-9']);
});

test('a difference under a rupee per head is rounding, not a missing sale', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const result = reconcile({
    period: SUNRISE_PERIOD,
    returnTotals: built.return.totals,
    books: { ...SUNRISE_BOOK_TAX, cgst: { currency: 'INR', minor: SUNRISE_BOOK_TAX.cgst.minor + 40n } },
    returnSources: [],
  });
  assert.equal(result.agrees, true);
});

// ------------------------------------------------------- GSTR-3B

test('GSTR-3B is built from the same documents as GSTR-1, so the two cannot disagree', () => {
  const gstr1 = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const gstr3b = buildGstr3b({
    period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE,
    documents: SUNRISE_DOCUMENTS, inward: SUNRISE_INWARD,
  });
  const taxable = gstr3b.outward.find((entry) => entry.boxId === '3.1(a)');
  assert.equal(taxable?.amounts.taxableValue.minor, gstr1.return.totals.taxableValue.minor);
  assert.equal(taxable?.amounts.igst.minor, gstr1.return.totals.igst.minor);
});

test('3B shows what is owed and what credit there is, head by head, and does not net them across heads', () => {
  const gstr3b = buildGstr3b({
    period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE,
    documents: SUNRISE_DOCUMENTS, inward: SUNRISE_INWARD,
  });
  const cgst = gstr3b.heads.find((head) => head.head === 'CGST');
  const igst = gstr3b.heads.find((head) => head.head === 'IGST');
  assert.equal(cgst?.liability.minor, 495_000n);
  assert.equal(cgst?.credit.minor, 540_000n);
  assert.equal(cgst?.difference.minor, -45_000n);
  assert.equal(igst?.difference.minor, 3_510_000n);
  assert.match(gstr3b.caution['en-IN'], /part of that order is your choice/);
});

test('3B names each other state the business sold into without a GST number', () => {
  const gstr3b = buildGstr3b({
    period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE,
    documents: SUNRISE_DOCUMENTS, inward: SUNRISE_INWARD,
  });
  assert.deepEqual(gstr3b.interStateToUnregistered.map((entry) => entry.stateCode), ['24']);
  assert.equal(gstr3b.interStateToUnregistered[0]?.igst.minor, 2_160_000n);
});

// ------------------------------------------------------- acceptance criterion 3: manual export

test('a business with no licensed intermediary can still prepare, approve and export', async () => {
  const desk = makeDesk({ withGsp: false });
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);
  const file = await desk.service.exportFile(owner, { ...workspaceInput, returnType: 'GSTR1' });

  assert.equal(file.fileName, `gstr1_${SUNRISE_GSTIN}_072026.json`);
  assert.match(file.sentence['en-IN'], /Nothing has been sent from here/);
  await assert.rejects(
    desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' }),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_NO_CHANNEL',
  );
});

test('the exported file carries the government field names and the bills inside them', () => {
  const built = buildGstr1({ period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, documents: SUNRISE_DOCUMENTS }, context);
  const file = toGstr1Json(built.return);

  assert.equal(file['gstin'], SUNRISE_GSTIN);
  assert.equal(file['fp'], '072026');

  const b2b = file['b2b'] as { ctin: string; inv: { inum: string; val: number; itms: { itm_det: { rt: number; txval: number; camt: number } }[] }[] }[];
  const pune = b2b.find((entry) => entry.ctin === PUNE_RETAIL_GSTIN);
  assert.equal(pune?.inv[0]?.inum, 'INV-001');
  assert.equal(pune?.inv[0]?.val, 59000);
  assert.equal(pune?.inv[0]?.itms[0]?.itm_det.rt, 18);
  assert.equal(pune?.inv[0]?.itms[0]?.itm_det.txval, 50000);
  assert.equal(pune?.inv[0]?.itms[0]?.itm_det.camt, 4500);
  assert.ok(b2b.some((entry) => entry.ctin === BENGALURU_KIRANA_GSTIN));

  const b2cl = file['b2cl'] as { pos: string; inv: { inum: string }[] }[];
  assert.equal(b2cl[0]?.pos, '24');
  assert.equal(b2cl[0]?.inv[0]?.inum, 'INV-003');

  // A credit note goes out as a positive amount with its direction in `ntty`, as the portal wants.
  const cdnr = file['cdnr'] as { nt: { ntty: string; nt_num: string; itms: { itm_det: { txval: number } }[] }[] }[];
  assert.equal(cdnr[0]?.nt[0]?.ntty, 'C');
  assert.equal(cdnr[0]?.nt[0]?.itms[0]?.itm_det.txval, 5000);
});

test('the 3B file carries the boxes the portal reads, and no payment box', () => {
  const gstr3b = buildGstr3b({
    period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE,
    documents: SUNRISE_DOCUMENTS, inward: SUNRISE_INWARD,
  });
  const file = toGstr3bJson(gstr3b);
  const supply = file['sup_details'] as { osup_det: { txval: number; iamt: number } };
  assert.equal(supply.osup_det.txval, 250000);
  assert.equal(supply.osup_det.iamt, 35100);
  assert.equal(file['ret_period'], '072026');
  assert.equal((file as Record<string, unknown>)['tx_pmt'], undefined);
});

test('a return that has not been approved cannot be exported', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await assert.rejects(
    desk.service.exportFile(owner, { ...workspaceInput, returnType: 'GSTR1' }),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_NOT_APPROVED',
  );
});

// ------------------------------------------------------- acceptance criterion 2: no silent change

test('the books moving after approval is reported, and the approved figures do not change', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  const approved = await desk.service.approve(owner, workspaceInput);
  const approvedTotal = approved.gstr1.totals.taxableValue.minor;

  // Somebody raises another bill for July after the return was signed off.
  desk.outward.add({ ...INV_002, sourceId: 'inv-006', number: 'INV-006', voucherId: 'vch-inv-006' });

  const after = await desk.service.workspace(owner, workspaceInput);
  assert.ok(after.drift !== null);
  assert.deepEqual(after.drift?.documentsAdded.map((document) => document.number), ['INV-006']);
  assert.equal(after.gstr1.totals.taxableValue.minor, approvedTotal, 'the approved figures were changed underneath the approval');
  assert.ok(after.findings.some((finding) => finding.code === 'GST_RETURN_BOOKS_MOVED_AFTER_APPROVAL'));
});

test('an edit to an existing bill after approval is noticed too', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);

  desk.outward.replace('inv-001', { ...INV_001, lines: [{ ...INV_001.lines[0]!, amounts: { ...INV_001.lines[0]!.amounts, taxableValue: { currency: 'INR', minor: 6_000_000n } } }] });

  const after = await desk.service.workspace(owner, workspaceInput);
  assert.deepEqual(after.drift?.documentsChanged.map((document) => document.number), ['INV-001']);
});

test('a return cannot be prepared over an approval, and reopening needs a reason', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);

  await assert.rejects(
    desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-2' }),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_ALREADY_APPROVED',
  );
  await assert.rejects(
    desk.service.reopen(owner, SUNRISE_PERIOD, '   '),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_REOPEN_NEEDS_REASON',
  );

  const reopened = await desk.service.reopen(owner, SUNRISE_PERIOD, 'A July bill turned up in August.');
  assert.equal(reopened.state, 'DRAFT');
  assert.equal(reopened.approval, null);
});

test('a filed return is corrected by an amendment, not by being reopened', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);
  await desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' });

  await assert.rejects(
    desk.service.reopen(owner, SUNRISE_PERIOD, 'we changed our minds'),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_ALREADY_FILED',
  );
});

test('a return with an unanswered question cannot be approved', async () => {
  const desk = makeDesk();
  desk.outward.add(UNRESOLVED_INVOICE);
  const prepared = await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });

  assert.equal(prepared.state, 'NEEDS_ATTENTION');
  assert.equal(prepared.exceptions.length, 1);
  assert.equal(prepared.exceptions[0]?.document.number, 'INV-005');
  await assert.rejects(
    desk.service.approve(owner, workspaceInput),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_NOT_APPROVABLE',
  );
});

test('a return whose books disagree cannot be approved either', async () => {
  const desk = makeDesk();
  desk.books.set(SUNRISE_COMPANY, { ...SUNRISE_BOOK_TAX, igst: { currency: 'INR', minor: 9_999_900n } });
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await assert.rejects(
    desk.service.approve(owner, workspaceInput),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_NOT_APPROVABLE',
  );
});

test('a business that asks for closed months first is refused while the month is open', async () => {
  const desk = makeDesk({ policy: { ...DEFAULT_RETURN_POLICY, requireClosedPeriod: true } });
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  const workspace = await desk.service.workspace(owner, workspaceInput);
  assert.equal(workspace.mayApprove, false);
  assert.match(workspace.whyNotApprovable[0]?.['en-IN'] ?? '', /still open in your books/);

  desk.locks.set(SUNRISE_COMPANY, SUNRISE_PERIOD, 'SOFT_LOCKED');
  const approved = await desk.service.approve(owner, workspaceInput);
  assert.equal(approved.state, 'APPROVED');
});

// ------------------------------------------------------- permissions, retries, audit

test('preparing, approving, exporting and submitting are four separate permissions', async () => {
  const desk = makeDesk();
  const viewer = actorWith(GST_RETURN_PERMISSIONS.view);
  await assert.rejects(
    desk.service.prepare(viewer, { ...workspaceInput, idempotencyKey: 'july-1' }),
    (error: unknown) => error instanceof DomainError && error.code === 'GST_RETURN_FORBIDDEN',
  );
  // Viewing is allowed, and shows the whole workspace without writing anything.
  const workspace = await desk.service.workspace(viewer, workspaceInput);
  assert.equal(workspace.preparation, null);
  assert.equal(workspace.gstr1.documentCount, 5);
});

test('pressing prepare twice does not take two photographs of the month', async () => {
  const desk = makeDesk();
  const first = await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  const second = await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  assert.equal(first.snapshot.fingerprint, second.snapshot.fingerprint);
  assert.equal((await desk.service.list(owner)).length, 1);
});

test('a retry after a timeout files once, not twice', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);

  desk.gsp.willTimeOut();
  const first = await desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' });
  assert.equal(first.submission?.outcome, 'UNKNOWN');
  assert.equal(first.state, 'SUBMITTING', 'a timeout must not be recorded as a failure');
  assert.match(first.submission?.message ?? '', /We do not know whether this was filed/);

  desk.gsp.willAccept();
  const second = await desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' });
  assert.equal(second.state, 'FILED');
  const third = await desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' });
  assert.equal(third.state, 'FILED');
  assert.equal(desk.gsp.filings().length, 1);
});

test("a rejection keeps the government's own words and files nothing", async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);
  desk.gsp.willReject([{ code: 'RET191113', detail: 'Invalid GSTIN in B2B section' }]);

  const result = await desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' });
  assert.equal(result.state, 'SUBMISSION_FAILED');
  assert.equal(result.submission?.errors[0]?.code, 'RET191113');
  assert.equal(result.submission?.reference, null);
});

test('filing softly locks the month in the books so nothing drifts under a filed return', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, workspaceInput);
  await desk.service.submit(owner, { ...workspaceInput, returnType: 'GSTR1' });
  assert.equal(await desk.locks.stateOf(SUNRISE_COMPANY, isoDate('2026-07-31')), 'SOFT_LOCKED');
});

test('every material step is recorded with its actor, without any payload in the trail', async () => {
  const desk = makeDesk();
  await desk.service.prepare(owner, { ...workspaceInput, idempotencyKey: 'july-1' });
  await desk.service.approve(owner, { ...workspaceInput, note: 'Checked against the sales register.' });
  await desk.service.exportFile(owner, { ...workspaceInput, returnType: 'GSTR1' });

  const actions = desk.audit.events.map((event) => event.action);
  assert.deepEqual(actions, ['gst_return.prepared', 'gst_return.approved', 'gst_return.exported']);
  for (const event of desk.audit.events) {
    assert.equal(event.actorId, owner.userId);
    assert.equal(event.subjectType, 'gst_return');
    assert.equal(event.subjectId, '2026-07:GSTR1');
    assert.ok(!JSON.stringify(event.details).includes('itm_det'), 'the audit trail must not carry the filing payload');
  }
});

// ------------------------------------------------------- the adapter over the sales module

test('a sales invoice that is not final is refused rather than reported', () => {
  assert.throws(
    () => salesInvoiceToDocument(
      { id: 'x', companyId: SUNRISE_COMPANY, state: 'DRAFT', number: null, documentDate: '2026-07-05', partyId: 'p', customerType: 'B2B', placeOfSupplyStateCode: '27', voucherId: null, pricing: null },
      { name: 'Somebody', gstin: null, stateCode: '27', unregisteredConfirmed: false },
      { gstin: SUNRISE_GSTIN, stateCode: SUNRISE_STATE },
    ),
    (error: unknown) => error instanceof DomainError && error.code === 'GSTR1_SOURCE_NOT_FINAL',
  );
});

test('union-territory tax is folded into the state column, because the form has no other', () => {
  const document = salesInvoiceToDocument(
    {
      id: 'inv-ut', companyId: SUNRISE_COMPANY, state: 'FINAL', number: 'INV-UT', documentDate: '2026-07-05',
      partyId: 'p', customerType: 'B2C', placeOfSupplyStateCode: '04', voucherId: 'vch-ut',
      pricing: {
        lines: [{
          lineId: 'l1', itemId: 'SOAP', itemName: 'Soap', hsnOrSac: '3401', quantity: quantityFromString('10', 'PCS'),
          ratePercentTimes100: 1800n,
          taxableValue: { currency: 'INR', minor: 100_000n },
          cgst: { currency: 'INR', minor: 9_000n },
          sgst: { currency: 'INR', minor: 0n },
          utgst: { currency: 'INR', minor: 9_000n },
          igst: { currency: 'INR', minor: 0n },
          cess: { currency: 'INR', minor: 0n },
          reverseCharge: false, rateBasis: 'BUSINESS_DECLARED',
        }],
        totals: { invoiceValue: { currency: 'INR', minor: 118_000n } },
      },
    },
    { name: 'Chandigarh customer', gstin: null, stateCode: '04', unregisteredConfirmed: true },
    { gstin: SUNRISE_GSTIN, stateCode: SUNRISE_STATE },
  );
  assert.equal(document.lines[0]?.amounts.sgst.minor, 9_000n);
});

test('a nil-rated bill is reported as nil-rated, not as an ordinary sale taxed at nothing', () => {
  const nilLine = {
    lineId: 'l1', itemId: 'SOAP', itemName: 'Soap', hsnOrSac: '3401', quantity: quantityFromString('10', 'PCS'),
    ratePercentTimes100: null,
    taxableValue: { currency: 'INR' as const, minor: 50_000n },
    cgst: { currency: 'INR' as const, minor: 0n }, sgst: { currency: 'INR' as const, minor: 0n },
    utgst: { currency: 'INR' as const, minor: 0n }, igst: { currency: 'INR' as const, minor: 0n },
    cess: { currency: 'INR' as const, minor: 0n },
    reverseCharge: false, rateBasis: null, treatment: 'NIL_RATED' as const,
  };
  const document = salesInvoiceToDocument(
    {
      id: 'inv-nil', companyId: SUNRISE_COMPANY, state: 'FINAL', number: 'INV-NIL', documentDate: '2026-07-05',
      partyId: 'p', customerType: 'B2B', placeOfSupplyStateCode: '27', voucherId: 'vch-nil',
      pricing: { lines: [nilLine], totals: { invoiceValue: { currency: 'INR', minor: 50_000n } } },
    },
    { name: 'Pune Retail Stores', gstin: PUNE_RETAIL_GSTIN, stateCode: '27', unregisteredConfirmed: false },
    { gstin: SUNRISE_GSTIN, stateCode: SUNRISE_STATE },
  );
  assert.equal(document.treatment, 'NIL_RATED');
  const decision = classifyDocument(document, context);
  assert.equal(decision.outcome === 'CLASSIFIED' && decision.section, 'NIL');
});

test('an item nobody has classified stops the return rather than being reported as taxable', () => {
  assert.throws(
    () => salesInvoiceToDocument(
      {
        id: 'inv-x', companyId: SUNRISE_COMPANY, state: 'FINAL', number: 'INV-X', documentDate: '2026-07-05',
        partyId: 'p', customerType: 'B2B', placeOfSupplyStateCode: '27', voucherId: 'vch-x',
        pricing: {
          lines: [{
            lineId: 'l1', itemId: 'MYSTERY', itemName: 'Something', hsnOrSac: null, quantity: quantityFromString('1', 'NOS'),
            ratePercentTimes100: null,
            taxableValue: { currency: 'INR', minor: 10_000n }, cgst: { currency: 'INR', minor: 0n },
            sgst: { currency: 'INR', minor: 0n }, utgst: { currency: 'INR', minor: 0n },
            igst: { currency: 'INR', minor: 0n }, cess: { currency: 'INR', minor: 0n },
            reverseCharge: false, rateBasis: null, treatment: 'UNKNOWN',
          }],
          totals: { invoiceValue: { currency: 'INR', minor: 10_000n } },
        },
      },
      { name: 'Pune Retail Stores', gstin: PUNE_RETAIL_GSTIN, stateCode: '27', unregisteredConfirmed: false },
      { gstin: SUNRISE_GSTIN, stateCode: SUNRISE_STATE },
    ),
    (error: unknown) => error instanceof DomainError && error.code === 'GSTR1_SOURCE_UNCLASSIFIED',
  );
});

// ------------------------------------------------------- periods

test('a tax period is a real month, written the way a person reads it', () => {
  assert.throws(() => taxPeriod('2026-13'), RangeError);
  assert.equal(taxPeriod('2026-07'), '2026-07');
});
