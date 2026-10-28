/**
 * Issue #495 — the screens that talk to the government, the bank and the customer, driven in a real
 * browser: the GST return (prepare, approve and export are three separate acts), the quotation and
 * proforma, the bank connection and the page the bank sends the customer back to, returns, reminders,
 * vehicle checks, the purchase check, PIN codes, Ask and the service-health screen.
 *
 * Each test clicks the screen's own buttons and asserts what the page sent and what the shopkeeper is
 * then shown. Before, apps/web/test/web.test.ts only looked for the route strings in app.js.
 * Everything a test needs is made for it and named for the run.
 */
import { expect, test, type Page } from "@playwright/test";
import { apiSignIn, baseURL, signIn } from "./helpers.ts";
import { keepOffline } from "./offline.ts";
import { addCustomer, addGoods, distinct, openShop, recordSale, type Shop } from "./arrange.ts";
import { grantVehicleRecordConsent } from "./db.ts";
import { watchPage, type PageWatch } from "./page-watch.ts";

let shop: Shop;
let goods: { id: string; name: string };
let customer: { id: string; name: string };
let invoice: { id: string; number: string };
let watch: PageWatch;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    // The transport department's record can be asked about a vehicle only once the shop has consented to it.
    await grantVehicleRecordConsent();
    shop = await openShop(request, await apiSignIn(request));
    goods = await addGoods(request, shop, { name: distinct("Action Soap"), stock: "800", price: "25" });
    customer = await addCustomer(request, shop, distinct("Action Customer"));
    const sale = await recordSale(request, shop, { customerId: customer.id, itemId: goods.id, quantity: "2", rate: "25" });
    invoice = sale.invoice as { id: string; number: string };
  } finally { await request.dispose(); }
});

async function openScreen(page: Page, view: string) {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  await page.goto(`/#${view}`);
  await expect(page.locator(".view.active")).toHaveAttribute("id", `view-${view}`);
}
const dialog = (page: Page) => ({ box: page.locator("#review-dialog"), title: page.locator("#review-title"), body: page.locator("#review-body"), confirm: page.locator("#review-confirm") });
/** Fills the customer and goods a document form asks for, from the lists the page has loaded. */
async function pickCustomerAndGoods(page: Page, form: string) {
  await expect.poll(() => page.locator(`${form} [name="customerId"] option`).count()).toBeGreaterThan(2);
  await page.locator(`${form} [name="customerId"]`).selectOption(customer.id);
  await page.locator(`${form} [name="item"]`).selectOption(goods.id);
}

test("GST return: preparing only reads the books; approving and exporting are their own buttons, in that order", async ({ page }) => {
  await openScreen(page, "gst-returns");
  // A month of its own, so a return approved by another spec (or an earlier run) is not in the way.
  await page.locator('#gst-return-form [name="period"]').fill("2026-06");
  await expect(page.locator("#gst-approve"), "nothing to approve before a return is prepared").toBeDisabled();
  await expect(page.locator("#gst-export"), "and nothing to export").toBeDisabled();
  const mark = watch.mark();
  await page.locator('#gst-return-form button[type="submit"]').click();
  await expect(page.locator("#view-gst-returns")).toContainText("Does it agree with your books?");
  expect(watch.calls(mark).filter((call) => /gst-returns/.test(call))).toEqual(["POST /api/gst-returns/prepare"]);
  expect(watch.bodyOf("/api/gst-returns/prepare", mark).period).toBe("2026-06");
  await expect(page.locator("#view-gst-returns")).toContainText("June 2026");
  await expect(page.locator("#view-gst-returns")).toContainText("This only reads your books and works out what the return would say. Nothing is sent to the government here.");
  await expect(page.locator("#gst-approve")).toBeEnabled();
  await expect(page.locator("#gst-export"), "a return that is not approved cannot be exported").toBeDisabled();

  await page.locator("#gst-approve").click();
  await expect(page.locator("#gst-export")).toBeEnabled();
  expect(watch.calls(mark)).toContain("POST /api/gst-returns/approve");
  await expect(page.locator("#gst-approve"), "approved once, not again").toBeDisabled();

  await page.locator("#gst-export").click();
  const exported = await watch.requested("/api/gst-returns/export", mark);
  expect(JSON.parse(exported.body!).period, "the month that was approved is the month exported").toBe("2026-06");
  expect(watch.problems).toEqual([]);
});

test("a quotation is checked without using a number or a record; a proforma must say what the money is for", async ({ page }) => {
  await openScreen(page, "presale");
  await expect(page.locator("#presale-advance-form"), "no advance form until a proforma is open").toBeHidden();
  await expect(page.locator("#presale-refund-form")).toBeHidden();
  await pickCustomerAndGoods(page, "#presale-form");
  const quotationRule = await page.locator("#presale-kind-rule").innerText();
  await expect(page.locator('#presale-form [name="purpose"]'), "a price offer asks no purpose").toHaveJSProperty("required", false);
  const mark = watch.mark();
  await page.locator('#presale-form button[type="submit"]').click();
  await expect(page.locator("#presale-issue")).toBeVisible();
  const checked = watch.bodyOf("/api/presale/preview", mark);
  expect([checked.kind, checked.customerId, checked.item]).toEqual(["QUOTATION", customer.id, goods.id]);
  expect(watch.calls(mark), "checking issues nothing").not.toContain("POST /api/presale/issue");
  await expect(page.locator("#view-presale")).toContainText("Checking saves nothing and uses no number. The number is given only when you issue it.");
  await expect(page.locator("#view-presale")).toContainText("Neither is a tax invoice: nothing goes into your books, your stock or GST until you issue the real bill.");

  // A proforma is an advance bill: it says so, and will not be checked until it says what the advance is for.
  await page.locator('#presale-form [name="kind"]').selectOption("PROFORMA");
  await expect(page.locator("#presale-kind-rule")).not.toHaveText(quotationRule);
  await expect(page.locator('#presale-form [name="purpose"]')).toHaveJSProperty("required", true);
  const before = watch.mark();
  await page.locator('#presale-form button[type="submit"]').click();
  expect(watch.calls(before), "without a purpose the proforma is not even checked").not.toContain("POST /api/presale/preview");
  await page.locator('#presale-form [name="purpose"]').fill("Advance for soap before dispatch");
  await page.locator('#presale-form button[type="submit"]').click();
  expect(JSON.parse((await watch.requested("/api/presale/preview", before)).body!).kind).toBe("PROFORMA");
});

test("the bank sends the customer back to the app, which finishes the request there — and refuses a reply it did not ask for", async ({ page }) => {
  await openScreen(page, "bank-feeds");
  const { box, title, confirm } = dialog(page);
  const mark = watch.mark();
  await page.locator("#bank-feed-connect").click();
  await expect(box).toBeVisible();
  await expect(title).toHaveText("Start bank permission");
  expect(watch.calls(mark), "asking for permission connects nothing yet").not.toContain("POST /api/bank-feeds/consent/complete");
  await confirm.click();
  await watch.requested("/api/bank-feeds/consent", mark);
  // The tab remembers which request it made, and under which state.
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("karobar.bankConsent"))).not.toBeNull();
  const consent = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karobar.bankConsent")!)) as { connectionId: string; consentState: string };
  expect(consent.connectionId && consent.consentState).toBeTruthy();
  await page.keyboard.press("Escape");

  // A reply carrying a state this tab never handed out is not sent on, the code leaves the address bar,
  // and the remembered request is dropped.
  const refused = watch.mark();
  await page.goto("/?code=forged-code&state=not-the-one-we-gave");
  await expect(page.locator(".view.active")).toHaveAttribute("id", "view-bank-feeds");
  await expect(box).toBeVisible();
  expect(await page.evaluate(() => location.search), "the code is gone from the address bar").toBe("");
  expect(await page.evaluate(() => location.hash)).toBe("#bank-feeds");
  expect(await page.evaluate(() => sessionStorage.getItem("karobar.bankConsent"))).toBeNull();
  expect(watch.calls(refused), "a forged return completes nothing").not.toContain("POST /api/bank-feeds/consent/complete");
});

test("a bank return with the right state and a code completes the connection exactly once, and the spent code is not left behind", async ({ page }) => {
  await openScreen(page, "bank-feeds");
  const { box, confirm } = dialog(page);
  const mark = watch.mark();
  await page.locator("#bank-feed-connect").click();
  await expect(box).toBeVisible();
  await confirm.click();
  await watch.requested("/api/bank-feeds/consent", mark);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("karobar.bankConsent"))).not.toBeNull();
  const consent = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karobar.bankConsent")!)) as { connectionId: string; consentState: string };
  await page.keyboard.press("Escape");

  // The same tab goes to the bank's page and comes back with the code.
  const returned = watch.mark();
  await page.goto(`/?code=sandbox-approved&state=${encodeURIComponent(consent.consentState)}`);
  const complete = await watch.requested("/api/bank-feeds/consent/complete", returned);
  const sent = JSON.parse(complete.body!) as Record<string, string>;
  expect([sent.connectionId, sent.authorizationCode, sent.consentState]).toEqual([consent.connectionId, "sandbox-approved", consent.consentState]);
  expect(watch.calls(returned).filter((call) => call === "POST /api/bank-feeds/consent/complete")).toHaveLength(1);
  expect(await page.evaluate(() => location.search), "the spent code is not left in the address bar or the history").toBe("");
  expect(await page.evaluate(() => sessionStorage.getItem("karobar.bankConsent"))).toBeNull();
});

test("Returns: a whole-bill credit note and a price correction are different choices, and a price correction must say why", async ({ page }) => {
  await openScreen(page, "returns");
  const { box } = dialog(page);
  await expect(page.locator(`#return-document option[value="${invoice.id}"]`)).toBeAttached();
  await page.locator("#return-document").selectOption(invoice.id);
  expect(await page.locator("#return-line option").evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value)), "the whole bill can be credited in one go").toContain("__whole__");
  await expect(page.locator("#return-price"), "the price-correction questions are not asked of a goods return").toBeHidden();
  await expect(page.locator("#return-price"), "and are not sent").toHaveJSProperty("disabled", true);

  await page.locator('#return-form [name="mode"]').selectOption("PRICE");
  await expect(page.locator("#return-price")).toBeVisible();
  await expect(page.locator("#return-price")).toHaveJSProperty("disabled", false);
  // Nothing is chosen for the shopkeeper: a wrong bill and a discount given afterwards are different things in law.
  expect(await page.locator('#return-form [name="cause"] option').evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value))).toEqual(["", "INVOICE_ERROR", "DISCOUNT_AFTER_SALE"]);
  await expect(page.locator('#return-form [name="cause"]')).toHaveValue("");
  await expect(page.locator('#return-form [name="cause"]')).toHaveJSProperty("required", true);
  const mark = watch.mark();
  await page.locator('#return-form [name="reference"]').fill("CN-REF-1");
  await page.locator('#return-form [name="reason"]').fill("Priced wrongly");
  await page.locator('#return-form button[type="submit"]').click();
  expect(watch.calls(mark), "without a cause the form is not sent").not.toContain("POST /api/returns/preview");

  // Back to a goods return: the questions go away again and the whole bill can be previewed.
  await page.locator('#return-form [name="mode"]').selectOption("");
  await expect(page.locator("#return-price")).toBeHidden();
  await expect(page.locator("#return-price")).toHaveJSProperty("disabled", true);
  await page.locator("#return-line").selectOption("__whole__");
  await page.locator('#return-form [name="reason"]').fill("Customer returned the whole bill");
  await page.locator('#return-form button[type="submit"]').click();
  const preview = await watch.requested("/api/returns/preview", mark);
  expect(JSON.parse(preview.body!).lineId).toBe("__whole__");
  await expect(box).toBeVisible();
  await expect(page.locator("#review-dialog")).toHaveAttribute("aria-busy", "false");
  expect(watch.calls(mark), "a preview records nothing").not.toContain("POST /api/returns/record");
});

test("Reminders: \"send all\" says what it sent, or why it left every bill alone", async ({ page }) => {
  await openScreen(page, "reminders");
  const { box, title, body } = dialog(page);
  const mark = watch.mark();
  await page.locator("#reminders-send-all").click();
  await watch.requested("/api/reminders/send-all", mark);
  await expect(box).toBeVisible();
  await expect(page.locator("#review-dialog")).toHaveAttribute("aria-busy", "false");
  await expect(title).toHaveText("Nothing needed sending");
  await expect(body).toHaveText("Every open bill was deliberately left alone today. The reasons are on this screen.");
});

test("Service health shows the checks, the recurring jobs and what stays private", async ({ page }) => {
  const mark0 = 0;
  await openScreen(page, "operations");
  await watch.requested("/api/operations", mark0);
  await expect(page.locator("#view-operations")).toContainText("Customer data stays private.");
  await expect(page.locator("#view-operations")).toContainText("Health checks");
  await expect(page.locator("#operations-recurring")).toContainText("Daily collection reminders");
  expect(await page.locator("#operations-recurring li, #operations-recurring .activity-row").count(), "recurring work is listed").toBeGreaterThanOrEqual(4);
});

test("Vehicle check: the vehicle and the bill go to the server, and a vehicle that cannot carry the load is told so — and cannot be overridden", async ({ page }) => {
  await openScreen(page, "vehicle");
  await page.locator('#vehicle-form [name="invoice"]').selectOption(invoice.id);
  await page.locator('#vehicle-form [name="vehicle"]').selectOption("KA05MN9012"); // a two-wheeler
  await page.locator('#vehicle-form [name="weightKg"]').fill("5000");
  const mark = watch.mark();
  await page.locator('#vehicle-form button[type="submit"]').click();
  const checked = JSON.parse((await watch.requested("/api/vehicles/check", mark)).body!) as Record<string, string>;
  expect([checked.vehicle, checked.invoice, checked.weightKg]).toEqual(["KA05MN9012", invoice.id, "5000"]);
  await expect(page.locator("#vehicle-held")).toContainText(/cannot carry this consignment/);
  // A finding that can be answered may be overridden on the owner's authority, with a reason; one that cannot, is not even listed.
  await expect(page.locator("#view-vehicle")).toContainText("A vehicle that physically cannot carry the load is not one of them.");
  await expect(page.locator("#view-vehicle")).toContainText("It changes no weight, no capacity and no government record.");
  expect(await page.locator("#vehicle-override-codes option").allTextContents(), "a two-wheeler that cannot carry the load is not offered").not.toContain("A two-wheeler cannot carry this consignment");
});

test("Purchase check: comparing a month sends the month; a typed row needs the supplier's GST number, bill number and value", async ({ page }) => {
  await openScreen(page, "itc");
  const mark = watch.mark();
  await page.locator('#itc-form button[type="submit"]').click();
  const checked = await watch.requested("/api/itc", mark);
  expect(JSON.parse(checked.body!).period).toMatch(/^\d{4}-\d{2}$/);
  await expect(page.locator("#view-itc")).toContainText("This only compares. Nothing is claimed, sent or filed from this screen.");
  // The typed row cannot be sent half filled in.
  const before = watch.mark();
  await page.locator('#itc-typed-form button[type="submit"]').click();
  expect(watch.calls(before)).not.toContain("POST /api/itc/typed");
  const missing = await page.locator("#itc-typed-form :invalid").evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).name));
  for (const name of ["gstin", "number", "taxableValue"]) expect(missing, `${name} is required`).toContain(name);
});

test("a new customer's state is filled in from the PIN code, and can still be chosen by hand", async ({ page }) => {
  await openScreen(page, "payment");
  await expect.poll(() => page.locator('[data-draft="payment"] [name="partyId"] option').count()).toBeGreaterThan(1);
  await page.locator('[data-draft="payment"] [name="partyId"]').selectOption("__add__");
  await expect(page.locator("#customer-dialog")).toBeVisible();
  const mark = watch.mark();
  await page.locator('#customer-form [name="pincode"]').pressSequentially("411026");
  const asked = await watch.requested("/api/pincode/state", mark);
  expect(JSON.parse(asked.body!).pincode).toBe("411026");
  await expect(page.locator("#customer-states")).toHaveValue("27");
  // A PIN code that is not six digits is not even asked about.
  const before = watch.mark();
  await page.locator('#customer-form [name="pincode"]').fill("");
  await page.locator('#customer-form [name="pincode"]').pressSequentially("4110");
  expect(watch.calls(before)).not.toContain("POST /api/pincode/state");
});

test("dates fill in as today, except the one that is the business's own promise: how long a quotation's price holds", async ({ page }) => {
  await openScreen(page, "presale");
  await expect(page.locator('#presale-form [name="date"]')).toHaveValue(shop.today);
  await expect(page.locator('#presale-form [name="validUntil"]'), "left empty: no promise is made for the shopkeeper").toHaveValue("");
});

test("Ask: the answer names its source, and it is still on screen — in Hindi — when the language is switched", async ({ page }) => {
  await openScreen(page, "ask");
  const mark = watch.mark();
  await page.locator("#ask-question").fill("Who owes me money?");
  await page.locator("#ask-send").click();
  const asked = await watch.requested("/api/assistant/ask", mark);
  expect(JSON.parse(asked.body!).question).toBe("Who owes me money?");
  await expect(page.locator("#view-ask")).toContainText(/Your customers owe you ₹[\d,.]+ across \d+ customers?\./);
  await expect(page.locator("#view-ask")).toContainText("Where these figures come from");
  await page.locator("#locale").selectOption("hi-IN");
  await expect(page.locator("#view-ask")).toContainText("पूछिए");
  await expect(page.locator("#view-ask"), "the question asked is still shown").toContainText("Who owes me money?");
  await expect(page.locator("#view-ask"), "the example questions are Hindi").toContainText("मुझे किससे पैसा लेना है?");
});

test("setting up a business reads the full list of states from the server, not twelve typed into the page", async ({ page }) => {
  await openScreen(page, "setup");
  await expect.poll(() => page.locator("#setup-states option").count()).toBeGreaterThan(30);
  const names = await page.locator("#setup-states option").allTextContents();
  for (const state of ["Maharashtra", "Ladakh", "Karnataka"]) expect(names.some((name) => name.includes(state)), state).toBe(true);
  expect(watch.sent.some((sent) => sent.path === "/api/states")).toBe(true);
});
