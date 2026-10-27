/**
 * Issue #296 — the composition desk behind the web screen.
 *
 * Three jobs, none of which decides a rule (the rules are in `packages/gst-returns/src/composition.ts`
 * and `packages/gst-calc`):
 *
 *  1. the scheme setting — preview, then apply with the token the preview returned;
 *  2. the quarterly statement (CMP-08): worked out from the bills of supply and notes in the quarter,
 *     approved by a person, and booked to the ledger as tax the business owes;
 *  3. the yearly return (GSTR-4) as a working paper, built from the same four quarters.
 *
 * Booking a statement never edits an earlier one. If a bill is added to a quarter after its statement
 * was approved, the statement says it has changed and approving again books only the difference as a
 * new entry — the earlier entry and its audit trail are untouched.
 */
import { createHash } from 'node:crypto';
import { conflict, forbidden, invalid, isoDate, money, notFound, type CompanyId, type IsoDate } from '@invoice/kernel';
import type { Account, ActorContext, AuditPort, LedgerService, LedgerStore } from '@invoice/ledger';
import {
  buildCmp08, buildGstr4, compositionLimitFor, quarterOf, watchLimit, GST_RETURN_PERMISSIONS,
  type Cmp08, type CompositionDocument, type Gstr4, type Quarter,
} from '@invoice/gst-returns';
import type { SalesInvoice } from '@invoice/sales';
import type { ReturnNote } from '../../../packages/returns/src/model.ts';
import { appClock, appToday } from './app-clock.ts';
import { DurableMap } from './durable.ts';
import { say } from './language.ts';
import {
  applySchemeChange, compositionRateOn, previewSchemeChange, schemeHistoryOf, schemeOn,
  type SchemeContext,
} from './composition-scheme.ts';

type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

export type StatementState = 'NOT_BOOKED' | 'BOOKED' | 'CHANGED_AFTER_BOOKING' | 'FILED';

/** What was booked and filed for one quarter. Append-only: a later booking adds an entry. */
export interface StatementRecord {
  readonly quarterKey: string;
  readonly bookings: readonly { readonly fingerprint: string; readonly amountPaise: string; readonly deltaPaise: string; readonly voucherId: string | null; readonly bookedBy: string; readonly bookedAt: string }[];
  readonly filed: { readonly reference: string; readonly filedOn: IsoDate; readonly recordedBy: string; readonly recordedAt: string } | null;
}

const records = new DurableMap<readonly StatementRecord[]>('composition_statements', (companyId) => companyId);

const recordsOf = (companyId: string): readonly StatementRecord[] => records.get(companyId) ?? [];
export const forgetCompositionStatements = (companyId: string): void => { records.delete(companyId); };

export interface CompositionDeskDeps {
  readonly companyId: CompanyId;
  readonly gstin: string;
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly audit: AuditPort;
  readonly invoices: { list(companyId: CompanyId, filter: { readonly state: 'FINAL' }): Promise<readonly SalesInvoice[]> };
  readonly notes: { list(companyId: CompanyId): Promise<readonly ReturnNote[]> };
  /** Purchase bills posted in the year, with whether their supplier was a registered business. */
  readonly purchases: (companyId: CompanyId, financialYear: string) => Promise<{ readonly registeredPaise: bigint; readonly unregisteredPaise: bigint }>;
  readonly goodsItemCount: (companyId: CompanyId) => number;
}

const SCOPE = GST_RETURN_PERMISSIONS;

const requireAll = (actor: ActorContext, what: string, ...permissions: readonly string[]): void => {
  for (const permission of permissions) {
    if (!actor.permissions.includes(permission)) throw forbidden('COMPOSITION_NOT_ALLOWED_TO', `You are not allowed to ${what}.`);
  }
};

const rupees = (paise: bigint): string => `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const quarterKeyOf = (quarter: Quarter): string => `${quarter.financialYear}-Q${quarter.number}`;

const fingerprintOf = (cmp: Cmp08): string =>
  createHash('sha256').update(JSON.stringify({ q: quarterKeyOf(cmp.quarter), rate: cmp.rateBasisPoints.toString(), total: cmp.totalPayablePaise.toString(), outward: cmp.outwardValuePaise.toString(), docs: [...cmp.documents].sort() })).digest('hex').slice(0, 32);

const view = (cmp: Cmp08) => ({
  quarterKey: quarterKeyOf(cmp.quarter),
  financialYear: cmp.quarter.financialYear,
  quarter: cmp.quarter.number,
  label: cmp.quarter.label,
  from: cmp.quarter.from,
  to: cmp.quarter.to,
  dueDate: cmp.dueDate,
  ratePercent: Number(cmp.rateBasisPoints) / 100,
  outwardValue: cmp.outwardValuePaise.toString(),
  taxableTurnover: cmp.levy.turnoverPaise.toString(),
  centralTax: cmp.levy.centralPaise.toString(),
  stateTax: cmp.levy.statePaise.toString(),
  reverseChargeTax: cmp.reverseChargeTaxPaise.toString(),
  interest: cmp.interestPaise.toString(),
  lateFee: cmp.lateFeePaise.toString(),
  totalPayable: cmp.totalPayablePaise.toString(),
  documentCount: cmp.documents.length,
  notes: cmp.notes.map((note) => say(note)),
});

export class CompositionDesk {
  readonly #deps: CompositionDeskDeps;

  constructor(deps: CompositionDeskDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------------------------------ the setting

  #schemeContext(actor: ActorContext): SchemeContext {
    return {
      companyId: this.#deps.companyId,
      gstin: this.#deps.gstin,
      declaredBy: String(actor.userId),
      goodsItemCount: () => this.#deps.goodsItemCount(this.#deps.companyId),
      billsIssuedSince: async (date) => {
        const invoices = await this.#deps.invoices.list(this.#deps.companyId, { state: 'FINAL' });
        return invoices.filter((invoice) => invoice.documentDate >= date).length;
      },
    };
  }

  async scheme(actor: ActorContext) {
    requireAll(actor, 'see the GST scheme', 'business.settings.read');
    const today = appToday();
    const current = schemeOn(this.#deps.companyId, today);
    const history = schemeHistoryOf(this.#deps.companyId);
    const inForce = [...history].reverse().find((change) => change.effectiveFrom <= today);
    return {
      scheme: current,
      effectiveFrom: inForce?.effectiveFrom ?? null,
      category: inForce?.category ?? null,
      ratePercent: inForce?.rateBasisPoints == null ? null : Number(inForce.rateBasisPoints) / 100,
      rateBasis: inForce?.rateBasis ?? null,
      history: history.map((change) => ({
        scheme: change.scheme, effectiveFrom: change.effectiveFrom, category: change.category,
        ratePercent: change.rateBasisPoints === null ? null : Number(change.rateBasisPoints) / 100,
        declaredBy: change.declaredBy, declaredOn: change.declaredOn, note: change.note,
      })),
      // The legend a composition bill carries, so the screen can show a business what it will print.
      legend: 'Composition taxable person, not eligible to collect tax on supplies',
    };
  }

  async previewScheme(actor: ActorContext, input: Record<string, unknown>) {
    requireAll(actor, 'change the GST scheme', 'business.settings.write');
    const preview = await previewSchemeChange(this.#schemeContext(actor), input);
    return {
      ok: preview.ok,
      token: preview.token,
      blockers: preview.blockers.map((line) => say(line)),
      warnings: preview.warnings.map((line) => say(line)),
      whatChanges: preview.whatChanges.map((line) => say(line)),
      change: preview.change === null ? null : { scheme: preview.change.scheme, effectiveFrom: preview.change.effectiveFrom, category: preview.change.category, ratePercent: preview.change.rateBasisPoints === null ? null : Number(preview.change.rateBasisPoints) / 100 },
    };
  }

  async applyScheme(actor: ActorContext, input: Record<string, unknown>) {
    requireAll(actor, 'change the GST scheme', 'business.settings.write');
    const applied = await applySchemeChange(this.#schemeContext(actor), input);
    if (!applied.deduplicated) {
      await this.#deps.audit.record({
        companyId: this.#deps.companyId,
        actorId: actor.userId,
        at: appClock.now().toISOString(),
        action: 'composition.scheme_changed',
        subjectType: 'company',
        subjectId: String(this.#deps.companyId),
        summary: applied.change.scheme === 'COMPOSITION'
          ? `Moved to the composition scheme from ${applied.change.effectiveFrom} at ${Number(applied.change.rateBasisPoints) / 100}% (${applied.change.category}).`
          : `Left the composition scheme from ${applied.change.effectiveFrom}.`,
        details: {
          scheme: applied.change.scheme, effectiveFrom: applied.change.effectiveFrom, category: applied.change.category ?? '',
          rateBasisPoints: applied.change.rateBasisPoints ?? '', rateBasis: applied.change.rateBasis ?? '', requestId: applied.change.requestId,
        },
      });
    }
    return { deduplicated: applied.deduplicated, ...(await this.scheme(actor)) };
  }

  // ----------------------------------------------------------------------------- the documents

  /** Bills of supply and the notes against them, as the quarterly statement reads them. */
  async documents(): Promise<readonly CompositionDocument[]> {
    const companyId = this.#deps.companyId;
    const invoices = await this.#deps.invoices.list(companyId, { state: 'FINAL' });
    const composition = invoices.filter((invoice) =>
      (invoice.pricing?.supplierRegistration ?? 'REGULAR') === 'COMPOSITION');
    const ids = new Set(composition.map((invoice) => invoice.id));
    const documents: CompositionDocument[] = [];
    for (const invoice of composition) {
      const lines = invoice.pricing?.lines ?? [];
      // Exempt, nil-rated and non-GST lines appear on the form but carry no composition tax.
      const taxable = lines.filter((line) => line.treatment === undefined || line.treatment === 'TAXABLE').reduce((sum, line) => sum + line.taxableValue.minor, 0n);
      const other = lines.reduce((sum, line) => sum + line.taxableValue.minor, 0n) - taxable;
      const number = invoice.number ?? invoice.id;
      if (taxable !== 0n || other === 0n) documents.push({ id: invoice.id, number, date: invoice.documentDate, kind: 'BILL_OF_SUPPLY', valuePaise: taxable, taxable: true });
      if (other !== 0n) documents.push({ id: `${invoice.id}:exempt`, number, date: invoice.documentDate, kind: 'BILL_OF_SUPPLY', valuePaise: other, taxable: false });
    }
    for (const note of await this.#deps.notes.list(companyId)) {
      if (note.kind !== 'SALES_RETURN' && note.kind !== 'SALES_DEBIT_NOTE') continue;
      if (!ids.has(note.originalDocument.id)) continue;
      documents.push({
        id: note.id, number: note.number, date: note.documentDate,
        kind: note.kind === 'SALES_RETURN' ? 'CREDIT_NOTE' : 'DEBIT_NOTE', valuePaise: note.totals.taxableValue.minor, taxable: true,
      });
    }
    return documents;
  }

  // ------------------------------------------------------------------------- the statement

  #statement(documents: readonly CompositionDocument[], quarter: Quarter): Cmp08 {
    const rate = compositionRateOn(this.#deps.companyId, quarter.to);
    // A quarter that ended before the business joined the scheme (or after it left) has no rate.
    const during = rate?.rateBasisPoints ?? compositionRateOn(this.#deps.companyId, quarter.from)?.rateBasisPoints ?? 0n;
    return buildCmp08({ quarter, documents, rateBasisPoints: during });
  }

  #stateOf(cmp: Cmp08): { state: StatementState; booked: bigint; record: StatementRecord | undefined } {
    const record = recordsOf(String(this.#deps.companyId)).find((entry) => entry.quarterKey === quarterKeyOf(cmp.quarter));
    const booked = (record?.bookings ?? []).reduce((sum, booking) => sum + BigInt(booking.deltaPaise), 0n);
    const last = record?.bookings.at(-1);
    const state: StatementState = record?.filed != null ? 'FILED'
      : last === undefined ? 'NOT_BOOKED'
        : last.fingerprint === fingerprintOf(cmp) ? 'BOOKED' : 'CHANGED_AFTER_BOOKING';
    return { state, booked, record };
  }

  #describe(cmp: Cmp08) {
    const { state, booked, record } = this.#stateOf(cmp);
    return {
      ...view(cmp),
      state,
      fingerprint: fingerprintOf(cmp),
      alreadyBooked: booked.toString(),
      stillToBook: (cmp.totalPayablePaise - booked).toString(),
      filed: record?.filed ?? null,
      sentence: say(state === 'FILED'
        ? { 'en-IN': `Filed on ${record!.filed!.filedOn} (${record!.filed!.reference}).`, 'hi-IN': `${record!.filed!.filedOn} को फ़ाइल हुआ (${record!.filed!.reference}).` }
        : state === 'BOOKED'
          ? { 'en-IN': `Approved and written into your books: ${rupees(booked)} owed to the government. File it on the GST portal by ${cmp.dueDate}.`, 'hi-IN': `मंज़ूर और खातों में दर्ज: सरकार को ${rupees(booked)} देना है। ${cmp.dueDate} तक GST पोर्टल पर भरिए।` }
          : state === 'CHANGED_AFTER_BOOKING'
            ? { 'en-IN': `Bills changed after you approved this. ${rupees(booked)} is booked, ${rupees(cmp.totalPayablePaise)} is now due. Approve again to book the difference.`, 'hi-IN': `मंज़ूरी के बाद बिल बदले हैं। ${rupees(booked)} दर्ज है, अब ${rupees(cmp.totalPayablePaise)} बनता है। फ़र्क दर्ज करने के लिए फिर मंज़ूर कीजिए।` }
            : { 'en-IN': `${rupees(cmp.totalPayablePaise)} to pay for ${cmp.quarter.label}, by ${cmp.dueDate}.`, 'hi-IN': `${cmp.quarter.label} के लिए ${rupees(cmp.totalPayablePaise)} भरना है, ${cmp.dueDate} तक।` }),
    };
  }

  /** The quarters worth showing: the one running, and the last four before it. */
  async statements(actor: ActorContext) {
    requireAll(actor, 'see GST returns', SCOPE.view);
    const today = appToday();
    const documents = await this.documents();
    const quarters: Quarter[] = [];
    let cursor = quarterOf(today);
    for (let i = 0; i < 5; i += 1) {
      quarters.push(cursor);
      const before = new Date(`${cursor.from}T00:00:00Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      cursor = quarterOf(isoDate(before.toISOString().slice(0, 10)));
    }
    const scheme = await this.scheme({ ...actor, permissions: [...actor.permissions, 'business.settings.read'] });
    // Where this year's sales stand against the limit (CGST Act s.10(1), (3)).
    const financialYear = quarterOf(today).financialYear;
    const category = [...schemeHistoryOf(this.#deps.companyId)].reverse().find((change) => change.scheme === 'COMPOSITION' && change.effectiveFrom <= today)?.category ?? null;
    const watch = category === null ? null : watchLimit(
      documents.filter((doc) => quarterOf(doc.date).financialYear === financialYear && doc.kind !== 'DEBIT_NOTE' && doc.kind !== 'CREDIT_NOTE')
        .map((doc) => ({ date: doc.date, valuePaise: doc.valuePaise })),
      compositionLimitFor(category, this.#deps.gstin.slice(0, 2)),
    );
    return {
      scheme,
      onComposition: scheme.scheme === 'COMPOSITION' || quarters.some((quarter) => documents.some((doc) => doc.date >= quarter.from && doc.date <= quarter.to)),
      quarters: quarters.map((quarter) => this.#describe(this.#statement(documents, quarter))),
      limit: watch === null ? null : {
        standing: watch.standing, turnover: watch.turnoverPaise.toString(), limit: watch.limitPaise.toString(),
        crossedOn: watch.crossedOn, message: say(watch.message),
      },
    };
  }

  async statement(actor: ActorContext, input: Record<string, unknown>) {
    requireAll(actor, 'see GST returns', SCOPE.view);
    const quarter = this.#quarterFrom(input);
    const documents = await this.documents();
    const cmp = this.#statement(documents, quarter);
    return { ...this.#describe(cmp), documents: documents.filter((doc) => cmp.documents.includes(doc.id)).map((doc) => ({ id: doc.id, number: doc.number, date: doc.date, kind: doc.kind, value: doc.valuePaise.toString(), taxable: doc.taxable })) };
  }

  #quarterFrom(input: Record<string, unknown>): Quarter {
    const key = String(input.quarter ?? '').trim();
    const match = /^(\d{4})-\d{2}-Q([1-4])$/.exec(key);
    if (match === null) throw invalid('COMPOSITION_QUARTER', 'Choose a quarter, like 2026-27-Q1.');
    const start = Number(match[1]);
    const first = [`${start}-04-01`, `${start}-07-01`, `${start}-10-01`, `${start + 1}-01-01`][Number(match[2]) - 1] as string;
    return quarterOf(isoDate(first));
  }

  /**
   * Books the statement: tax the business owes the government, as an expense. Approving again after
   * the quarter's bills changed books only the difference, as a new entry.
   */
  async approveStatement(actor: ActorContext, input: Record<string, unknown>) {
    requireAll(actor, 'approve a GST return', SCOPE.approve);
    const quarter = this.#quarterFrom(input);
    const documents = await this.documents();
    const cmp = this.#statement(documents, quarter);
    const fingerprint = fingerprintOf(cmp);
    if (String(input.token ?? '') === '') throw invalid('COMPOSITION_NOT_CHECKED', 'Please look at the statement first, then approve it.');
    if (String(input.token) !== fingerprint) throw conflict('COMPOSITION_CHANGED_SINCE_CHECK', 'The figures changed after you looked at them. Please look at the statement again before approving.');
    const { state, booked, record } = this.#stateOf(cmp);
    if (state === 'FILED') throw conflict('COMPOSITION_ALREADY_FILED', 'This statement is already filed. A correction goes in a later statement, with your accountant.');
    if (record?.bookings.some((booking) => booking.fingerprint === fingerprint)) return { deduplicated: true, ...(await this.statement(actor, input)) };
    if (cmp.totalPayablePaise === 0n && booked === 0n) {
      throw invalid('COMPOSITION_NOTHING_DUE', 'There is no tax to pay for this quarter, so there is nothing to approve.');
    }
    const delta = cmp.totalPayablePaise - booked;
    let voucherId: string | null = null;
    if (delta !== 0n) {
      const accounts = this.#deps.store.read().accounts;
      const [expense, owed] = await Promise.all([
        accounts.findByCode(this.#deps.companyId, '5900'),
        accounts.findBySystemRole(this.#deps.companyId, 'REVERSE_CHARGE_PAYABLE'),
      ]) as [Account | null, Account | null];
      if (expense === null || owed === null) throw notFound('COMPOSITION_ACCOUNT_MISSING', 'Your books have nowhere to record the composition tax yet.');
      const amount = money(delta < 0n ? -delta : delta);
      const narration = `Composition tax for ${cmp.quarter.label} (CMP-08)${booked !== 0n ? ', change after bills were added' : ''}`;
      const posted = await this.#deps.ledger.postVoucher(actor, {
        idempotencyKey: `composition:cmp08:${quarterKeyOf(quarter)}:${fingerprint}`,
        type: 'JOURNAL',
        date: quarter.to,
        narration,
        source: { kind: 'composition_cmp08', id: `${quarterKeyOf(quarter)}:${fingerprint}`, number: null },
        lines: delta > 0n
          ? [{ accountId: expense.id, debit: amount, credit: money(0n), narration }, { accountId: owed.id, debit: money(0n), credit: amount, narration }]
          : [{ accountId: owed.id, debit: amount, credit: money(0n), narration }, { accountId: expense.id, debit: money(0n), credit: amount, narration }],
      });
      voucherId = String(posted.voucher.id);
    }
    const now = appClock.now().toISOString();
    const entry = { fingerprint, amountPaise: cmp.totalPayablePaise.toString(), deltaPaise: delta.toString(), voucherId, bookedBy: String(actor.userId), bookedAt: now };
    const others = recordsOf(String(this.#deps.companyId)).filter((existing) => existing.quarterKey !== quarterKeyOf(quarter));
    records.set(String(this.#deps.companyId), [...others, { quarterKey: quarterKeyOf(quarter), bookings: [...(record?.bookings ?? []), entry], filed: null }]);
    await this.#deps.audit.record({
      companyId: this.#deps.companyId, actorId: actor.userId, at: now, action: 'composition.cmp08_approved',
      subjectType: 'composition_statement', subjectId: quarterKeyOf(quarter),
      summary: `Approved the composition statement for ${cmp.quarter.label}: ${rupees(cmp.totalPayablePaise)} payable.`,
      details: { fingerprint, payable: cmp.totalPayablePaise.toString(), booked: delta.toString(), voucherId: voucherId ?? '' },
    });
    return { deduplicated: false, ...(await this.statement(actor, input)) };
  }

  /** Records that the statement was filed on the GST portal, with the reference the portal gave. */
  async markFiled(actor: ActorContext, input: Record<string, unknown>) {
    requireAll(actor, 'record a filed GST return', SCOPE.approve);
    const quarter = this.#quarterFrom(input);
    const documents = await this.documents();
    const cmp = this.#statement(documents, quarter);
    const { state, record } = this.#stateOf(cmp);
    if (state === 'FILED') throw conflict('COMPOSITION_ALREADY_FILED', 'This statement is already marked as filed.');
    if (state !== 'BOOKED') throw invalid('COMPOSITION_APPROVE_FIRST', 'Approve the statement before saying it is filed, so the tax is in your books first.');
    const reference = String(input.reference ?? '').trim();
    if (!/^[A-Za-z0-9\-/]{6,40}$/.test(reference)) throw invalid('COMPOSITION_REFERENCE', 'Type the reference the GST portal gave when you filed (letters and digits, at least 6).');
    const filedOn = isoDate(String(input.filedOn ?? appToday()));
    const now = appClock.now().toISOString();
    const others = recordsOf(String(this.#deps.companyId)).filter((existing) => existing.quarterKey !== quarterKeyOf(quarter));
    records.set(String(this.#deps.companyId), [...others, { ...record!, filed: { reference, filedOn, recordedBy: String(actor.userId), recordedAt: now } }]);
    await this.#deps.audit.record({
      companyId: this.#deps.companyId, actorId: actor.userId, at: now, action: 'composition.cmp08_filed',
      subjectType: 'composition_statement', subjectId: quarterKeyOf(quarter),
      summary: `Marked the composition statement for ${cmp.quarter.label} as filed (${reference}).`, details: { reference, filedOn },
    });
    return this.statement(actor, input);
  }

  // ---------------------------------------------------------------------------------- GSTR-4

  async yearly(actor: ActorContext, input: Record<string, unknown>) {
    requireAll(actor, 'see GST returns', SCOPE.view);
    const financialYear = String(input.financialYear ?? quarterOf(appToday()).financialYear).trim();
    if (!/^\d{4}-\d{2}$/.test(financialYear)) throw invalid('COMPOSITION_YEAR', 'Choose a financial year, like 2026-27.');
    const documents = await this.documents();
    const companyId = String(this.#deps.companyId);
    const paid = recordsOf(companyId).filter((entry) => entry.quarterKey.startsWith(`${financialYear}-`))
      .reduce((sum, entry) => sum + entry.bookings.reduce((inner, booking) => inner + BigInt(booking.deltaPaise), 0n), 0n);
    const inward = await this.#deps.purchases(this.#deps.companyId, financialYear);
    const result: Gstr4 = buildGstr4({
      financialYear, documents,
      rateForQuarter: (quarter) => compositionRateOn(companyId, quarter.to)?.rateBasisPoints ?? compositionRateOn(companyId, quarter.from)?.rateBasisPoints ?? 0n,
      // What is booked is what the business owes; the portal payments are the owner's to compare.
      taxPaidPaise: paid,
      inward: { fromRegisteredPaise: inward.registeredPaise, fromUnregisteredPaise: inward.unregisteredPaise },
    });
    return {
      financialYear: result.financialYear,
      dueDate: result.dueDate,
      taxPayable: result.taxPayablePaise.toString(),
      taxBooked: paid.toString(),
      difference: result.differencePaise === null ? null : result.differencePaise.toString(),
      quarters: result.quarters.map((cmp) => this.#describe(cmp)),
      inward: { fromRegistered: result.inward.fromRegisteredPaise.toString(), fromUnregistered: result.inward.fromUnregisteredPaise.toString(), reverseCharge: result.inward.reverseChargePaise.toString() },
      findings: result.findings.map((line) => say(line)),
      notes: result.notes.map((line) => say(line)),
    };
  }
}
