/**
 * Issue #294 — expenses, journal and contra entries, the owner's money in and out, and the cash and
 * bank books. Each entry is checked (`/preview`) and then saved (`/record`) with the check it got.
 */
import { anything, fields, get, list, need, needAny, nothing, post, text, type Route } from './route.ts';

const EXPENSE = need('record an expense', 'ledger.post.payment');
// Journal and contra entries are the accountant's: only people allowed to post journals may.
const JOURNAL = need('make a journal or contra entry', 'ledger.post.journal');
// Money in is a receipt, money out a payment; the ledger checks the one this entry is.
const OWNER = needAny("record the owner's money in or out", 'ledger.post.receipt', 'ledger.post.payment');
const UNDO = need('undo an entry', 'ledger.reverse');
const BOOKS = need('see the cash and bank books', 'reports.view.financial');

const expense = fields({ requestId: text, check: text, head: text, date: text, paidFrom: text, amount: text, gst: text, billNumber: text, consignmentNote: text, narration: text });
const journal = fields({ requestId: text, check: text, date: text, narration: text, lines: anything });
const contra = fields({ requestId: text, check: text, date: text, direction: text, amount: text, narration: text });
const owner = fields({ requestId: text, check: text, date: text, direction: text, paidFrom: text, amount: text, narration: text });
const undo = fields({ requestId: text, entryId: text, reason: text });
const book = fields({ book: text, from: text, to: text });

export const BOOKS_ROUTES: readonly Route[] = [
  get('/api/books/heads', { access: EXPENSE, input: nothing }, ({ app, actor }) => app.booksHeads(actor)),
  get('/api/books/journal/accounts', { access: JOURNAL, input: nothing }, ({ app, actor }) => app.booksJournalAccounts(actor)),
  post('/api/books/expense/preview', { access: EXPENSE, input: expense }, ({ app, actor, input }) => app.booksPreview(actor, 'expense', input)),
  post('/api/books/expense/record', { access: EXPENSE, input: expense }, ({ app, actor, input }) => app.booksRecord(actor, 'expense', input)),
  post('/api/books/journal/preview', { access: JOURNAL, input: journal }, ({ app, actor, input }) => app.booksPreview(actor, 'journal', input)),
  post('/api/books/journal/record', { access: JOURNAL, input: journal }, ({ app, actor, input }) => app.booksRecord(actor, 'journal', input)),
  post('/api/books/contra/preview', { access: JOURNAL, input: contra }, ({ app, actor, input }) => app.booksPreview(actor, 'contra', input)),
  post('/api/books/contra/record', { access: JOURNAL, input: contra }, ({ app, actor, input }) => app.booksRecord(actor, 'contra', input)),
  post('/api/books/owner/preview', { access: OWNER, input: owner }, ({ app, actor, input }) => app.booksPreview(actor, 'owner', input)),
  post('/api/books/owner/record', { access: OWNER, input: owner }, ({ app, actor, input }) => app.booksRecord(actor, 'owner', input)),
  post('/api/books/undo', { access: UNDO, input: undo }, ({ app, actor, input }) => app.booksUndo(actor, input)),
  list('/api/books/entries', { access: BOOKS, key: 'entries' }, ({ app, actor }) => app.booksEntries(actor)),
  get('/api/books/book', { access: BOOKS, input: book }, ({ app, actor, input }) => app.booksBook(actor, input)),
];
