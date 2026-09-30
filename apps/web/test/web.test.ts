import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  // Issue #310 (was #237's stock tile) — goods that need the owner are a Home task, worded by the server.
  assert.match(script, /home\.tasks\.map\(\(task\) =>/);
  // Issue #237 — after anything is recorded, issued or cancelled, every list is read again.
  assert.match(script, /async function refreshDocumentLists\(\)/);
  for (const loader of ["loadIssuedInvoices", "loadEwayRoad", "loadChallans", "loadReturnDocuments", "loadReturnNotes", "loadReminders"]) {
    assert.match(script.slice(script.indexOf("async function refreshDocumentLists()"), script.indexOf("async function loadDashboard()")), new RegExp(`quietly\\(${loader}\\)`));
  }
  // Issue #237 — setting up a business reads the full list of states, not twelve typed into the page.
  assert.equal((html.match(/<select name="stateCode" id="setup-states"[\s\S]*?<\/select>/)?.[0].match(/<option/g) ?? []).length, 1);
  // Issue #312 — no developer banner: it is hidden while the shop answers and shown only on a failure.
  assert.match(html, /id="connection-banner" role="status" hidden>/);
  assert.match(script, /banner\.hidden = true;/);
  assert.match(script, /setFormBusy\(form, true\)/);
  assert.match(script, /draftRestored/);
  assert.match(script, /customerDocumentsOne/);
  assert.match(script, /copy\[state\.locale\]\.loginInvalid/);
  assert.doesNotMatch(script, /subtotal \* \.05/);
  // Issue #306 — GST and the total on the form are the server's estimate, never worked out here.
  assert.match(script, /\[data-calculated="tax"\]'\)\.textContent = totals \? money\(totals\.totalTax\) : "—"/);
  assert.match(script, /api\("\/api\/sales\/estimate"/);
  assert.match(script, /const ESTIMATE_DELAY_MS = 250;/);
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
  // Issue #308 — the sale line's item is the shared picker; its id rides in a hidden field.
  assert.match(html, /id="sale-line-template"[\s\S]*?<input type="hidden" data-line-field="item" \/>[\s\S]*?data-item-search/);
  assert.match(html, /<script type="module" src="\/item-picker\.js"><\/script>\s*<script type="module" src="\/app\.js">/);
  assert.doesNotMatch(html, /data-change-code/, "the HSN code is changed in the item's own dialog, not on the sale line");
  assert.match(html, /name="freight" type="number" min="0" step="0\.01"/);
  assert.match(html, /name="otherCharges" type="number" min="0" step="0\.01"/);
  // Issue #228 — a supplier bill's lines come from the item list (a service such as inward freight
  // is added there like any other item), each with its own GST rate, and the supplier comes from the
  // supplier list. Nothing asks which state the supplier is in: their GST number says it.
  assert.match(html, /<select name="supplierId" data-supplier-picker required>/);
  assert.match(html, /id="purchase-line-template"[\s\S]*?<input type="hidden" data-line-field="item" \/>[\s\S]*?data-item-search[\s\S]*?data-line-field="gst" data-gst-picker/);
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
  // proformas, #146/#147's bill design and #180's business details and #230's Money paid make twenty-six;
  // #303's owner-only design page makes twenty-seven; #304's Items and More make twenty-nine.
  assert.equal((html.match(/<h1[^>]+tabindex="-1"/g) ?? []).length, 29);
});

test("responsive CSS includes phone navigation, reduced motion and visible focus", async () => {
  const css = await read("styles.css");
  assert.match(css, /@media \(max-width: 760px\)/);
  // Issue #304 — the five tabs are the bottom bar on a phone and a left rail on a desktop.
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.app-tabbar \{ position: fixed; inset: auto 0 0;[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /\n\.app-tabbar \{ grid-row: 1 \/ 3; grid-column: 1; position: sticky;/);
  assert.match(css, /\.tabbar \.tab-main > span \{[^}]*background: var\(--action\)/, "+ Bill is the raised marigold button");
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /outline:\s*none/);
  assert.doesNotMatch(css, /\.save-state \{ display: none/);
  assert.match(css, /\.topbar-actions \.user-avatar \{ display: none/);
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

test("#233/#288: after a recorded sale the form is back to the walk-in customer and one fresh line, and no draft brings the old one back", async () => {
  const script = await read("app.js");
  // The recorded-sale branch clears the form before it shows the bill.
  const recorded = script.slice(script.indexOf('document.querySelector("#review-confirm").addEventListener'), script.indexOf("// ------------------------------------------------- issue #132"));
  assert.match(recorded, /if \(form\.dataset\.draft === "sale" && result\.invoice\) resetSaleForm\(form\);[\s\S]*if \(saleDone\) \{ await openDoneScreen\(result\); await showSaleBill\(result\.invoice\.id\); \}/);
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
    hideDraftDateNote: () => calls.push("hideDraftDateNote"),
    forgetPendingDraft: () => calls.push("forgetPendingDraft"),
    addSaleLine: () => { lines.children.push({ id: "fresh" }); calls.push("addSaleLine"); },
    showChosenCustomer: () => calls.push("showChosenCustomer"),
    showShipToFields: () => calls.push("showShipToFields"),
    showPaidBy: () => calls.push("showPaidBy"),
    walkInId: () => "walk-in-id",
    updateCalculations: () => calls.push("updateCalculations"),
  };
  vm.runInNewContext(`${await functionSource("resetSaleForm")}\nresetSaleForm(form);`, { ...context, form });

  assert.equal(picker.value, "walk-in-id", "the walk-in customer is chosen, not Mehta");
  assert.deepEqual(lines.children, [{ id: "fresh" }], "the old 450 KGS line is gone and one fresh line is left");
  assert.equal(date.value, "2026-09-28", "today's date");
  assert.equal(delivery.open, false, "the delivery box is closed again");
  assert.deepEqual(removed, ["karobar.draft.sale"], "the saved draft is gone, so a reload cannot bring the old sale back");
  assert.ok(calls.includes("showChosenCustomer") && calls.includes("updateCalculations") && calls.includes("showPaidBy"));
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

test("#304: five tabs — Home, Khata, + Bill, Items, More — instead of the 22-item menu, and every screen is still reachable", async () => {
  const [html, script, locales] = await Promise.all([read("index.html"), read("app.js"), localeCopy()]);
  const en = locales["en-IN"]!;
  const section = (start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
  const bar = section('<nav class="tabbar app-tabbar"', "</nav>");
  const sheet = section('<dialog id="bill-sheet"', "</dialog>");
  const more = section('<section class="view" id="view-more"', "</section>\n\n");
  const moreAll = html.slice(html.indexOf('<section class="view" id="view-more"'), html.indexOf("</nav>", html.indexOf('<section class="view" id="view-more"')));

  // The old sidebar and phone bar are gone.
  assert.doesNotMatch(html, /class="sidebar"|class="bottom-nav"|class="nav-item|id="menu-button"/);
  assert.doesNotMatch(script, /toggleMenu|closeMenu|#nav-settings/);

  // The bar: a labelled landmark, five tabs in order, + Bill the raised centre that opens a new sale.
  assert.match(bar, /aria-label="Main" data-i18n-aria="mainNavigation"/);
  assert.deepEqual([...bar.matchAll(/<small data-i18n="([^"]+)"/g)].map((m) => en[m[1]!]), ["Home", "Khata", "Bill", "Items", "More"]);
  assert.match(bar, /class="tab-main" id="bill-button" aria-controls="view-sale" aria-keyshortcuts="F2 Alt\+N"/);
  // Khata opens who owes what in Reports until the khata page (#309) is built.
  assert.match(bar, /data-view="reports" data-section="report-dues"/);
  assert.match(script, /dues\.id = "report-dues"/);

  // + Bill: Sale first, marigold and focused; then the other bills; Expense shown but not yet usable.
  const choices = [...sheet.matchAll(/<button type="button" class="([^"]+)"([^>]*)>.*?data-i18n="([^"]+)"/g)].map((m) => ({ main: m[1]!.includes("action-button"), view: /data-view="([^"]+)"/.exec(m[2]!)?.[1] ?? null, disabled: /\bdisabled\b/.test(m[2]!), label: en[m[3]!] }));
  assert.deepEqual(choices, [
    { main: true, view: "sale", disabled: false, label: "Sale" },
    { main: false, view: "purchase", disabled: false, label: "Purchase" },
    { main: false, view: "payment", disabled: false, label: "Money received" },
    { main: false, view: "paid", disabled: false, label: "Money paid" },
    { main: false, view: "presale", disabled: false, label: "Quotation" },
    { main: false, view: "returns", disabled: false, label: "Return" },
    { main: false, view: null, disabled: true, label: "Expense" },
  ]);
  assert.match(sheet, /data-view="sale" autofocus/);
  assert.match(sheet, /aria-describedby="expense-soon"[\s\S]*id="expense-soon" data-i18n="expenseSoon"/);
  // Any screen reaches a new sale in one tap: the tab, F2 and Alt+N all open the sale itself.
  assert.match(script, /querySelector\("#bill-button"\)\.addEventListener\("click", openNewSale\)/);
  assert.match(script, /event\.key === "F2" \|\| \(event\.altKey && [^)]*event\.code === "KeyN"\)\) \{\s*event\.preventDefault\(\);\s*openNewSale\(\);/);
  assert.match(script, /function openNewSale\(\) \{[\s\S]*?openView\("sale"\);/);
  // The other bills stay one tap away on the sale: "Other bills" opens the sheet; choosing closes it.
  const saleHeading = section('<section class="view" id="view-sale"', "</form>");
  assert.match(saleHeading, /id="other-bills" aria-haspopup="dialog" aria-controls="bill-sheet" data-i18n="otherBills"/);
  assert.equal(en.otherBills, "Other bills");
  assert.equal(locales["hi-IN"]!.otherBills, "दूसरे बिल");
  assert.match(script, /querySelector\("#other-bills"\)\.addEventListener\("click", openBillSheet\)/);
  assert.match(script, /function openView[\s\S]*?if \(sheet\?\.open\) sheet\.close\(\);/);

  // More: every other screen, in five plain groups.
  assert.deepEqual([...moreAll.matchAll(/<h2 id="more-[^"]+" data-i18n="([^"]+)"/g)].map((m) => en[m[1]!]), ["GST", "Stock", "People", "Business settings", "Reports"]);

  // No screen was dropped: every screen is one of the five tabs, a choice on + Bill, or a line on
  // More — except #303's owner-only design page, which is reached at #design.
  const screens = [...html.matchAll(/<section class="view[^"]*" id="view-([^"]+)"/g)].map((m) => m[1]!).sort();
  const reachable = new Set([...`${bar}${sheet}${moreAll}`.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]!));
  assert.deepEqual(screens.filter((screen) => !reachable.has(screen) && screen !== "design"), []);
  assert.ok(screens.length >= 28, "the check must cover the real screens");
  // And every old address still opens its screen: openView takes any #view-… there is.
  assert.match(script, /window\.addEventListener\("hashchange", \(\) => openView\(location\.hash\.slice\(1\)\)\)/);
  assert.match(script, /const target = document\.querySelector\(`#view-\$\{view\}`\) \? view : "dashboard";/);
  // The tab for what is on screen is marked: + Bill for a bill it opens, More for the rest.
  assert.match(script, /if \(onBill\) bill\?\.setAttribute\("aria-current", "page"\)/);
  assert.match(script, /if \(!document\.querySelector\("\.app-tabbar \[aria-current\]"\)\) document\.querySelector\("#more-tab"\)\?\.setAttribute\("aria-current", "page"\)/);
  assert.ok(more.length > 0);

  // Hindi has every new word, in Devanagari.
  for (const key of ["mainNavigation", "tabHome", "tabKhata", "tabBill", "tabItems", "tabMore", "billSheetTitle", "navQuotation", "navReturn", "navExpense", "expenseSoon", "navGroupPeople", "navGroupBusiness", "navGroupReports", "moreTitle", "itemsTitle"]) {
    assert.match(locales["hi-IN"]![key]!, /[ऀ-ॿ]/, key);
  }
});

test("#304: the Items tab lists every item with what is left, adds one, and changes one", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /<section class="view" id="view-items" aria-labelledby="items-title">/);
  assert.match(html, /id="items-add"/);
  // Add uses the item form every picker uses; Change opens #308's item editor.
  assert.match(script, /querySelector\("#items-add"\)\?\.addEventListener\("click", \(\) => \{\s*pickerAwaitingNewRecord = null;[\s\S]*?#item-dialog"\)\.showModal\(\)/);
  assert.match(script, /change\.addEventListener\("click", \(\) => openItemEditor\(item\.id\)\)/);
  assert.match(script, /for \(const id of \["#item-dialog", "#item-edit-dialog"\]\) document\.querySelector\(id\)\?\.addEventListener\("close"/);
});

test("#310: Home is one money card, the tasks that need the owner, and the recent bills with a status chip", async () => {
  const [html, script, locales] = await Promise.all([read("index.html"), read("app.js"), localeCopy()]);
  const home = html.slice(html.indexOf('id="view-dashboard"'), html.indexOf('id="view-items"'));
  assert.match(home, /class="money-card home-money"/);
  assert.match(home, /id="home-tasks"/);
  assert.match(home, /<p class="line-ok" id="home-all-clear" hidden>.*data-i18n="homeAllClear"/);
  assert.match(home, /id="home-bills"/);
  assert.doesNotMatch(home, /metric-card|attention-panel/, "the four old tiles are gone");
  assert.equal(locales["en-IN"]!.homeAllClear, "All clear for today");
  // A figure opens its list only when the server sent where; a task shows its button only when it sent one.
  assert.match(script, /const box = el\(figure\.opens \? "button" : "div"/);
  assert.match(script, /if \(task\.action\) \{/);
  // Done elsewhere, gone here: Home is read again every time it is opened, and after every task.
  assert.match(script, /if \(target === "dashboard" && state\.dashboard\) loadDashboard\(\);/);
  assert.match(script, /async function runHomeTask[\s\S]*?await refreshDocumentLists\(\);/);
  // Chips: status colours only.
  assert.match(script, /el\("span", "chip paid", words\.homeChipPaid\)/);
  assert.match(script, /el\("span", "chip late"/);
  assert.match(script, /el\("span", "chip due"/);
});

/**
 * Issue #266 — runs the real restore code from app.js against a draft saved on the device on an
 * earlier day, for each form that keeps a draft.
 */
async function restoreOn(flow: string, saved: Record<string, string> | null, today: string) {
  const script = await read("app.js");
  const line = (name: string) => {
    const match = script.match(new RegExp(`^const ${name} = .*$`, "m"));
    assert.ok(match, `app.js has no const ${name}`);
    return match[0];
  };
  const locales = await localeCopy();
  const store = new Map<string, string>(saved === null ? [] : [[`karobar.draft.${flow}`, JSON.stringify(saved)]]);
  const fields: Record<string, { value: string }> = {};
  for (const [name, value] of Object.entries(saved ?? {})) if (!name.startsWith("__")) fields[name] = { value: "" };
  fields.date ??= { value: "" };
  const noteText = { textContent: "" };
  const note = { hidden: true, querySelector: () => noteText };
  const statuses: string[] = [];
  const form = {
    dataset: { draft: flow } as Record<string, string>,
    elements: { namedItem: (name: string) => fields[name] ?? null },
    querySelector: (selector: string) => (selector === 'input[name="date"]' ? fields.date : null),
  };
  const context = {
    form, storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) },
    document: { querySelector: (selector: string) => (selector === `#${flow}-draft-date-note` ? note : null) },
    dateInput: () => today,
    setDraftStatus: (_form: unknown, key: string) => statuses.push(key),
    text: (key: string, values: Record<string, string>) => Object.entries(values).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, value), locales["en-IN"]![key]!),
    Intl, Date, JSON, Object,
  };
  vm.runInNewContext([
    line("DRAFT_DATE_RULES"), line("longDate"), line("DRAFT_STARTED"), line("DRAFT_SAVED"), line("DRAFT_LINES"), line("pendingDraft"),
    await functionSource("draftDateNote"), await functionSource("settleDraftDate"), await functionSource("restoreDraft"),
    "restoreDraft(form);",
  ].join("\n"), context);
  const kept = store.get(`karobar.draft.${flow}`);
  return { date: fields.date.value, note: note.hidden ? null : noteText.textContent, statuses, kept: kept === undefined ? null : JSON.parse(kept), fields };
}

test("#266: a sale draft saved yesterday comes back dated today, with one line saying so", async () => {
  const restored = await restoreOn("sale", { party: "mehta", date: "2026-09-28", __startedOn: "2026-09-28", __savedOn: "2026-09-28" }, "2026-09-29");
  assert.equal(restored.date, "2026-09-29");
  assert.equal(restored.note, "This sale was started on 28 September 2026. Its date is now today, 29 September 2026. Change it only if the goods really left on another day.");
  assert.deepEqual(restored.statuses, ["draftRestored"]);
  // The draft on the device moves too, and nothing else in it is lost.
  assert.equal(restored.kept.date, "2026-09-29");
  assert.equal(restored.kept.party, "mehta");
  assert.equal(restored.kept.__startedOn, "2026-09-28");
  assert.equal(restored.kept.__savedOn, "2026-09-29");
});

test("#266: a sale draft saved before the day was recorded is still brought up to today", async () => {
  // Drafts saved before this change carry no save day: the date in them is the best guess.
  const restored = await restoreOn("sale", { party: "mehta", date: "2026-09-28" }, "2026-09-29");
  assert.equal(restored.date, "2026-09-29");
  assert.match(restored.note!, /^This sale was started on 28 September 2026\. Its date is now today, 29 September 2026\./);
});

test("#266: a sale dated yesterday on purpose today is left alone when reloaded the same day", async () => {
  const restored = await restoreOn("sale", { party: "mehta", date: "2026-09-28", __startedOn: "2026-09-29", __savedOn: "2026-09-29" }, "2026-09-29");
  assert.equal(restored.date, "2026-09-28");
  assert.equal(restored.note, null);
});

test("#266: a supplier bill keeps the supplier's date, and a money entry keeps its day; both say so", async () => {
  const purchase = await restoreOn("purchase", { reference: "SRS-101", date: "2026-09-27", __startedOn: "2026-09-28", __savedOn: "2026-09-28" }, "2026-09-29");
  assert.equal(purchase.date, "2026-09-27", "the supplier's bill date is never changed");
  assert.equal(purchase.note, "This supplier bill was started on 28 September 2026. Its bill date is kept as 27 September 2026, because it is the supplier's date. Check it against their bill.");
  assert.equal(purchase.kept.date, "2026-09-27");
  for (const flow of ["payment", "paid"]) {
    const money = await restoreOn(flow, { amount: "500", date: "2026-09-28", __startedOn: "2026-09-28", __savedOn: "2026-09-28" }, "2026-09-29");
    assert.equal(money.date, "2026-09-28", `${flow}: the day the money moved is kept`);
    assert.equal(money.note, "This entry was started on 28 September 2026. Its date is kept as 28 September 2026. Change it if the money moved on another day.");
  }
});

test("#266: every draft form has its date line, the sale review shows the server's date line first, and a new day follows the server's today", async () => {
  const [html, script, locales] = await Promise.all([read("index.html"), read("app.js"), localeCopy()]);
  for (const flow of ["sale", "purchase", "payment", "paid"]) {
    assert.match(html, new RegExp(`id="${flow}-draft-date-note"[^>]*hidden><span aria-hidden="true">i</span><span data-note-text></span></p>\\s*<form[^>]+data-draft="${flow}"`));
  }
  assert.match(script, /const notes = \[\s*\/\/[^\n]*\n\s*\.\.\.\(result\.dateNotice \? \[result\.dateNotice\] : \[\]\),/);
  assert.match(script, /function adoptServerToday[\s\S]*?settleDraftDate\(form, form\.dataset\.draftStartedOn/);
  // Cleared, reset and recorded forms lose the line.
  assert.match(await functionSource("resetSaleForm"), /hideDraftDateNote\(form\);/);
  assert.equal((script.match(/hideDraftDateNote\(form\);/g) ?? []).length, 3);
  for (const key of ["draftSaleDateMoved", "draftPurchaseDateKept", "draftMoneyDateKept"]) {
    assert.ok(locales["hi-IN"]![key] && locales["hi-IN"]![key] !== locales["en-IN"]![key], key);
  }
});

/**
 * Follow-up to #266 — the customer, delivery address and item lines of a saved sale come back even
 * when their lists arrive after the draft is put back (a slow network, a cold server). Runs the real
 * restore, save and re-apply code from app.js against boxes that, like a browser's, refuse a value
 * that is not one of their choices.
 */
class Choice { value: string; constructor(value: string) { this.value = value; } }
class SelectBox {
  tagName = "SELECT";
  options: Choice[] = [];
  #value = "";
  get value() { return this.#value; }
  set value(next: string) { this.#value = this.options.some((option) => option.value === next) ? next : ""; }
  fill(...values: string[]) { this.options = values.map((value) => new Choice(value)); }
}
class TextBox { tagName = "INPUT"; value = ""; }

async function draftHarness(flow: "sale" | "purchase" | "payment" | "paid", saved: Record<string, unknown>, selects: string[]) {
  const script = await read("app.js");
  const line = (name: string) => {
    const match = script.match(new RegExp(`^const ${name} = .*$`, "m"));
    assert.ok(match, `app.js has no const ${name}`);
    return match[0];
  };
  const store = new Map<string, string>([[`karobar.draft.${flow}`, JSON.stringify(saved)]]);
  const fields: Record<string, SelectBox | TextBox> = {};
  for (const name of Object.keys(saved)) if (!name.startsWith("__")) fields[name] = selects.includes(name) ? new SelectBox() : new TextBox();
  const lineBox = { children: [] as any[], querySelectorAll: (selector: string) => (selector === ".sale-line" ? lineBox.children : []), replaceChildren() { lineBox.children = []; } };
  const form = {
    dataset: { draft: flow } as Record<string, string>,
    elements: { namedItem: (name: string) => fields[name] ?? null },
    querySelector: (selector: string) => (selector === ".sale-lines" && (flow === "sale" || flow === "purchase") ? lineBox : null),
  };
  const newLine = () => {
    // Issue #308 — the item is the picker's hidden field on both bills; the GST rate is still a choice.
    const parts: Record<string, SelectBox | TextBox> = { item: new TextBox(), quantity: new TextBox(), rate: new TextBox(), ...(flow === "purchase" ? { gst: new SelectBox() } : {}) };
    if (parts.gst) (parts.gst as SelectBox).fill("500", "1800");
    const row = {
      parts,
      querySelector: (selector: string) => parts[selector.match(/data-line-field="?([a-z]+)/)?.[1] ?? ""] ?? null,
      querySelectorAll: () => Object.entries(parts).map(([name, field]) => Object.assign(field, { dataset: { lineField: name } })),
    };
    lineBox.children.push(row);
    return row;
  };
  const context: Record<string, unknown> = {
    form,
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) },
    document: {
      querySelector: (selector: string) => (selector === `[data-draft="${flow}"]` ? form : selector === `#${flow}-lines` ? lineBox : null),
    },
    dateInput: () => "2026-09-29",
    setDraftStatus: () => undefined,
    settleDraftDate: () => false,
    draftData: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value])),
    addSaleLine: newLine, addPurchaseLine: newLine, showLineUnit: () => undefined, updateCalculations: () => undefined,
    Object, JSON, Array,
  };
  vm.runInNewContext([
    line("DRAFT_STARTED"), line("DRAFT_SAVED"), line("DRAFT_LINES"), line("pendingDraft"),
    await functionSource("draftLines"), await functionSource("saveDraft"), await functionSource("restoreDraft"),
    await functionSource("applyPendingChoices"), await functionSource("restorePendingLines"),
    "this.run = (code) => eval(code);",
  ].join("\n"), context);
  const run = context.run as (code: string) => unknown;
  return { fields, lineBox, stored: () => JSON.parse(store.get(`karobar.draft.${flow}`)!), run };
}

test("#266 follow-up: a sale's customer, delivery address and lines come back when the lists arrive late", async () => {
  const saved = {
    party: "mehta", shipTo: "address", shipToAddressId: "addr-pune", transporterId: "vrl", reference: "PO-7", date: "2026-09-29",
    __lines: [{ item: "tmt", quantity: "450", rate: "90" }], __startedOn: "2026-09-29", __savedOn: "2026-09-29",
  };
  const sale = await draftHarness("sale", saved, ["party", "shipTo", "shipToAddressId", "transporterId"]);
  (sale.fields.shipTo as SelectBox).fill("same", "address", "party");
  sale.run("restoreDraft(form)");
  assert.equal(sale.fields.party!.value, "", "the customer list is not here yet, so the box cannot show Mehta");

  // Something is typed while the lists are still loading: the saved customer, address and lines survive it.
  sale.fields.reference!.value = "PO-7A";
  sale.run("saveDraft(form)");
  assert.equal(sale.stored().party, "mehta");
  assert.equal(sale.stored().shipToAddressId, "addr-pune");
  assert.deepEqual(sale.stored().__lines, [{ item: "tmt", quantity: "450", rate: "90" }]);
  assert.equal(sale.stored().reference, "PO-7A");

  // The customer list arrives (late), then the item lines are rebuilt.
  (sale.fields.party as SelectBox).fill("", "abc", "mehta");
  sale.run('applyPendingChoices(["party", "partyId", "supplierId", "shipToPartyId"], true)');
  sale.run("restorePendingLines()");
  assert.equal(sale.fields.party!.value, "mehta");
  assert.equal(sale.lineBox.children.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(sale.lineBox.children[0].parts).map(([name, field]: [string, any]) => [name, field.value])), { item: "tmt", quantity: "450", rate: "90" });

  // A first delivery load for nobody offers nothing; Mehta's addresses and transporters arrive after.
  sale.run('applyPendingChoices(["shipToAddressId", "transporterId"], false)');
  assert.equal(sale.stored().shipToAddressId, "addr-pune", "still waiting, not dropped");
  (sale.fields.shipToAddressId as SelectBox).fill("addr-pune", "addr-nashik");
  (sale.fields.transporterId as SelectBox).fill("", "vrl");
  sale.run('applyPendingChoices(["shipToAddressId", "transporterId"], true)');
  assert.equal(sale.fields.shipToAddressId!.value, "addr-pune");
  assert.equal(sale.fields.transporterId!.value, "vrl");
  sale.run("saveDraft(form)");
  assert.equal(sale.stored().party, "mehta");
  assert.deepEqual(sale.stored().__lines, [{ item: "tmt", quantity: "450", rate: "90" }], "the lines on screen are what is saved now");
});

test("#266 follow-up: supplier bills and money entries get their supplier or customer back; a removed one is let go", async () => {
  const purchase = await draftHarness("purchase", {
    supplierId: "shree-ram", reference: "SRS-101", __lines: [{ item: "tmt", quantity: "500", rate: "64", gst: "1800" }],
  }, ["supplierId"]);
  purchase.run("restoreDraft(form)");
  (purchase.fields.supplierId as SelectBox).fill("shree-ram");
  purchase.run('applyPendingChoices(["party", "partyId", "supplierId", "shipToPartyId"], true)');
  purchase.run("restorePendingLines()");
  assert.equal(purchase.fields.supplierId!.value, "shree-ram");
  assert.equal((purchase.lineBox.children[0].parts.gst as SelectBox).value, "1800", "the GST rate on the supplier's bill is kept");

  for (const flow of ["payment", "paid"] as const) {
    const money = await draftHarness(flow, { partyId: "mehta", amount: "500" }, ["partyId"]);
    money.run("restoreDraft(form)");
    (money.fields.partyId as SelectBox).fill("", "mehta");
    money.run('applyPendingChoices(["party", "partyId", "supplierId", "shipToPartyId"], true)');
    assert.equal(money.fields.partyId!.value, "mehta", flow);
  }

  // The list has loaded and the saved customer is not on it: it is let go, not kept forever.
  const gone = await draftHarness("payment", { partyId: "removed", amount: "500" }, ["partyId"]);
  gone.run("restoreDraft(form)");
  (gone.fields.partyId as SelectBox).fill("", "mehta");
  gone.run('applyPendingChoices(["party", "partyId", "supplierId", "shipToPartyId"], true)');
  gone.fields.amount!.value = "600";
  gone.run("saveDraft(form)");
  assert.equal(gone.stored().partyId, "");
});

test("#266 follow-up: the lists put the waiting choices back where they arrive", async () => {
  const script = await read("app.js");
  assert.match(await functionSource("renderPickers"), /applyPendingChoices\(\["party", "partyId", "supplierId", "shipToPartyId"\], catalogueLoaded\);\s*showChosenCustomer\(\);/);
  assert.match(await functionSource("loadCatalogue"), /catalogueLoaded = true;[\s\S]*renderPickers\(\);[\s\S]*restorePendingLines\(\);/);
  assert.match(await functionSource("loadDeliveryChoices"), /if \(customerId !== ""\) applyPendingChoices\(\["shipToAddressId", "transporterId"\], true\);/);
  assert.equal((script.match(/forgetPendingDraft\(form\);/g) ?? []).length, 3, "cleared, reset and recorded forms wait for nothing");
});

/**
 * Issue #262 — a sale stopped for short stock offers "Enter the purchase bill", which opens Purchase
 * with the short goods already chosen; once that bill is recorded, "Back to the sale" returns to the
 * sale as it was typed. Runs the real functions from app.js.
 */
async function purchaseForSaleHarness(lines: Array<{ item: string; rate: string }>) {
  const script = await read("app.js");
  const locales = await localeCopy();
  const store = new Map<string, string>([["karobar.draft.sale", JSON.stringify({ party: "mehta", __lines: [{ item: "tmt", quantity: "600", rate: "90" }] })]]);
  const opened: string[] = [];
  const saved: string[] = [];
  const makeLine = (item: string, rate: string) => {
    // Issue #308 — the line's item is the picker's hidden field, as on the page.
    const picker = new TextBox();
    picker.value = item;
    const parts: Record<string, any> = { item: picker, rate: Object.assign(new TextBox(), { value: rate }), quantity: Object.assign(new TextBox(), { value: "1" }) };
    return { parts, querySelector: (selector: string) => parts[selector.match(/data-line-field="?([a-z]+)/)?.[1] ?? ""] ?? null };
  };
  const rows = lines.map((line) => makeLine(line.item, line.rate));
  const box = { querySelectorAll: () => rows };
  const noteText = { textContent: "" };
  const backButton = { textContent: "" };
  const note = { hidden: true, querySelector: (selector: string) => (selector === "[data-note-text]" ? noteText : backButton) };
  const dialog = { open: true, close() { this.open = false; } };
  const purchaseForm = { dataset: { draft: "purchase" } };
  const context: Record<string, unknown> = {
    state: { locale: "en-IN" }, copy: locales,
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) },
    document: {
      querySelector: (selector: string) => ({
        "#review-dialog": dialog, "#purchase-lines": box, '[data-draft="purchase"]': purchaseForm, "#purchase-for-sale-note": note,
      } as Record<string, unknown>)[selector] ?? null,
    },
    text: (key: string, values: Record<string, string>) => Object.entries(values).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, value), locales["en-IN"]![key]!),
    openView: (view: string) => opened.push(view),
    // The item list the purchase line can choose from.
    itemById: (id: string) => (["tmt", "soap"].includes(id) ? { id } : null),
    addPurchaseLine: () => { const row = makeLine("soap", ""); rows.push(row); return row; },
    setLineGstFromItem: () => undefined, showLineUnit: () => undefined,
    saveDraft: (form: { dataset: { draft: string } }) => saved.push(form.dataset.draft),
    JSON, Array, Object,
  };
  const line = (name: string) => script.match(new RegExp(`^const ${name} = .*$`, "m"))![0];
  vm.runInNewContext([
    line("SALE_WAITING_KEY"),
    await functionSource("shortStockOf"), await functionSource("saleWaitingForStock"), await functionSource("showPurchaseForSaleNote"),
    await functionSource("openPurchaseForSale"), await functionSource("purchaseForSaleRecorded"), await functionSource("backToSale"),
    "this.run = (code) => eval(code);",
  ].join("\n"), context);
  return { run: context.run as (code: string) => any, rows, note, noteText, backButton, dialog, opened, saved, store };
}

const REFUSAL = {
  code: "SALES_STOCK_NOT_ENOUGH",
  message: "You have 50 KGS of TMT Steel Bar 12mm in Bengaluru · Peenya godown. This bill asks for 600 KGS. If the goods have arrived, enter their purchase bill first, then make this sale.",
  details: { shortStock: JSON.stringify([{ itemId: "tmt", itemName: "TMT Steel Bar 12mm", warehouseId: "wh-main", warehouseName: "Bengaluru · Peenya godown", unit: "KGS", available: "50", required: "600", shortBy: "550" }]) },
};

test("#262: the refusal's button opens Purchase with the short item chosen and says which godown", async () => {
  const h = await purchaseForSaleHarness([{ item: "soap", rate: "" }]);
  assert.equal(h.run(`shortStockOf({ code: "SALE_DATE_AFTER_TODAY", details: {} })`), null, "only a short-stock refusal gets the button");
  const short = h.run(`shortStockOf(${JSON.stringify(REFUSAL)})`);
  assert.equal(short[0].itemId, "tmt");
  h.run(`openPurchaseForSale(shortStockOf(${JSON.stringify(REFUSAL)}))`);
  assert.equal(h.dialog.open, false);
  assert.deepEqual(h.opened, ["purchase"]);
  assert.equal(h.rows.length, 1, "the untouched line is used, not a second one added");
  assert.equal(h.rows[0]!.parts.item.value, "tmt");
  assert.equal(h.rows[0]!.parts.quantity.value, "", "the quantity is the supplier's bill's to say, never guessed");
  assert.deepEqual(h.saved, ["purchase"]);
  assert.equal(h.note.hidden, false);
  assert.equal(h.noteText.textContent, "For the sale you were making: it asks for 600 KGS of TMT Steel Bar 12mm, and Bengaluru · Peenya godown has 50 KGS. Type the quantity printed on the supplier's bill. The goods go into Bengaluru · Peenya godown.");
  assert.equal(h.backButton.textContent, "Back to the sale");
  // The sale as typed is still on the device, untouched.
  assert.deepEqual(JSON.parse(h.store.get("karobar.draft.sale")!).__lines, [{ item: "tmt", quantity: "600", rate: "90" }]);

  // After the purchase is recorded: the dialog carries the way back; pressing it returns to the sale.
  const recorded = h.run(`purchaseForSaleRecorded({ title: "Purchase recorded", effects: ["Stock: +550 KGS"] })`);
  assert.equal(recorded.backToSale, true);
  assert.equal(recorded.effects.at(-1), "The goods are in stock now. Go back to the sale: everything you typed is still there. Review it again to issue the bill.");
  h.dialog.open = true;
  h.run("backToSale()");
  assert.deepEqual(h.opened, ["purchase", "sale"]);
  assert.equal(h.dialog.open, false);
  assert.equal(h.note.hidden, true, "the purchase screen no longer speaks of the sale");
  assert.equal(h.store.has("karobar.draft.sale"), true, "going back never clears the sale");
});

test("#262: a supplier bill already being typed keeps its lines; the short item is added beside them", async () => {
  const filled = await purchaseForSaleHarness([{ item: "soap", rate: "40" }]);
  filled.run(`openPurchaseForSale(shortStockOf(${JSON.stringify(REFUSAL)}))`);
  assert.deepEqual(filled.rows.map((row) => [row.parts.item.value, row.parts.rate.value]), [["soap", "40"], ["tmt", ""]]);

  const already = await purchaseForSaleHarness([{ item: "tmt", rate: "64" }]);
  already.run(`openPurchaseForSale(shortStockOf(${JSON.stringify(REFUSAL)}))`);
  assert.deepEqual(already.rows.map((row) => [row.parts.item.value, row.parts.rate.value]), [["tmt", "64"]], "the item is not put on the bill twice");

  // Issue #308 — goods no longer on the item list are never put on the supplier bill.
  const gone = await purchaseForSaleHarness([{ item: "", rate: "" }]);
  gone.run(`openPurchaseForSale(shortStockOf(${JSON.stringify({ ...REFUSAL, details: { shortStock: JSON.stringify([{ ...JSON.parse(REFUSAL.details.shortStock)[0], itemId: "removed" }]) } })}))`);
  assert.deepEqual(gone.rows.map((row) => row.parts.item.value), [""]);
});

test("#262: the refusal dialog, the purchase screen and both languages carry the way through, and nothing lets the sale past", async () => {
  const [html, script, locales] = await Promise.all([read("index.html"), read("app.js"), localeCopy()]);
  assert.match(html, /<button class="primary-button" id="review-purchase" type="button" hidden data-i18n="enterPurchaseBill">/);
  assert.match(html, /<button class="primary-button" id="review-back-to-sale" type="button" hidden data-i18n="backToSale">/);
  assert.match(html, /id="purchase-for-sale-note"[^>]*hidden[\s\S]*?id="purchase-back-to-sale"/);
  assert.equal(locales["en-IN"]!.enterPurchaseBill, "Enter the purchase bill");
  for (const key of ["enterPurchaseBill", "backToSale", "purchaseForSale", "purchaseForSaleDone"]) assert.ok(locales["hi-IN"]![key], key);
  // The sale's review (the Payment slide, #305), its Record (Make bill) and the other screens' reviews
  // all show the refusal with the button.
  assert.equal((script.match(/showSaleFailure\(error\);/g) ?? []).length, 3);
  assert.match(await functionSource("reviewSaleOnSlide"), /showSaleFailure\(error\);/);
  assert.match(await functionSource("recordPending"), /showSaleFailure\(error\);/);
  // A Hindi reader gets the server's Hindi sentence, not "could not complete".
  assert.match(await functionSource("localizedError"), /SALES_STOCK_NOT_ENOUGH"\) return error\.details\?\.\[state\.locale\] \|\| error\.message;/);
  assert.doesNotMatch(script, /negativeOverride|override_negative/, "no way to let a short sale through from the screen");
  // A recorded supplier bill leaves a fresh Purchase form, so the next one never opens on its figures.
  assert.match(script, /if \(form\.dataset\.draft === "purchase"\) resetPurchaseForm\(form\);/);
  assert.match(await functionSource("resetPurchaseForm"), /form\.reset\(\);[\s\S]*replaceChildren\(\);\s*addPurchaseLine\(\);/);
});

// ------------------------------------------------------------------ issues #288 and #307

/** The done-screen module, loaded the way the browser loads it. */
const doneScreen = async () => import(pathToFileURL(resolve(root, "done-screen.js")).href);
const rupees = (locale: string) => (amount: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(amount);
const cashSale = { invoice: { id: "i1", number: "INV/26-27/000005", amount: 126 }, customer: { name: "Walk-in / cash customer", phone: null, walkIn: true }, paid: { mode: "CASH", amount: 126 }, due: 0, shop: "Sampoorna Traders", upiLink: null };
const UPI = "upi://pay?pa=sampoorna@okicici&pn=Sampoorna%20Traders&am=26.00&cu=INR&tn=INV%2F26-27%2F000006";
const partSale = { invoice: { id: "i2", number: "INV/26-27/000006", amount: 126 }, customer: { name: "ABC Traders", phone: "+91 98765 43210", walkIn: false }, paid: { mode: "UPI", amount: 100 }, due: 26, shop: "Sampoorna Traders", upiLink: UPI };

test("#307: the WhatsApp message and its UPI link, in English and Hindi — the link asks for the amount due only, with the bill number", async () => {
  const { shareMessage, whatsappLink, indianMobile } = await doneScreen();
  const locales = await localeCopy();
  const en = locales["en-IN"]!;
  const hi = locales["hi-IN"]!;

  assert.equal(shareMessage(cashSale, en, rupees("en-IN")), "Hello, thank you for shopping at Sampoorna Traders. Bill INV/26-27/000005: ₹126.00.\nPaid in full.");
  assert.equal(shareMessage(cashSale, hi, rupees("hi-IN")), "Namaste, Sampoorna Traders se khareedne ke liye dhanyavaad. Bill INV/26-27/000005: ₹126.00.\nPoora bhugtaan mil gaya.");
  assert.doesNotMatch(shareMessage(cashSale, en, rupees("en-IN")), /upi:/, "nothing is due, so nothing is asked for");

  const english = shareMessage(partSale, en, rupees("en-IN"));
  assert.equal(english, `Hello ABC Traders, thank you for shopping at Sampoorna Traders. Bill INV/26-27/000006: ₹126.00.\nStill to pay: ₹26.00.\nPay by UPI: ${UPI}`);
  const hindi = shareMessage(partSale, hi, rupees("hi-IN"));
  assert.equal(hindi, `Namaste ABC Traders, Sampoorna Traders se khareedne ke liye dhanyavaad. Bill INV/26-27/000006: ₹126.00.\nAbhi baaki: ₹26.00.\nUPI se chukayein: ${UPI}`);
  for (const message of [english, hindi]) {
    const link = new URL(/upi:\S+/.exec(message)![0]);
    assert.equal(link.searchParams.get("am"), "26.00", "the amount still due, never the bill total");
    assert.equal(link.searchParams.get("tn"), "INV/26-27/000006", "the bill number");
    assert.equal(link.searchParams.get("pa"), "sampoorna@okicici");
  }

  // The customer's own number, in WhatsApp's click-to-chat link, with the message as typed.
  const mobile = indianMobile(partSale.customer.phone);
  assert.equal(mobile, "9876543210");
  const chat = new URL(whatsappLink(mobile, hindi));
  assert.equal(`${chat.origin}${chat.pathname}`, "https://wa.me/919876543210");
  assert.equal(chat.searchParams.get("text"), hindi);
  // A number is never guessed from something that is not one.
  for (const typed of ["", "12345", "5876543210", "98765432101", null]) assert.equal(indianMobile(typed), null, String(typed));
  assert.equal(indianMobile("098765 43210"), "9876543210");
});

test("#307: the done screen's one line says where the money went, in English and Hindi", async () => {
  const { doneLine } = await doneScreen();
  const locales = await localeCopy();
  assert.equal(doneLine(cashSale, locales["en-IN"], rupees("en-IN")), "Cash received from Walk-in. Stock updated.");
  assert.equal(doneLine(cashSale, locales["hi-IN"], rupees("hi-IN")), "walk-in grahak se nakad mil gaya. Stock update ho gaya.");
  const credit = { ...partSale, paid: null, due: 126 };
  assert.equal(doneLine(credit, locales["en-IN"], rupees("en-IN")), "Added to ABC Traders’ khata. Stock updated.");
  assert.equal(doneLine(credit, locales["hi-IN"], rupees("hi-IN")), "ABC Traders ke khate mein jud gaya. Stock update ho gaya.");
  assert.equal(doneLine(partSale, locales["en-IN"], rupees("en-IN")), "UPI payment of ₹100.00 received; ₹26.00 added to ABC Traders’ khata. Stock updated.");
});

test("#288/#307: the sale form offers the walk-in customer and paid now by cash, UPI or card; the done screen remembers the printer", async () => {
  const [html, script, done] = await Promise.all([read("index.html"), read("app.js"), read("done-screen.js")]);
  const sale = html.slice(html.indexOf('data-draft="sale"'), html.indexOf('id="sale-bill-panel"'));
  assert.match(sale, /id="sale-walk-in" data-i18n="walkInChoose"/);
  // Issue #305 — six tiles set the same fields the form always sent: terms, paidBy and paidAmount.
  for (const way of ["CASH", "UPI", "CARD", "UDHAAR", "PART", "CHEQUE"]) assert.match(sale, new RegExp(`class="pay-tile" data-pay="${way}"`));
  assert.match(sale, /<select name="terms" id="sale-terms" hidden aria-hidden="true" tabindex="-1"><option value="now" data-i18n="payNow">/);
  for (const days of ["0", "7", "15", "30"]) assert.match(sale, new RegExp(`<option value="${days}"[\\s\\S]*data-days="${days}"`));
  for (const mode of ["CASH", "UPI", "CARD"]) assert.match(sale, new RegExp(`<select name="paidBy" id="sale-paid-by">[\\s\\S]*<option value="${mode}"`));
  // Udhaar sends no paidBy and no amount at all: both are switched off, so nothing is received.
  assert.match(await functionSource("showPaidBy"), /field\.querySelector\("select"\)\.disabled = terms !== "now";/);
  assert.match(await functionSource("showPaidBy"), /amount\.disabled = way !== "PART";/);
  // Cheque is not taken on the bill: its tile is off and says where a cheque is entered.
  assert.match(sale, /data-pay="CHEQUE" aria-pressed="false" aria-describedby="sale-cheque-note" disabled/);
  assert.match(html, /<dialog id="done-screen" class="done-screen" aria-labelledby="done-title"><\/dialog>/);
  assert.match(script, /await import\("\.\/done-screen\.js"\)/);
  assert.match(done, /export const PRINTER_KEY = "karobar\.printer";/);
  for (const format of ["A4", "THERMAL_80MM", "THERMAL_58MM"]) assert.match(done, new RegExp(`\\["${format}", "`));
  assert.match(html, /<option value="THERMAL_58MM" data-i18n="billPaperThermal58">/);
  // The tick pops once, and not at all for somebody who asked for less motion (the global rule).
  const css = await read("styles.css");
  assert.match(css, /\.done-tick \{[^}]*animation: tick-pop [^;]* 1;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{[^}]*animation: none !important/);
  // A walk-in refused at ₹50,000 gets one button to name the customer.
  assert.match(html, /id="review-add-customer" type="button" hidden data-i18n="addNamedCustomer"/);
  assert.match(script, /\["WALK_IN_NAME_REQUIRED", "WALK_IN_DELIVERY"\]\.includes\(error\?\.code\)/);
  // The state is filled in from the PIN code.
  assert.match(script, /"\/api\/pincode\/state"/);
});
