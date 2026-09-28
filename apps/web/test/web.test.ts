import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { loadWebAsset } from "../server.ts";

const root = resolve(import.meta.dirname, "..");
const read = (name: string) => readFile(resolve(root, name), "utf8");

async function localeCopy(): Promise<Record<string, Record<string, string>>> {
  const source = await read("app.js");
  const literal = source.slice(source.indexOf("const copy = ") + "const copy = ".length, source.indexOf(";\n\nconst storage"));
  return vm.runInNewContext(`(${literal})`) as Record<string, Record<string, string>>;
}

test("the browser bundle parses before any screen is allowed to ship", async () => {
  const source = await read("app.js");
  assert.doesNotThrow(() => new vm.Script(source, { filename: "apps/web/app.js" }));
});

test("every navigation target has a matching labelled screen", async () => {
  const html = await read("index.html");
  const targets = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]!));
  assert.ok(targets.size > 10, "the smoke check must cover the real application navigation");
  for (const target of targets) {
    assert.match(html, new RegExp(`<section[^>]+id="view-${target}"[^>]+aria-labelledby="[^"]+"`), `Missing labelled screen for data-view="${target}"`);
  }
});

test("every visible and screen-reader translation key exists in English and Hindi", async () => {
  const [html, locales] = await Promise.all([read("index.html"), localeCopy()]);
  const keys = [...html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(keys.length > 70);
  assert.deepEqual(Object.keys(locales).sort(), ["en-IN", "hi-IN"]);
  for (const key of keys) {
    assert.ok(locales["en-IN"]?.[key], `Missing English translation: ${key}`);
    assert.ok(locales["hi-IN"]?.[key], `Missing Hindi translation: ${key}`);
  }
  assert.deepEqual(Object.keys(locales["en-IN"]!).sort(), Object.keys(locales["hi-IN"]!).sort());
});

test("critical runtime states have distinct English and Hindi wording", async () => {
  const locales = await localeCopy();
  for (const key of ["loginTitle", "signOut", "saleChecked", "purchaseChecked", "paymentChecked", "draftRestored", "nothingSaved", "physicalBalance", "recordOnce"]) {
    assert.notEqual(locales["en-IN"]?.[key], locales["hi-IN"]?.[key], `${key} must not fall back to English`);
  }
  assert.match(locales["en-IN"]!.physicalBalance!, /\{location\}/);
  assert.match(locales["en-IN"]!.stockLeastFirst!, /\{location\}/);
  assert.notEqual(locales["en-IN"]?.stockLeastFirst, locales["hi-IN"]?.stockLeastFirst);
  assert.match(locales["hi-IN"]!.saleCheckedBody!, /\{amount\}/);
});

test("transaction screens are semantic, labelled and safe to review", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  for (const flow of ["sale", "purchase", "payment", "paid"]) {
    assert.match(html, new RegExp(`<form[^>]+data-draft="${flow}"`));
    assert.match(html, new RegExp(`id="view-${flow}"[^>]+aria-labelledby=`));
    assert.match(script, new RegExp(`karobar\\.draft\\.\\$\\{form\\.dataset\\.draft\\}`));
  }
  assert.match(html, /role="status"/);
  assert.match(html, /<dialog[^>]+aria-labelledby=/);
  assert.match(script, /Intl\.NumberFormat\(state\.locale/);
  assert.match(script, /Intl\.DateTimeFormat\(state\.locale/);
  // Issue #230 — a form may name its endpoint (both payment screens use /api/payments); the rest use their draft name.
  assert.match(script, /\/api\/\$\{form\.dataset\.endpoint \?\? `\$\{form\.dataset\.draft\}s`\}\/preview/);
  assert.match(script, /\/api\/\$\{form\.dataset\.endpoint \?\? `\$\{form\.dataset\.draft\}s`\}\/record/);
  assert.match(script, /Nothing was saved/);
  assert.match(script, /Record once/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="view-returns"[^>]+aria-labelledby=/);
  assert.match(html, /id="return-form"/);
  assert.match(html, /id="return-document"/);
  assert.match(html, /id="return-line"/);
  assert.match(script, /\/api\/returns\/preview/);
  assert.match(script, /\/api\/returns\/record/);
  assert.match(script, /localizeReturnResult/);
  assert.match(script, /authorization: `Bearer \$\{state\.sessionId\}`/);
  assert.match(script, /\/api\/auth\/login/);
  assert.match(script, /karobar\.session/);
  // Issue #237 — the stock tile names the goods least left first, in this company's own godown.
  assert.match(script, /text\("stockLeastFirst", \{ location: data\.company\.location,/);
  // Issue #237 — after anything is recorded, issued or cancelled, every list is read again.
  assert.match(script, /async function refreshDocumentLists\(\)/);
  for (const loader of ["loadIssuedInvoices", "loadEwayRoad", "loadChallans", "loadReturnDocuments", "loadReturnNotes", "loadReminders"]) {
    assert.match(script.slice(script.indexOf("async function refreshDocumentLists()"), script.indexOf("async function loadDashboard()")), new RegExp(`quietly\\(${loader}\\)`));
  }
  // Issue #237 — setting up a business reads the full list of states, not twelve typed into the page.
  assert.equal((html.match(/<select name="stateCode" id="setup-states"[\s\S]*?<\/select>/)?.[0].match(/<option/g) ?? []).length, 1);
  assert.match(script, /copy\[state\.locale\]\.demoTitle/);
  assert.match(script, /setFormBusy\(form, true\)/);
  assert.match(script, /draftRestored/);
  assert.match(script, /customerDocumentsOne/);
  assert.match(script, /copy\[state\.locale\]\.loginInvalid/);
  assert.doesNotMatch(script, /subtotal \* \.05/);
  assert.match(script, /data-calculated="tax"\]\'\)\.textContent = "—"/);
  assert.match(script, /localizeResult\(result, form\.dataset\.draft, "preview"\)/);
  assert.match(script, /form\.setAttribute\("aria-busy", String\(busy\)\)/);
  assert.match(script, /cancel\.disabled = mode === "loading"/);
  assert.match(script, /dialog\.setAttribute\("aria-busy", String\(mode === "loading"\)\)/);
  assert.ok(script.indexOf("setFormBusy(form, true)") < script.indexOf("await api(`/api/${form.dataset.endpoint ?? `${form.dataset.draft}s`}/preview`"));
  assert.match(html, /aria-describedby="login-help"/);
  assert.match(html, /aria-describedby="review-body"/);
  assert.match(html, /id="view-bank-feeds"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/bank-feeds\/consent/);
  assert.match(script, /\/api\/bank-feeds\/sync/);
  assert.match(script, /\/api\/bank-feeds\/disconnect/);
  assert.match(html, /id="view-reminders"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/reminders\/send/);
  assert.match(html, /id="view-operations"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/operations/);
  assert.match(script, /dataReplayJob|replayJob/);
  assert.match(html, /id="operations-recurring"/);
  assert.match(script, /data\.recurring/);
  assert.match(html, /id="view-vehicle"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/vehicles\/check/);
  assert.match(script, /\/api\/vehicles\/check\/override/);
  assert.match(html, /id="view-migration"[^>]+aria-labelledby=/);
  assert.match(html, /id="ask-question"[^>]+data-i18n-placeholder="askQuestionPlaceholder"/);
  assert.match(script, /renderAskExamples\(\);\s*if \(lastAskAnswer !== null\) renderAnswer\(lastAskAnswer\);/);
  // Issue #30 — the GST return screen, and the two acts that leave the building kept apart from
  // preparing: approving is its own button and exporting is another.
  assert.match(html, /id="view-gst-returns"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/gst-returns\/prepare/);
  assert.match(script, /\/api\/gst-returns\/approve/);
  assert.match(script, /\/api\/gst-returns\/export/);
  // Issue #31 — the purchase comparison, with both ways of supplying the government's list: the
  // downloaded file and a row typed in by a person when the file cannot be had.
  assert.match(html, /id="view-itc"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/itc\/import/);
  assert.match(script, /\/api\/itc\/typed/);
  assert.match(script, /\/api\/itc\/decide/);
  // Issue #141 — the delivery challan: checked, then issued, then printed, linked or cancelled from
  // the one challan that is open, and offered on the e-way bill screen as the document on the lorry.
  assert.match(html, /id="view-challan"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/challans\/preview/);
  assert.match(script, /\/api\/challans\/issue/);
  assert.match(script, /\/api\/challans\/print/);
  assert.match(script, /\/api\/challans\/link-invoice/);
  assert.match(script, /\/api\/challans\/eway/);
  assert.match(script, /\/api\/challans\/movable/);
  // Issue #142 — quotations and proformas: checked, issued, printed, and from the one that is open,
  // a quotation turned into a sale (a bill shown first, then issued) or a proforma linked to its bill.
  assert.match(html, /id="view-presale"[^>]+aria-labelledby=/);
  // How long a price holds is the business's promise, so that date box is never filled in for it.
  assert.match(html, /name="validUntil" type="date" data-no-default/);
  assert.match(script, /input\[type=date\]:not\(\[data-no-default\]\)/);
  // Issue #165 — money against a proforma, its receipt voucher and its refund voucher.
  assert.match(html, /id="presale-advance-form"/);
  assert.match(html, /id="presale-refund-form"/);
  for (const route of ['preview', 'issue', 'print', 'convert', 'issue-sale', 'link-invoice', 'cancel', 'advance', 'advances', 'refund-advance', 'voucher']) {
    assert.match(script, new RegExp(`/api/presale/${route}"`));
  }
  // Issue #132 — the bill after a sale: the server's own printer in a frame, the browser's print
  // box for the paper, and any bill already issued opened again from the recorded activity.
  assert.match(html, /id="sale-bill-panel"/);
  assert.match(html, /id="sale-bill-frame"/);
  // Issue #181 — the customer is chosen from the business's own list, and the address the bill
  // carries is the one saved on that customer. The free-text address box is gone.
  assert.doesNotMatch(html, /name="customerAddress"/);
  // Issue #233 — and it starts with nobody chosen, so a new sale never inherits the last customer.
  assert.match(html, /<select name="party" data-customer-picker data-picker-blank="chooseSaleCustomer" required>/);
  assert.match(html, /id="sale-lines"/);
  assert.match(html, /data-line-field="item" data-item-picker/);
  assert.match(html, /name="freight" type="number" min="0" step="0\.01"/);
  assert.match(html, /name="otherCharges" type="number" min="0" step="0\.01"/);
  // Issue #228 — a supplier bill's lines come from the item list (a service such as inward freight
  // is added there like any other item), each with its own GST rate, and the supplier comes from the
  // supplier list. Nothing asks which state the supplier is in: their GST number says it.
  assert.match(html, /<select name="supplierId" data-supplier-picker required>/);
  assert.match(html, /id="purchase-line-template"[\s\S]*data-line-field="item" data-item-picker[\s\S]*data-line-field="gst" data-gst-picker/);
  assert.match(html, /id="new-supplier-dialog"/);
  // One id, one element: the Supplier check screen already has a form called "supplier-form".
  assert.equal([...html.matchAll(/id="supplier-form"/g)].length, 1);
  assert.doesNotMatch(html, /name="supplierState"/);
  assert.doesNotMatch(html, /<option value="FRT"/);
  assert.match(script, /input\.lines = JSON\.stringify\(purchaseLineValues\(\)\)/);
  assert.match(script, /\/api\/suppliers/);
  assert.match(script, /result\.chargeLines/);
  assert.doesNotMatch(script, /line\.gst\s*[*/+-]/, 'the browser must display the calculator tax, not recompute it');
  assert.match(script, /\/api\/sales\/print/);
  // Issue #183 — printing is still the browser's own print box; on A4 it prints the whole marked
  // set, and on till roll or a phone the one slip on screen.
  assert.match(script, /frame\.contentWindow\?\.print\(\)/);
  assert.match(script, /copies: "all"/);
  assert.match(html, /id="sale-bill-copies"/);
  assert.match(script, /copy\[state\.locale\]\.openBill/);
  // One focusable heading per screen. Bank feeds, reminders, operations, vehicle, migration, plans,
  // #34's "Ask", #30's GST returns, #31's purchase check, #141's challans, #142's quotations and
  // proformas, #146/#147's bill design and #180's business details and #230's Money paid make twenty-six.
  assert.equal((html.match(/<h1[^>]+tabindex="-1"/g) ?? []).length, 26);
});

test("responsive CSS includes phone navigation, reduced motion and visible focus", async () => {
  const css = await read("styles.css");
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.bottom-nav \{ position: fixed; display: grid/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /outline:\s*none/);
  assert.doesNotMatch(css, /\.save-state \{ display: none/);
  assert.match(css, /\.topbar-actions \.user-avatar \{ display: none/);
  assert.match(css, /\.bottom-nav \{[^}]*grid-auto-flow: column; grid-auto-columns: minmax\(68px, 1fr\);[^}]*overflow-x: auto/);
  assert.match(css, /\.bottom-nav button small \{[^}]*text-overflow: ellipsis/);
});

test("the local web preview serves the application shell", async () => {
  const asset = await loadWebAsset("/");
  assert.equal(asset.status, 200);
  assert.match(asset.contentType, /text\/html/);
  assert.match(asset.body.toString("utf8"), /id="view-dashboard"/);
  assert.equal((await loadWebAsset("/../../private-file")).status, 403);
});

test("#230: money received picks a customer and money paid picks a supplier, never a typed name", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  const received = html.slice(html.indexOf('data-draft="payment"'), html.indexOf('id="view-paid"'));
  const paid = html.slice(html.indexOf('data-draft="paid"'), html.indexOf('id="view-bank-feeds"'));
  assert.match(received, /<select name="partyId" data-customer-picker data-picker-blank="choosePaymentCustomer"[^>]*required/);
  assert.doesNotMatch(received, /<input name="party"/);
  assert.match(paid, /<select name="partyId" data-supplier-picker data-picker-blank="choosePaymentSupplier"[^>]*required/);
  // Every mode is sent by its own name, whatever language the screen is in.
  for (const form of [received, paid]) {
    for (const mode of ["UPI", "CASH", "BANK_TRANSFER", "CHEQUE"]) assert.match(form, new RegExp(`<option value="${mode}"`));
    assert.match(form, /name="chequeNumber"/);
    assert.match(form, /name="chequeDate"/);
    assert.match(form, /data-payment-bills/);
  }
  assert.match(html, /data-view="paid"/);
  assert.match(script, /\/api\/payments\/open-bills/);
  assert.match(script, /\/api\/payments\/voucher/);
  assert.match(script, /input\.requestId = form\.dataset\.requestId/);
  // The old list of the demo customer's bills is gone.
  assert.doesNotMatch(script, /#payment-invoice/);
});

/** The source of one top-level function in app.js, so it can be run on its own. */
async function functionSource(name: string): Promise<string> {
  const source = await read("app.js");
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no function ${name}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

test("#233: after a recorded sale the form has no customer and one fresh line, and no draft brings the old one back", async () => {
  const script = await read("app.js");
  // The recorded-sale branch clears the form before it shows the bill.
  const recorded = script.slice(script.indexOf('document.querySelector("#review-confirm").addEventListener'), script.indexOf("// ------------------------------------------------- issue #132"));
  assert.match(recorded, /if \(form\.dataset\.draft === "sale" && result\.invoice\) resetSaleForm\(form\);\s*showDialog\([\s\S]*showSaleBill\(result\.invoice\.id\)/);
  // Each review carries its own key, so Record twice is one bill and the next review a new sale.
  assert.match(script, /input\.requestId = newPaymentRequestId\(\);/);

  // Run the reset itself against a form left exactly as the Mehta sale leaves it.
  const removed: string[] = [];
  const oldLine = { id: "450 KGS at ₹90" };
  const lines = { children: [oldLine] as unknown[], replaceChildren(...next: unknown[]) { this.children = next; } };
  const picker = { value: "mehta" };
  const date = { value: "2026-09-01" };
  const delivery = { id: "sale-delivery", open: true };
  const form = {
    dataset: { draft: "sale" },
    reset() { /* a browser puts typed values back to the page's own defaults */ },
    querySelector: (selector: string) => (selector === "[data-customer-picker]" ? picker : null),
    querySelectorAll: (selector: string) => (selector.startsWith("input[type=") ? [date] : selector === "details" ? [delivery] : []),
  };
  const calls: string[] = [];
  const context = {
    storage: { removeItem: (key: string) => removed.push(key) },
    document: { querySelector: (selector: string) => (selector === "#sale-lines" ? lines : null) },
    dateInput: () => "2026-09-28",
    addSaleLine: () => { lines.children.push({ id: "fresh" }); calls.push("addSaleLine"); },
    showChosenCustomer: () => calls.push("showChosenCustomer"),
    showShipToFields: () => calls.push("showShipToFields"),
    updateCalculations: () => calls.push("updateCalculations"),
  };
  vm.runInNewContext(`${await functionSource("resetSaleForm")}\nresetSaleForm(form);`, { ...context, form });

  assert.equal(picker.value, "", "no customer is chosen");
  assert.deepEqual(lines.children, [{ id: "fresh" }], "the old 450 KGS line is gone and one fresh line is left");
  assert.equal(date.value, "2026-09-28", "today's date");
  assert.equal(delivery.open, false, "the delivery box is closed again");
  assert.deepEqual(removed, ["karobar.draft.sale"], "the saved draft is gone, so a reload cannot bring the old sale back");
  assert.ok(calls.includes("showChosenCustomer") && calls.includes("updateCalculations"));
});

test("#233: an issued bill can be cancelled with a reason, and the returns screen can credit the whole bill", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /id="sale-bill-cancel" data-i18n="cancelBill"/);
  assert.match(html, /id="cancel-bill-dialog"[\s\S]*<textarea name="reason" rows="2" required>/);
  assert.match(script, /\/api\/sales\/cancel\/preview"/);
  assert.match(script, /\/api\/sales\/cancel"/);
  // Refused once the month is approved: the whole-bill credit note is offered in its place.
  assert.match(html, /id="cancel-bill-credit-note" data-i18n="makeWholeBillNote"/);
  assert.match(script, /const WHOLE_BILL = "__whole__";/);
  // The GST returns screen shows the documents-issued table, cancelled numbers included.
  assert.match(script, /workspace\.documentsIssued/);
});

test("#241: the menu follows a trade — Buying, Stock, Selling, GST, Books, Settings folded — and the phone bar is five buttons", async () => {
  const [html, script, locales] = await Promise.all([read("index.html"), read("app.js"), localeCopy()]);
  const sidebar = html.slice(html.indexOf('<nav class="nav-list"'), html.indexOf("</nav>", html.indexOf('<nav class="nav-list"')));
  const en = locales["en-IN"]!;
  const label = (key: string) => en[key];
  // Each group, in order, with its entries in order, read off the page as a person would see it.
  const groups = [...sidebar.matchAll(/<(div|details) class="nav-group[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, body]) => ({
    title: label(/class="nav-group-title"[^>]*data-i18n="([^"]+)"/.exec(body!)![1]!),
    folded: tag === "details" && !/<details[^>]*\bopen\b/.test(body!),
    entries: [...body!.matchAll(/<button class="nav-item"[^>]*>.*?data-i18n="([^"]+)"/g)].map((m) => label(m[1]!)),
  }));
  assert.deepEqual(groups, [
    { title: "Buying", folded: false, entries: ["Purchase", "Orders and deliveries", "Supplier check", "Money paid"] },
    { title: "Stock", folded: false, entries: ["What is in the godown"] },
    { title: "Selling", folded: false, entries: ["Sale", "Delivery challan", "E-way bill", "Vehicle check", "Money received", "Returns", "Reminders"] },
    { title: "GST", folded: false, entries: ["Purchase check", "GST returns", "E-invoice"] },
    { title: "Books", folded: false, entries: ["Reports", "Activity", "Bank feeds", "Ask"] },
    { title: "Settings", folded: true, entries: ["Business details", "Bill design", "Set up a business", "Bring your data", "Your plan", "Operations", "Quotation / Proforma"] },
  ]);
  assert.match(html, /<details class="nav-group nav-settings" id="nav-settings">/, "Settings starts folded");
  // No screen was dropped: every screen in the page has a menu entry.
  const screens = [...html.matchAll(/<section class="view[^"]*" id="view-([^"]+)"/g)].map((m) => m[1]!).sort();
  const entries = new Set([...sidebar.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]!));
  assert.deepEqual(screens.filter((screen) => !entries.has(screen)), []);
  // The stock report is the stock part of Reports, opened at that part.
  assert.match(sidebar, /data-view="reports" data-section="report-stock"/);
  assert.match(script, /stock\.id = "report-stock"/);
  // Phone: Home, Sale, Purchase, Money, More — More opens the grouped list with Settings unfolded, so every screen is two taps away.
  const bar = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf("</nav>", html.indexOf('<nav class="bottom-nav"')));
  assert.deepEqual([...bar.matchAll(/<small data-i18n="([^"]+)"/g)].map((m) => label(m[1]!)), ["Home", "Sale", "Purchase", "Money", "More"]);
  assert.match(bar, /data-view="payment" data-also-views="paid"/);
  assert.match(bar, /id="more-button"[^>]*aria-controls="primary-sidebar"/);
  assert.match(script, /querySelector\("#more-button"\)\.addEventListener\("click", toggleMenu\)/);
  assert.match(script, /function toggleMenu\(\)[\s\S]*?settings\.open = true/);
  // Hindi has every new word too.
  for (const key of ["navGroupBuying", "navGroupStock", "navGroupSelling", "navGroupGst", "navGroupBooks", "navGroupSettings", "navStock", "navMoney", "navMore"]) assert.ok(locales["hi-IN"]![key], key);
});
