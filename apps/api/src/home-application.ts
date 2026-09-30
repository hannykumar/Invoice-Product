/**
 * Issue #310 — Home: one money card, only the jobs that need the owner, and the latest bills.
 *
 * Every figure here is read from the same records Reports reads, the same way:
 *
 *   - Cash in drawer is the closing balance of account 1110 (cash in hand) in Reports' own trial
 *     balance, built by the same two functions (`loadBooks`, `trialBalanceBody`) over the same period.
 *   - UPI and bank today is what came into account 1121 (the current account) on vouchers dated today.
 *
 * A task is shown only while something needs the owner, and each is read afresh on every Home load,
 * so it disappears the moment the thing is done. A task whose source the person may not read is not
 * shown; a task whose action they may not take is shown without its button.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type { ActorContext, LedgerStore } from '@invoice/ledger';
import { loadBooks, trialBalanceBody } from '@invoice/reports';
import {
  CALENDAR_PERMISSIONS,
  CatalogueDefinitions,
  ComplianceCalendarService,
  InMemoryAlerts,
  InMemoryComplianceExceptions,
  InMemoryOccurrences,
  InMemoryProfiles,
} from '@invoice/compliance-calendar';
import { InMemoryAuditPort } from '@invoice/ledger';
import { formatPaise } from '../../../packages/purchasing/src/money.ts';
import { appClock } from './app-clock.ts';

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };
const say = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

/** Where a task's one button goes: a screen (optionally on one bill, item or month), or a request. */
export type HomeAction =
  | { readonly label: Bilingual; readonly open: { readonly view: string; readonly section?: string; readonly bill?: string; readonly period?: string; readonly turnover?: true } }
  | { readonly label: Bilingual; readonly post: { readonly path: string; readonly body: Readonly<Record<string, string>> } };

export interface HomeTask {
  readonly id: string;
  readonly kind: 'EWAY' | 'EINVOICE' | 'GST_RETURN' | 'LATE_CUSTOMERS' | 'STOCK' | 'TURNOVER';
  /** Lower is more urgent; Home lists them in this order. */
  readonly rank: number;
  readonly title: Bilingual;
  readonly action: HomeAction | null;
}

const CASH_IN_HAND = '1110';
const CURRENT_ACCOUNT = '1121';

/** Cash in drawer (as Reports' trial balance shows it) and what came into the bank today, in paise. */
export async function moneyCardFigures(store: LedgerStore, companyId: CompanyId, period: { readonly from: IsoDate; readonly to: IsoDate }, today: IsoDate) {
  const books = await loadBooks(store.read(), companyId, period);
  const cash = trialBalanceBody(books).rows.find((row) => row.code === CASH_IN_HAND)?.closing.amount.minor ?? 0n;
  const bank = books.accounts.find((account) => account.code === CURRENT_ACCOUNT);
  const bankInToday = bank === undefined ? 0n : books.closing
    .filter((entry) => entry.line.accountId === bank.id && entry.voucher.date === today)
    .reduce((total, entry) => total + entry.line.debit.minor, 0n);
  return { cashInDrawer: cash, bankInToday };
}

const shortDate = (iso: string, locale: 'en-IN' | 'hi-IN') =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(`${iso}T12:00:00+05:30`));
const monthName = (key: string, locale: 'en-IN' | 'hi-IN') =>
  new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date(`${key}-15T12:00:00+05:30`));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// ------------------------------------------------------------------------------------ the tasks

/**
 * A bill that needs an e-way bill and has none. When the last try (at Make bill, or on the E-way bill
 * screen) got no number because the portal did not answer, the button sends it again as it was sent;
 * when the portal refused it, or nothing was sent (no vehicle yet), only a person can put it right.
 */
export function ewayTask(bill: {
  readonly id: string; readonly number: string; readonly customer: string | null;
  readonly failure: { readonly retryable: boolean; readonly distanceKm: number } | null;
}, canAct: boolean): HomeTask {
  const who = bill.customer ?? '';
  const open: HomeAction = { label: say('Raise', 'बनाइए'), open: { view: 'eway', bill: bill.id } };
  if (bill.failure === null) {
    return {
      id: `eway:${bill.id}`, kind: 'EWAY', rank: 10,
      title: say(`${who}: e-way bill needed before the goods leave (${bill.number})`, `${who}: माल निकलने से पहले ई-वे बिल चाहिए (${bill.number})`),
      action: canAct ? open : null,
    };
  }
  if (!bill.failure.retryable) {
    return {
      id: `eway:${bill.id}`, kind: 'EWAY', rank: 10,
      title: say(`The e-way bill for ${bill.number} could not be made — the government site refused it, so something on it needs correcting`,
        `${bill.number} का ई-वे बिल नहीं बना — सरकारी साइट ने लौटा दिया, इसमें कुछ ठीक करना है`),
      action: canAct ? { label: say('Open', 'खोलिए'), open: open.open } : null,
    };
  }
  // The same request the E-way bill screen sends: the bill's own details, and the distance last sent.
  const body: Record<string, string> = { invoice: bill.id, reason: 'SUPPLY', ...(bill.failure.distanceKm > 0 ? { distanceKm: String(bill.failure.distanceKm) } : {}) };
  return {
    id: `eway:${bill.id}`, kind: 'EWAY', rank: 10,
    title: say(`The e-way bill for ${bill.number} could not be made — the government site did not answer`,
      `${bill.number} का ई-वे बिल नहीं बना — सरकारी साइट ने जवाब नहीं दिया`),
    action: canAct ? { label: say('Retry', 'फिर भेजिए'), post: { path: '/api/eway/generate', body } } : null,
  };
}

export function eInvoiceTask(bill: { readonly id: string; readonly number: string; readonly eInvoiceStatus: string; readonly needed: string; readonly canRetry: boolean }, canAct: boolean): HomeTask | null {
  const waiting = bill.eInvoiceStatus === 'PENDING';
  const unsent = bill.eInvoiceStatus === 'NOT_SENT' && bill.needed === 'YES';
  const refused = bill.eInvoiceStatus === 'FAILED' && bill.needed === 'YES';
  if (!waiting && !unsent && !refused) return null;
  const title = waiting
    ? say(`${bill.number} is waiting for its e-invoice number from the government`, `${bill.number} के ई-इनवॉइस नंबर का सरकार से इंतज़ार है`)
    : unsent
      ? say(`${bill.number} needs an e-invoice number and has not been sent yet`, `${bill.number} को ई-इनवॉइस नंबर चाहिए, अभी भेजा नहीं गया`)
      : bill.canRetry
        ? say(`The e-invoice for ${bill.number} could not be sent — the government site did not answer`, `${bill.number} का ई-इनवॉइस नहीं गया — सरकारी साइट ने जवाब नहीं दिया`)
        : say(`${bill.number}: the government refused the e-invoice`, `${bill.number}: सरकार ने ई-इनवॉइस लौटा दिया`);
  const action: HomeAction = waiting
    ? { label: say('Check again', 'फिर देखिए'), post: { path: '/api/einvoices/reconcile', body: { invoice: bill.id } } }
    : unsent || bill.canRetry
      ? { label: say('Retry', 'फिर भेजिए'), post: { path: '/api/einvoices/register', body: { invoice: bill.id } } }
      : { label: say('Open', 'खोलिए'), open: { view: 'einvoice', bill: bill.id } };
  return { id: `einvoice:${bill.id}`, kind: 'EINVOICE', rank: refused ? 20 : 25, title, action: canAct ? action : null };
}

/**
 * GSTR-1 and GSTR-3B from the compliance calendar (#32, wired here for #297): the owner's rungs of
 * its ladder only — due within three days, due today, or late. A month whose return was downloaded
 * for the portal or sent from here counts as done. One task per return, naming every month open.
 */
export async function gstReturnTasks(
  actor: ActorContext,
  company: { readonly id: CompanyId; readonly name: string; readonly gstin: string; readonly booksStart: IsoDate },
  doneMonths: ReadonlySet<string>,
  canAct: boolean,
): Promise<HomeTask[]> {
  const profiles = new InMemoryProfiles();
  profiles.set({
    companyId: company.id,
    legalName: company.name,
    gstin: company.gstin,
    // A registered GST number that issues tax invoices is a regular taxpayer.
    registrationType: { value: 'REGULAR', basis: 'DERIVED' },
    // ponytail: monthly because the GST returns screen prepares one return a month; a quarterly
    // (QRMP) shop needs a Business details answer the app does not ask yet.
    gstFilingFrequency: { value: 'MONTHLY', basis: 'DERIVED', basisNote: 'The GST returns screen prepares one return a month.' },
    eInvoiceApplicable: null,
    movesGoods: null,
    stateCode: { value: company.gstin.slice(0, 2), basis: 'DERIVED' },
    // Nothing is said about a month before these books began.
    calendarFrom: company.booksStart,
    timeZone: 'Asia/Kolkata',
    saturdayIsWorking: true,
  });
  const calendar = new ComplianceCalendarService({
    definitions: new CatalogueDefinitions(), profiles, occurrences: new InMemoryOccurrences(), alerts: new InMemoryAlerts(),
    exceptions: new InMemoryComplianceExceptions(), audit: new InMemoryAuditPort(), clock: appClock,
  });
  // Reading the calendar writes nothing. Whoever may look at GST returns may read their due dates;
  // the platform's roles have no calendar permission of their own yet.
  const view = await calendar.calendar({ ...actor, permissions: [CALENDAR_PERMISSIONS.view] });
  const tasks: HomeTask[] = [];
  for (const [code, en, hi] of [['GSTR1', 'GSTR-1 (sales list)', 'GSTR-1 (बिक्री की सूची)'], ['GSTR3B', 'GSTR-3B (tax payment)', 'GSTR-3B (टैक्स भरना)']] as const) {
    const open = view.entries
      .filter((entry) => entry.occurrence.code === code && ['DUE_SOON', 'DUE_TODAY', 'OVERDUE'].includes(entry.state) && !doneMonths.has(entry.occurrence.period.key))
      .sort((a, b) => a.occurrence.dueDate.localeCompare(b.occurrence.dueDate));
    const first = open[0];
    if (first === undefined) continue;
    const months = (locale: 'en-IN' | 'hi-IN') => open.map((entry) => monthName(entry.occurrence.period.key, locale)).join(', ');
    const due = first.occurrence.dueDate;
    const late = -first.daysRemaining;
    const title = late > 0
      ? say(`${en} for ${months('en-IN')} not filed: due ${shortDate(due, 'en-IN')}, ${late} ${late === 1 ? 'day' : 'days'} late`,
        `${hi} ${months('hi-IN')} का नहीं भरा: ${shortDate(due, 'hi-IN')} तक था, ${late} दिन देर`)
      : late === 0
        ? say(`${en} for ${months('en-IN')} is due today`, `${hi} ${months('hi-IN')} का आज भरना है`)
        : say(`${en} for ${months('en-IN')} is due ${shortDate(due, 'en-IN')}`, `${hi} ${months('hi-IN')} का ${shortDate(due, 'hi-IN')} तक भरना है`);
    tasks.push({
      id: `gst:${code}:${first.occurrence.period.key}`, kind: 'GST_RETURN', rank: late > 0 ? 30 : 35, title,
      action: canAct ? { label: say('Check', 'देखिए'), open: { view: 'gst-returns', period: first.occurrence.period.key } } : null,
    });
  }
  return tasks;
}

export function lateCustomersTask(late: readonly { readonly outstanding: bigint }[], canAct: boolean): HomeTask | null {
  if (late.length === 0) return null;
  const amount = formatPaise(late.reduce((total, row) => total + row.outstanding, 0n));
  const one = late.length === 1;
  return {
    id: 'late-customers', kind: 'LATE_CUSTOMERS', rank: 40,
    title: say(`${late.length} ${one ? 'customer is' : 'customers are'} more than 30 days late: ${amount} to collect`,
      `${late.length} ग्राहक 30 दिन से ज़्यादा देर से: ${amount} लेना है`),
    action: canAct ? { label: say('Remind all', 'सबको याद दिलाइए'), post: { path: '/api/reminders/send-all', body: {} } } : null,
  };
}

export function stockTask(low: readonly { readonly itemId: string; readonly name: string; readonly quantity: number; readonly unit: string }[], canAct: boolean): HomeTask | null {
  const first = low[0];
  if (first === undefined) return null;
  const left = (item: typeof first, locale: 'en-IN' | 'hi-IN') => item.quantity <= 0
    ? (locale === 'en-IN' ? `${item.name}: none left` : `${item.name}: ख़त्म`)
    : (locale === 'en-IN' ? `${item.name}: only ${item.quantity} ${item.unit} left` : `${item.name}: सिर्फ़ ${item.quantity} ${item.unit} बचा`);
  const more = low.length - 1;
  return {
    id: 'stock', kind: 'STOCK', rank: 50,
    title: more === 0 ? say(left(first, 'en-IN'), left(first, 'hi-IN'))
      : say(`${left(first, 'en-IN')}, and ${more} more ${more === 1 ? 'item' : 'items'} running low`, `${left(first, 'hi-IN')}, और ${more} सामान कम`),
    // One item: its purchase bill. Several: the item list, where every stock figure is.
    action: canAct ? { label: say('Order', 'मँगाइए'), open: { view: more === 0 ? 'purchase' : 'items' } } : null,
  };
}

/** Issue #312's hand-over: the e-invoice turnover question, asked again every 1 April until answered. */
export function turnoverTask(financialYear: string, canAct: boolean): HomeTask {
  return {
    id: `turnover:${financialYear}`, kind: 'TURNOVER', rank: 45,
    title: say(`One question for ${financialYear}: has your turnover been over ₹5 crore? It decides whether bills need e-invoices`,
      `${financialYear} के लिए एक सवाल: क्या आपका टर्नओवर ₹5 करोड़ से ऊपर गया है? इसी से तय होता है कि बिल पर ई-इनवॉइस चाहिए या नहीं`),
    action: canAct ? { label: say('Answer', 'जवाब दीजिए'), open: { view: 'business', turnover: true } } : null,
  };
}

// ---------------------------------------------------------------------------------- recent bills

/** Paid, still due, or late — and how the money came, when it came. `paidBy` null is udhaar. */
export function recentBillRow(
  invoice: { readonly id: string; readonly number: string | null; readonly dueDate: string | null; readonly total: bigint },
  customer: string,
  outstanding: bigint,
  modes: readonly string[],
  today: IsoDate,
) {
  const late = outstanding > 0n && invoice.dueDate !== null && invoice.dueDate < today ? daysBetween(invoice.dueDate, today) : 0;
  return {
    id: invoice.id,
    number: invoice.number,
    customer,
    paidBy: modes.length === 0 ? null : [...new Set(modes)].join(' + '),
    amount: Number(invoice.total) / 100,
    due: Number(outstanding) / 100,
    status: outstanding <= 0n ? 'PAID' as const : late > 0 ? 'LATE' as const : 'DUE' as const,
    daysLate: late,
  };
}

/** A month counts as done for Home once its return was downloaded for the portal, or filed from here. */
export const doneReturnMonths = (preparations: readonly { readonly period: string; readonly state: string }[]): Set<string> =>
  new Set(preparations.filter((p) => p.state === 'EXPORTED' || p.state === 'FILED').map((p) => p.period));

