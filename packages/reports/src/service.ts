/**
 * Issue #35 [E35] — the way a screen asks for a report.
 *
 * Two things are true of this service and are meant to stay true:
 *
 *  1. **It cannot post anything.** Its only ledger dependency is `LedgerStore.read()`, which hands
 *     back a read-only unit of work. There is no path from here to a write, which is the issue's
 *     stated non-goal held up by construction rather than by discipline.
 *  2. **The company is never an argument.** It comes from the authenticated actor every time, so
 *     one business's figures cannot be asked for from another's session even by mistake.
 */
import {
  compareDates,
  invalid,
  type Clock,
  type CompanyId,
  type IsoDate,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerStore, PermissionPort } from '@invoice/ledger';
import type { InventoryStore, StockMasterData, StockMovement } from '@invoice/inventory';
import type { SalesRepository } from '@invoice/sales';
import {
  REPORT_PERMISSIONS,
  describeFilter,
  snapshotIdOf,
  type Bilingual,
  type Report,
  type ReportFilter,
  type ReportHeader,
  type ReportId,
} from './model.ts';
import { loadBooks, type LoadedBooks } from './source.ts';
import { balanceSheetBody, profitAndLossBody, trialBalanceBody, type BalanceSheetBody, type ProfitAndLossBody, type TrialBalanceBody } from './financial.ts';
import { purchaseRegister, salesRegister, type RegisterBody } from './registers.ts';
import { stockReportBody, type StockBody } from './stock.ts';
import { ageingBody, type AgeingBody } from './dues.ts';
import { gstSummaryBody, type GstSummaryBody } from './gst.ts';
import { exceptionsBody, type ExceptionsBody } from './exceptions.ts';
import { nameOr, type DuesReadPort, type PurchaseReadPort, type ReportNames } from './ports.ts';

export interface ReportServiceDeps {
  readonly store: LedgerStore;
  readonly sales: SalesRepository;
  readonly inventory: InventoryStore;
  readonly stockMasterData: StockMasterData;
  readonly dues: DuesReadPort;
  readonly purchases: PurchaseReadPort;
  readonly names: ReportNames;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
}

const TITLES: Record<ReportId, Bilingual> = {
  trial_balance: { 'en-IN': 'Do the books hold together?', 'hi-IN': 'Kya books ka hisaab mil raha hai?' },
  profit_and_loss: { 'en-IN': 'What you earned and what you spent', 'hi-IN': 'Kitna kamaya aur kitna kharch hua' },
  balance_sheet: { 'en-IN': 'What the business owns and owes', 'hi-IN': 'Business ke paas kya hai aur kya dena hai' },
  sales_register: { 'en-IN': 'Every bill you gave out', 'hi-IN': 'Aapke diye hue saare bill' },
  purchase_register: { 'en-IN': 'Every bill you received', 'hi-IN': 'Aapko mile hue saare bill' },
  stock: { 'en-IN': 'What is left in the godown', 'hi-IN': 'Godown mein kya bacha hai' },
  ageing: { 'en-IN': 'Who owes money, and for how long', 'hi-IN': 'Kiska paisa baaki hai, aur kab se' },
  gst_summary: { 'en-IN': 'GST you collected and GST you paid', 'hi-IN': 'Aapne jo GST liya aur jo diya' },
  exceptions: { 'en-IN': 'Things worth a second look', 'hi-IN': 'Dobara dekhne layak cheezein' },
};

/** Everything an owner opens at once: the whole month, on one screen. */
export interface ReportPack {
  readonly trialBalance: Report<TrialBalanceBody>;
  readonly profitAndLoss: Report<ProfitAndLossBody>;
  readonly balanceSheet: Report<BalanceSheetBody>;
  readonly sales: Report<RegisterBody>;
  readonly purchases: Report<RegisterBody>;
  readonly stock: Report<StockBody>;
  readonly receivables: Report<AgeingBody>;
  readonly payables: Report<AgeingBody>;
  readonly gst: Report<GstSummaryBody>;
  readonly exceptions: Report<ExceptionsBody>;
}

export class ReportService {
  readonly #deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this.#deps = deps;
  }

  async #checked(actor: ActorContext, permission: string, reportId: ReportId, filter: ReportFilter): Promise<CompanyId> {
    this.#deps.permissions.require(actor, permission, `look at ${reportId.replace(/_/g, ' ')}`);
    if (compareDates(filter.from, filter.to) > 0) {
      throw invalid('REPORT_RANGE_INVALID', 'The closing date is before the opening date, so there is no period to report on.');
    }
    const settings = await this.#deps.store.read().settings.get(actor.companyId);
    if (settings !== null && compareDates(filter.to, settings.booksStartDate) < 0) {
      throw invalid(
        'REPORT_RANGE_BEFORE_BOOKS',
        'Your books here start after the dates you asked for, so nothing was recorded in that period.',
        { details: { booksStartDate: settings.booksStartDate, askedUpTo: filter.to } },
      );
    }
    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#deps.clock.now().toISOString(),
      action: 'reports.viewed',
      subjectType: 'report',
      subjectId: reportId,
      summary: `Looked at ${reportId.replace(/_/g, ' ')}`,
      // The filter, never the figures. An audit trail records what was asked, not the business's money.
      details: {
        from: filter.from,
        to: filter.to,
        branch: filter.branchId === undefined ? 'all' : (filter.branchId ?? 'none'),
      },
    });
    return actor.companyId;
  }

  #header(reportId: ReportId, actor: ActorContext, filter: ReportFilter, notes: readonly Bilingual[], asAt: string): ReportHeader {
    const branchName =
      filter.branchId === undefined || filter.branchId === null
        ? null
        : nameOr(this.#deps.names.branch(actor.companyId, filter.branchId), filter.branchId);
    return {
      reportId,
      title: TITLES[reportId],
      companyId: actor.companyId,
      filter,
      asAt,
      snapshotId: snapshotIdOf(reportId, filter, asAt),
      notes: [describeFilter(filter, branchName), ...notes],
    };
  }

  async #books(companyId: CompanyId, filter: ReportFilter): Promise<LoadedBooks> {
    return loadBooks(this.#deps.store.read(), companyId, filter);
  }

  async trialBalance(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<TrialBalanceBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.financial, 'trial_balance', filter);
    const body = trialBalanceBody(await this.#books(companyId, filter));
    const notes: Bilingual[] = body.balanced
      ? []
      : [
          {
            'en-IN': 'The two sides do not add up to the same figure. Nothing else in this pack can be relied on until that is sorted out.',
            'hi-IN': 'Dono taraf ka jod barabar nahin hai. Jab tak yeh theek nahin hota, is pack ki koi cheez bharose layak nahin.',
          },
        ];
    return { header: this.#header('trial_balance', actor, filter, notes, asAt), body };
  }

  async profitAndLoss(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<ProfitAndLossBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.financial, 'profit_and_loss', filter);
    const body = profitAndLossBody(await this.#books(companyId, filter));
    return {
      header: this.#header('profit_and_loss', actor, filter, [
        {
          'en-IN': 'The cost of goods sold is counted only as far as it has been written into the books. Goods bought but not yet recorded are listed under things worth a second look.',
          'hi-IN': 'Beche gaye maal ki lagat utni hi gini gayi hai jitni books mein likhi hai. Jo maal aaya par darj nahin hua, wo dobara dekhne wali cheezon mein hai.',
        },
      ], asAt),
      body,
    };
  }

  async balanceSheet(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<BalanceSheetBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.financial, 'balance_sheet', filter);
    const body = balanceSheetBody(await this.#books(companyId, filter));
    return {
      header: this.#header('balance_sheet', actor, filter, [
        {
          'en-IN': 'What you earned less what you spent is shown on its own line, because no entry has moved it into the owner’s money yet.',
          'hi-IN': 'Kamai mein se kharch nikaal kar bacha paisa alag line mein hai, kyunki abhi koi entry use malik ke paise mein nahin le gayi.',
        },
      ], asAt),
      body,
    };
  }

  async salesRegister(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<RegisterBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.sales, 'sales_register', filter);
    const body = await salesRegister(this.#deps.sales, this.#deps.names, companyId, filter);
    return { header: this.#header('sales_register', actor, filter, [], asAt), body };
  }

  async purchaseRegister(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<RegisterBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.purchase, 'purchase_register', filter);
    const body = await purchaseRegister(this.#deps.purchases, companyId, filter);
    const notes: Bilingual[] = body.available
      ? []
      : [
          {
            'en-IN': 'Bills from your suppliers are not recorded in this product yet, so this page is empty on purpose rather than because you bought nothing.',
            'hi-IN': 'Supplier ke bill abhi is product mein darj nahin hote, isliye yeh panna jaan-boojh kar khaali hai, na ki isliye ki kharid hui hi nahin.',
          },
        ];
    return { header: this.#header('purchase_register', actor, filter, notes, asAt), body };
  }

  async stock(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<StockBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.stock, 'stock', filter);
    const body = await stockReportBody(this.#deps.inventory, this.#deps.stockMasterData, this.#deps.names, companyId, filter);
    return {
      header: this.#header('stock', actor, filter, [
        {
          'en-IN': 'Goods are counted per item and godown, and valued at what they cost on average. This value is not yet written into the books.',
          'hi-IN': 'Maal har item aur godown ke hisaab se gina gaya hai, aur ausat lagat par laga hai. Yeh keemat abhi books mein nahin likhi jaati.',
        },
      ], asAt),
      body,
    };
  }

  async receivablesAgeing(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<AgeingBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.dues, 'ageing', filter);
    const body = await ageingBody(this.#deps.dues, actor, companyId, filter, 'RECEIVABLE');
    return { header: this.#header('ageing', actor, filter, [], asAt), body };
  }

  async payablesAgeing(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<AgeingBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.dues, 'ageing', filter);
    const body = await ageingBody(this.#deps.dues, actor, companyId, filter, 'PAYABLE');
    return { header: this.#header('ageing', actor, filter, [], asAt), body };
  }

  async gstSummary(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<GstSummaryBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.gst, 'gst_summary', filter);
    const body = gstSummaryBody(await this.#books(companyId, filter));
    return { header: this.#header('gst_summary', actor, filter, [body.caution], asAt), body };
  }

  async exceptions(actor: ActorContext, filter: ReportFilter, asAt: string = this.#deps.clock.now().toISOString()): Promise<Report<ExceptionsBody>> {
    const companyId = await this.#checked(actor, REPORT_PERMISSIONS.exceptions, 'exceptions', filter);
    const books = await this.#books(companyId, filter);
    const [stock, sales, receivables, payables] = await Promise.all([
      stockReportBody(this.#deps.inventory, this.#deps.stockMasterData, this.#deps.names, companyId, filter),
      salesRegister(this.#deps.sales, this.#deps.names, companyId, filter),
      ageingBody(this.#deps.dues, actor, companyId, filter, 'RECEIVABLE'),
      ageingBody(this.#deps.dues, actor, companyId, filter, 'PAYABLE'),
    ]);
    const movements: readonly StockMovement[] = await this.#deps.inventory.movements.list(companyId, { to: filter.to });
    const salesInvoices = (await this.#deps.sales.list(companyId)).filter(
      (i) => filter.branchId === undefined || i.branchId === filter.branchId,
    );
    const body = exceptionsBody({
      books,
      stock,
      movements,
      salesInvoices,
      sales,
      receivables,
      payables,
      to: filter.to,
    });
    return { header: this.#header('exceptions', actor, filter, [], asAt), body };
  }

  /**
   * The whole pack for one period, built from one read per source, so two pages of the same pack
   * can never have been taken from two different moments.
   */
  async pack(actor: ActorContext, filter: ReportFilter): Promise<ReportPack> {
    // One instant for the whole pack: two pages of the same pack must never claim to have been
    // taken at different moments, because then they cannot be checked against each other.
    const asAt = this.#deps.clock.now().toISOString();
    const [trialBalance, profitAndLoss, balanceSheet, sales, purchases, stock, receivables, payables, gst, exceptions] =
      await Promise.all([
        this.trialBalance(actor, filter, asAt),
        this.profitAndLoss(actor, filter, asAt),
        this.balanceSheet(actor, filter, asAt),
        this.salesRegister(actor, filter, asAt),
        this.purchaseRegister(actor, filter, asAt),
        this.stock(actor, filter, asAt),
        this.receivablesAgeing(actor, filter, asAt),
        this.payablesAgeing(actor, filter, asAt),
        this.gstSummary(actor, filter, asAt),
        this.exceptions(actor, filter, asAt),
      ]);
    return { trialBalance, profitAndLoss, balanceSheet, sales, purchases, stock, receivables, payables, gst, exceptions };
  }
}

export const monthFilter = (from: IsoDate, to: IsoDate, branchId?: ReportFilter['branchId']): ReportFilter =>
  branchId === undefined ? { from, to } : { from, to, branchId };
