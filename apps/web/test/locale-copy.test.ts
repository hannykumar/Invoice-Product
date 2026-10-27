/**
 * Issue #495 — the page's two languages as data, and the pure sentence-making modules that use them.
 *
 * `copy` in app.js is a plain table of English and Hindi sentences. It is the one thing in the web
 * sources these tests read, and they read it as DATA (evaluated, then compared), never as text to
 * search: nothing here asserts that a string, a function name or a selector exists in the source.
 * Whether the page actually shows these words, and in which screen, is the browsers' job
 * (`web-screens.test.ts` flips every label to Hindi and back).
 *
 * The money and sentence helpers in `done-screen.js` are pure, so they are tested by importing them.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');

type Table = Record<string, Record<string, string>>;

/** The `copy` table, evaluated. Fails loudly if the table cannot be found, so this never passes on nothing. */
async function localeCopy(): Promise<Table> {
  const source = await readFile(resolve(root, 'app.js'), 'utf8');
  const start = source.indexOf('const copy = ');
  const end = source.indexOf(';\n\nconst storage', start);
  assert.ok(start >= 0 && end > start, 'the copy table is where the test expects it');
  return vm.runInNewContext(`(${source.slice(start + 'const copy = '.length, end)})`) as Table;
}

test('English and Hindi have exactly the same sentences, none empty', async () => {
  const copy = await localeCopy();
  assert.deepEqual(Object.keys(copy).sort(), ['en-IN', 'hi-IN']);
  const english = Object.keys(copy['en-IN']!).sort();
  assert.ok(english.length > 500, `${english.length} sentences: the real table was read`);
  assert.deepEqual(Object.keys(copy['hi-IN']!).sort(), english);
  for (const [locale, words] of Object.entries(copy)) {
    const empty = Object.entries(words).filter(([, sentence]) => typeof sentence !== 'string' || sentence.trim() === '').map(([key]) => key);
    assert.deepEqual(empty, [], `${locale} has no empty sentence`);
  }
});

test('the sentences the shopkeeper meets at the moment of truth are not English in Hindi, and keep their blanks', async () => {
  const { 'en-IN': en, 'hi-IN': hi } = await localeCopy() as Record<string, Record<string, string>> & { 'en-IN': Record<string, string>; 'hi-IN': Record<string, string> };
  for (const key of ['loginTitle', 'signOut', 'saleChecked', 'purchaseChecked', 'paymentChecked', 'draftRestored', 'nothingSaved', 'physicalBalance', 'recordOnce', 'enterPurchaseBill', 'backToSale', 'draftSaleDateMoved', 'draftPurchaseDateKept', 'draftMoneyDateKept']) {
    assert.notEqual(hi[key], en[key], `${key} must not fall back to English`);
    assert.match(hi[key]!, /[ऀ-ॿ]/, `${key} is written in Devanagari`);
  }
  // A sentence with blanks has the same blanks in both languages, or one of them prints "{amount}" to a person.
  const blanks = (sentence: string) => [...sentence.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  // (English takes the customer's name already made possessive — "ABC Traders’" — in {names}; Hindi takes it plain in {name}.)
  const possessive = new Set(['doneLinePart', 'doneLineKhata']);
  const mismatched = Object.keys(en).filter((key) => !possessive.has(key) && JSON.stringify(blanks(en[key]!)) !== JSON.stringify(blanks(hi[key]!)));
  assert.deepEqual(mismatched, [], 'the same blanks in English and Hindi');
  assert.deepEqual(blanks(en.physicalBalance!), ['location']);
  assert.deepEqual(blanks(en.draftSaleDateMoved!), ['started', 'today']);
  assert.notEqual(en.stockLeastFirst, hi.stockLeastFirst);
});

// ------------------------------------------------------------------ issues #288 and #307

/** The done-screen module, loaded the way the browser loads it. */
const doneScreen = async () => import(pathToFileURL(resolve(root, 'done-screen.js')).href);
const rupees = (locale: string) => (amount: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(amount);
const cashSale = { invoice: { id: 'i1', number: 'INV/26-27/000005', amount: 126 }, customer: { name: 'Walk-in / cash customer', phone: null, walkIn: true }, paid: { mode: 'CASH', amount: 126 }, due: 0, shop: 'Sampoorna Traders', upiLink: null };
const UPI = 'upi://pay?pa=sampoorna@okicici&pn=Sampoorna%20Traders&am=26.00&cu=INR&tn=INV%2F26-27%2F000006';
const partSale = { invoice: { id: 'i2', number: 'INV/26-27/000006', amount: 126 }, customer: { name: 'ABC Traders', phone: '+91 98765 43210', walkIn: false }, paid: { mode: 'UPI', amount: 100 }, due: 26, shop: 'Sampoorna Traders', upiLink: UPI };

test('#307: the WhatsApp message and its UPI link, in English and Hindi — the link asks for the amount due only, with the bill number', async () => {
  const { shareMessage, whatsappLink, indianMobile } = await doneScreen();
  const { 'en-IN': en, 'hi-IN': hi } = await localeCopy();
  assert.equal(shareMessage(cashSale, en, rupees('en-IN')), 'Hello, thank you for shopping at Sampoorna Traders. Bill INV/26-27/000005: ₹126.00.\nPaid in full.');
  assert.match(shareMessage(cashSale, hi, rupees('hi-IN')), /^नमस्ते, Sampoorna Traders से ख़रीदने के लिए धन्यवाद। बिल INV\/26-27\/000005: ₹126\.00।\n/);
  assert.doesNotMatch(shareMessage(cashSale, en, rupees('en-IN')), /upi:/, 'nothing is due, so nothing is asked for');

  const english = shareMessage(partSale, en, rupees('en-IN'));
  assert.equal(english, `Hello ABC Traders, thank you for shopping at Sampoorna Traders. Bill INV/26-27/000006: ₹126.00.\nStill to pay: ₹26.00.\nPay by UPI: ${UPI}`);
  const hindi = shareMessage(partSale, hi, rupees('hi-IN'));
  for (const message of [english, hindi]) {
    const link = new URL(/upi:\S+/.exec(message)![0]);
    assert.equal(link.searchParams.get('am'), '26.00', 'the amount still due, never the bill total');
    assert.equal(link.searchParams.get('tn'), 'INV/26-27/000006', 'the bill number');
    assert.equal(link.searchParams.get('pa'), 'sampoorna@okicici');
  }
  // The customer's own number, in WhatsApp's click-to-chat link, with the message as typed.
  const mobile = indianMobile(partSale.customer.phone);
  assert.equal(mobile, '9876543210');
  const chat = new URL(whatsappLink(mobile, hindi));
  assert.equal(`${chat.origin}${chat.pathname}`, 'https://wa.me/919876543210');
  assert.equal(chat.searchParams.get('text'), hindi);
  // A number is never guessed from something that is not one.
  for (const typed of ['', '12345', '5876543210', '98765432101', null]) assert.equal(indianMobile(typed), null, String(typed));
  assert.equal(indianMobile('098765 43210'), '9876543210');
});

test('#307: the done screen\'s one line says where the money went, in English and Hindi', async () => {
  const { doneLine } = await doneScreen();
  const { 'en-IN': en, 'hi-IN': hi } = await localeCopy();
  assert.equal(doneLine(cashSale, en, rupees('en-IN')), 'Cash received from Walk-in. Stock updated.');
  assert.equal(doneLine(cashSale, hi, rupees('hi-IN')), 'वॉक-इन ग्राहक से नक़द मिल गया। स्टॉक अपडेट हो गया।');
  const credit = { ...partSale, paid: null, due: 126 };
  assert.equal(doneLine(credit, en, rupees('en-IN')), 'Added to ABC Traders’ khata. Stock updated.');
  assert.equal(doneLine(credit, hi, rupees('hi-IN')), 'ABC Traders के खाते में जुड़ गया। स्टॉक अपडेट हो गया।');
  assert.equal(doneLine(partSale, en, rupees('en-IN')), 'UPI payment of ₹100.00 received; ₹26.00 added to ABC Traders’ khata. Stock updated.');
});
