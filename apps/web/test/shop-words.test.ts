/**
 * Issue #312 — shop words everywhere, enforced.
 *
 * Fails when anything a shopkeeper can read says a developer's word: on the screens (the page, both
 * language dictionaries, the Reports words and the sentences written into app.js) and in what the
 * API says back on the screens a trade walks through. The words are the ones the issue names:
 * module, voucher posted, live company state, synthetic, "draft does not guess", document(s) for a
 * bill, and ledger anywhere but Reports.
 *
 * It also holds the sale review to its rule: at most one warning line, and only when the owner has
 * something to do.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { handleApi } from '../../api/src/server.ts';
import { stockEverything } from '../../api/test/stock-helper.ts';

const root = resolve(import.meta.dirname, '..');
const read = (name: string) => readFile(resolve(root, name), 'utf8');

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ['module', /\bmodules?\b|मॉड्यूल/i],
  ['voucher posted', /voucher posted/i],
  ['live company state', /live company state/i],
  ['synthetic', /synthetic/i],
  ['draft does not guess', /draft does not guess/i],
  // A bill is a bill. (The GST portal's own table names are written out in other words too.)
  ['document', /\bdocuments?\b|दस्तावेज़?/i],
  ['ledger', /\bledgers?\b|लेजर|लेज़र/i],
];

/** Every banned word a string uses; `ledger` is allowed on Reports. */
const bannedIn = (text: string, onReports: boolean): string[] =>
  BANNED.filter(([word, pattern]) => !(onReports && word === 'ledger') && pattern.test(text)).map(([word]) => word);

const objectLiteral = (source: string, start: string, end: string): Record<string, unknown> =>
  vm.runInNewContext(`(${source.slice(source.indexOf(start) + start.length, source.indexOf(end, source.indexOf(start)))})`) as Record<string, unknown>;

const findings: string[] = [];
const check = (where: string, text: string, onReports = false) => {
  const words = bannedIn(text, onReports);
  if (words.length > 0) findings.push(`${where} says "${words.join('", "')}": ${text.slice(0, 140)}`);
};

test('#312: the lint catches every banned word, and lets Reports say ledger', () => {
  assert.deepEqual(bannedIn('Issued from the sales module', false), ['module']);
  assert.deepEqual(bannedIn('Calculated from live company state', false), ['live company state']);
  assert.deepEqual(bannedIn('Synthetic local credentials', false), ['synthetic']);
  assert.deepEqual(bannedIn('This draft does not guess them.', false), ['draft does not guess']);
  assert.deepEqual(bannedIn('3 open customer documents', false), ['document']);
  assert.deepEqual(bannedIn('Supplier voucher posted', false), ['voucher posted']);
  assert.deepEqual(bannedIn('Customer receipt posted to the ledger', false), ['ledger']);
  assert.deepEqual(bannedIn('straight from the ledger', true), []);
  assert.deepEqual(bannedIn('Bill INV-4 made · ₹1,838 to collect from 3 customers · Stock updated', false), []);
});

test('#312: no screen text, in English or Hindi, uses a developer word', async () => {
  findings.length = 0;
  const [script, html] = await Promise.all([read('app.js'), read('index.html')]);

  // Both dictionaries. Reports' own words may say ledger.
  const copy = objectLiteral(script, 'const copy = ', ';\n\nconst storage') as Record<string, Record<string, string>>;
  for (const [locale, words] of Object.entries(copy)) {
    for (const [key, value] of Object.entries(words)) check(`copy.${locale}.${key}`, value, /^reports?[A-Z]/.test(key));
  }
  const reportText = objectLiteral(script, 'const REPORT_TEXT = ', ';\n\n/**') as Record<string, Record<string, string>>;
  for (const [key, value] of Object.entries(reportText)) for (const [locale, words] of Object.entries(value)) check(`REPORT_TEXT.${key}.${locale}`, words, true);

  // Sentences written straight into app.js, outside the dictionaries: any string literal with a space
  // in it, with the code inside a template's ${…} taken out first.
  const code = script.slice(script.indexOf('\nconst t = '));
  for (const [literal] of code.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    const words = literal.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ');
    if (/[A-Za-z]{2,} [A-Za-z]{2,}/.test(words)) check('app.js', words);
  }

  // What the page itself shows: its text and the attributes a person reads or hears.
  const page = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ');
  for (const [, value] of page.matchAll(/\b(?:placeholder|title|aria-label|alt|content)="([^"]*)"/g)) check('index.html', value!);
  check('index.html', page.replace(/<[^>]+>/g, ' '));

  assert.deepEqual(findings, []);
});

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
let authorization: string | undefined;
const call = async (method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}) => {
  const reply = await handleApi(method, path, body, authorization);
  return { status: reply.status, body: JSON.parse(String(reply.body)) as Record<string, any> };
};
const walk = (where: string, value: unknown, onReports: boolean) => {
  if (typeof value === 'string') check(where, value, onReports);
  else if (Array.isArray(value)) value.forEach((entry, index) => walk(`${where}[${index}]`, entry, onReports));
  else if (value !== null && typeof value === 'object') for (const [key, entry] of Object.entries(value)) walk(`${where}.${key}`, entry, onReports);
};

test('#312: what the API says on the screens of a trade uses shop words too', async () => {
  findings.length = 0;
  const signedIn = await call('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(signedIn.status, 200);
  walk('sign-in', signedIn.body, false);
  authorization = `Bearer ${signedIn.body.sessionId as string}`;
  await stockEverything(authorization);

  const today = (await call('GET', '/api/dashboard')).body.today as string;
  // A sale at a big discount, so the review has something to say.
  const sale = {
    party: 'sampoorna:party:customer', date: today, terms: '30', shipTo: 'same', requestId: 'shop-words-312',
    lines: JSON.stringify([{ itemId: 'sampoorna:item:SOAP', quantity: '2', unit: 'PCS', rate: '40' }]),
  };
  const replies: Array<[string, { status: number; body: Record<string, any> }]> = [];
  replies.push(['sale review', await call('POST', '/api/sales/preview', sale)]);
  const recorded = await call('POST', '/api/sales/record', sale);
  replies.push(['sale recorded', recorded]);
  replies.push(['return review', await call('POST', '/api/returns/preview', {
    documentId: recorded.body.invoice.id, lineId: 'line-1', kind: 'SALES_RETURN', unit: 'PCS', quantity: '1',
    disposition: 'ACCEPTED', date: today, reference: 'shop-words-return', reason: 'Wrong soap',
  })]);
  replies.push(['money received review', await call('POST', '/api/payments/preview', {
    direction: 'RECEIPT', partyId: 'sampoorna:party:customer', amount: '50', date: today, method: 'CASH', bills: '[]', requestId: 'shop-words-receipt',
  })]);
  for (const path of ['/api/dashboard', '/api/einvoices/invoices', '/api/reminders', '/api/returns/documents', '/api/returns/notes', '/api/business-details', '/api/catalogue', '/api/subscription', '/api/eway/bills', '/api/challans', '/api/presale']) {
    replies.push([path, await call('GET', path)]);
  }
  for (const [where, reply] of replies) {
    assert.equal(reply.status, 200, `${where}: ${JSON.stringify(reply.body)}`);
    walk(where, reply.body, false);
  }
  const reports = await call('GET', '/api/reports');
  assert.equal(reports.status, 200);
  walk('/api/reports', reports.body, true);
  assert.deepEqual(findings, []);
});

/** Runs app.js's own saleReview against a review the server might send. */
async function review(result: Record<string, unknown>, locale = 'en-IN') {
  const script = await read('app.js');
  const start = script.indexOf('function saleReview(');
  const copy = objectLiteral(script, 'const copy = ', ';\n\nconst storage') as Record<string, Record<string, string>>;
  const context: Record<string, unknown> = { copy, state: { locale } };
  vm.runInNewContext([
    script.match(/^const t = .*$/m)![0],
    script.match(/^const text = .*$/m)![0],
    script.match(/^const money = .*$/m)![0],
    script.slice(start, script.indexOf('\n}\n', start) + 2),
    'this.saleReview = saleReview;',
  ].join('\n'), context);
  return (context.saleReview as (r: unknown, s: unknown) => Record<string, any>)(result, { title: 'Sale checked', message: 'm', effects: ['A numbered invoice will be issued.'] });
}

const TURNOVER = "We don't know yet whether you need e-invoices: Business details does not say whether your turnover has been over ₹5 crore. Answer once in Business details. This bill can still be issued now.";

test('#312: the sale review shows at most one warning, and only when the owner must act', async () => {
  // Everything fine: no warning at all, and the law's answer in one green line.
  const fine = await review({ ewayBill: { outcome: 'REQUIRED' }, eInvoice: { needed: 'YES', askTurnover: false }, terms: { credit: { outcome: 'ALLOW' }, lines: [] }, chargeLines: [] });
  assert.equal(fine.warning, null);
  assert.equal(fine.askTurnover, false);
  assert.match(fine.fine, /e-way bill/);
  assert.deepEqual(fine.effects, [], 'nothing informational is listed');

  // The full trade's step 3: turnover not answered, so that is the one line, with its button.
  const step3 = await review({ ewayBill: { outcome: 'REQUIRED' }, eInvoice: { needed: 'UNKNOWN', askTurnover: true, message: TURNOVER }, terms: { credit: { outcome: 'ALLOW' }, lines: [] }, chargeLines: [{ kind: 'FREIGHT', taxableValue: 2000, gst: 360 }] });
  assert.equal(step3.warning, TURNOVER);
  assert.equal(step3.askTurnover, true);
  assert.equal(step3.effects.length, 1, 'the freight line is a figure on the bill, not a warning');

  // Several things at once: still one line, the most urgent, and no turnover button under it.
  const many = await review({
    dateNotice: 'This bill will be dated 1 September 2026, which is before today.',
    eInvoice: { needed: 'UNKNOWN', askTurnover: true, message: TURNOVER },
    terms: { credit: { outcome: 'WARN', sentence: { 'en-IN': 'Over the credit limit.', 'hi-IN': 'Udhaar seema se upar.' } }, lines: [{ discount: { outcome: 'NEEDS_APPROVAL', sentence: { 'en-IN': 'This is 84% off.', 'hi-IN': '84% chhoot.' } }, margin: null }] },
  });
  assert.equal(many.warning, 'This bill will be dated 1 September 2026, which is before today.');
  assert.equal(many.askTurnover, false);

  // In Hindi the turnover line is Hindi too.
  const hindi = await review({ eInvoice: { needed: 'UNKNOWN', askTurnover: true, message: TURNOVER }, terms: { credit: { outcome: 'ALLOW' }, lines: [] } }, 'hi-IN');
  assert.match(hindi.warning, /Business details mein ek baar jawab dein/);
  assert.equal(hindi.askTurnover, true);

  // The page has exactly one place for the warning and one for the green line.
  const html = await read('index.html');
  assert.equal((html.match(/id="review-warning"/g) ?? []).length, 1);
  assert.equal((html.match(/id="review-ok"/g) ?? []).length, 1);
});
