/**
 * Issue #495 — what happens around a sale, driven in a real browser: the stock refusal and its way
 * through Purchase and back (#262), the form after a bill is recorded (#233/#288), the done screen
 * and its WhatsApp message (#307), the choices the sale form offers (#288/#305), the figures the
 * server (not the page) works out (#306), and cancelling a bill (#233).
 *
 * sale-slides.spec.ts walks the four slides end to end for the full trade; these cover the rest of
 * what apps/web/test/web.test.ts used to check by reading app.js as text. Every item, customer and
 * supplier is made for the spec and named for the run, so the shared database never changes a result.
 */
import { expect, test, type Page } from "@playwright/test";
import { apiSignIn, baseURL, pickItem, signIn } from "./helpers.ts";
import { keepOffline } from "./offline.ts";
import { addCustomerWithPhone, addGoods, distinct, openShop, type Shop } from "./arrange.ts";
import { respondWith, watchPage, type PageWatch } from "./page-watch.ts";

let shop: Shop;
let steel: { id: string; name: string };
let soap: { id: string; name: string };
let buyer: { id: string; name: string };
let buyerPhone = "";
let watch: PageWatch;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    shop = await openShop(request, await apiSignIn(request));
    // 500 KGS of steel in stock, so 10 sell and 600 do not; 100 soaps for the counter.
    steel = await addGoods(request, shop, { name: distinct("Sale Steel"), unit: "KGS", price: "90", rate: "1800", hsnSac: "72142000", stock: "500", cost: "64" });
    soap = await addGoods(request, shop, { name: distinct("Sale Soap"), price: "30", stock: "100" });
    // A mobile number new to every run (the app treats a second customer with the same number as the same customer).
    buyerPhone = `9${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`;
    buyer = await addCustomerWithPhone(request, shop, distinct("Kavita Stores"), buyerPhone);
  } finally { await request.dispose(); }
});

test.beforeEach(async ({ page }) => {
  watch = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  await page.goto("/#sale");
  // The pickers fill once the catalogue has answered.
  await expect(page.locator('[data-draft="sale"] [name="party"]')).not.toHaveValue("");
  await expect(page.locator("#sale-lines [data-item-search]").first()).toBeVisible();
});

const slide = (page: Page) => page.locator("#sale-frame [data-slide]:not([hidden])");
const review = (page: Page) => ({ dialog: page.locator("#review-dialog"), title: page.locator("#review-title"), body: page.locator("#review-body") });

/** Focuses a box, selects what is in it, and types over it: the keyboard's way of "tap the number". */
async function typeInto(page: Page, selector: string, value: string) {
  const box = page.locator(selector).last();
  await box.focus();
  await box.evaluate((input) => { (input as HTMLInputElement).select(); });
  await page.keyboard.type(value);
}
const nextSlide = async (page: Page, expected: string) => { await page.locator("#sale-next").click(); await expect(slide(page)).toHaveAttribute("data-slide", expected); };
/** Takes this customer on the Customer slide, from the customer list (the chip row only offers five). */
const chooseCustomer = (page: Page, id: string) => page.locator('[data-draft="sale"] select[name="party"]').selectOption({ value: id });
/** Arrives on the Payment slide with the items already typed. */
async function toPayment(page: Page, item: { name: string }, quantity: string, rate: string, customerId?: string) {
  await pickItem(page, "#sale-lines", item.name);
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', quantity);
  await typeInto(page, '#sale-lines [data-line-field="rate"]', rate);
  await nextSlide(page, "customer");
  if (customerId !== undefined) await chooseCustomer(page, customerId);
  await nextSlide(page, "payment");
}
const sentLines = (path: string, from: number) => JSON.parse(watch.bodyOf(path, from).lines!) as Array<Record<string, string>>;

test("a sale for more than is in stock is refused with the way to fix it: the purchase bill, which comes back to the sale", async ({ page }) => {
  const { dialog, title, body } = review(page);
  await pickItem(page, "#sale-lines", steel.name);
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', "600");
  await typeInto(page, '#sale-lines [data-line-field="rate"]', "90");
  await nextSlide(page, "customer");

  // A walk-in customer cannot be billed this much: the refusal arrives with one button to name the customer.
  await nextSlide(page, "payment");
  await expect(dialog).toBeVisible();
  await expect(title).toHaveText("Nothing was saved");
  await expect(page.locator("#review-add-customer")).toBeVisible();
  await expect(page.locator("#review-add-customer")).toHaveText("Add the customer's name and address");
  await expect(page.locator("#review-purchase"), "this refusal is not about stock").toBeHidden();
  await page.locator("#review-cancel").click();
  await expect(dialog).toBeHidden();
  await page.locator("#sale-slide-payment").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(slide(page)).toHaveAttribute("data-slide", "customer");
  await chooseCustomer(page, buyer.id);
  await nextSlide(page, "payment");

  await expect(page.locator("#review-purchase")).toBeVisible({ timeout: 15_000 });
  const refusal = (await body.innerText()).trim();
  const stock = /^You have (\d+) KGS of (.+?) in (.+?)\. This bill asks for 600 KGS\./.exec(refusal);
  expect(stock, refusal).not.toBeNull();
  const [, available, , godown] = stock!;
  expect(available).toBe("500");
  await expect(title).toHaveText("Nothing was saved");
  // The only ways out are to keep editing or to enter the purchase: nothing lets the short sale through.
  await expect(page.locator("#review-dialog .dialog-actions button:visible")).toHaveText(["Close", "Enter the purchase bill"]);
  expect(watch.calls().includes("POST /api/sales/record"), "no bill was made").toBe(false);

  // The server's own sentence reaches a Hindi reader, not "could not complete".
  await page.locator("#locale").selectOption("hi-IN");
  await expect(body).toHaveText(/[ऀ-ॿ]/);
  await expect(body).not.toHaveText(refusal);
  await page.locator("#locale").selectOption("en-IN");
  await expect(body).toHaveText(refusal);

  await page.locator("#review-purchase").click();
  await expect(page.locator(".view.active")).toHaveAttribute("id", "view-purchase");
  await expect(dialog, "the dialog closes").toBeHidden();
  // Purchase opens with the short item chosen, the quantity left for the supplier's bill to say.
  await expect(page.locator("#purchase-lines [data-item-search]")).toHaveValue(steel.name);
  await expect(page.locator('#purchase-lines [data-line-field="item"]'), "the untouched line is used, not a second one added").toHaveCount(1);
  await expect(page.locator('#purchase-lines [data-line-field="quantity"]'), "the quantity is never guessed").toHaveValue("");
  await expect(page.locator("#purchase-for-sale-note [data-note-text]")).toHaveText(`For the sale you were making: it asks for 600 KGS of ${steel.name}, and ${godown} has 500 KGS. Type the quantity printed on the supplier's bill. The goods go into ${godown}.`);
  await expect(page.locator("#purchase-back-to-sale")).toHaveText("Back to the sale");
  // The sale as typed is still on the device, untouched.
  const sale = await page.evaluate(() => JSON.parse(localStorage.getItem("karobar.draft.sale")!));
  expect(sale.__lines.map((line: any) => [line.quantity, line.rate])).toEqual([["600", "90"]]);

  // Enter the supplier's bill: the review ends with the way back to the sale.
  await page.locator('[data-draft="purchase"] [name="supplierId"]').selectOption(shop.supplier.id);
  await page.locator('[data-draft="purchase"] [name="reference"]').fill(distinct("SRS"));
  await typeInto(page, '#purchase-lines [data-line-field="quantity"]', "600");
  await typeInto(page, '#purchase-lines [data-line-field="rate"]', "64");
  await page.locator('[data-draft="purchase"] button[type="submit"]').click();
  await expect(page.locator("#review-confirm")).toBeVisible();
  await page.locator("#review-confirm").click();
  await expect(page.locator("#review-back-to-sale")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#review-effects")).toContainText("The goods are in stock now. Go back to the sale: everything you typed is still there. Review it again to issue the bill.");
  await page.locator("#review-back-to-sale").click();
  await expect(page.locator(".view.active")).toHaveAttribute("id", "view-sale");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#purchase-for-sale-note"), "the purchase screen no longer speaks of the sale").toBeHidden();
  await expect(page.locator('#sale-lines [data-line-field="quantity"]'), "everything typed on the sale is still there").toHaveValue("600");
  // A recorded supplier bill leaves a fresh Purchase form, so the next one never opens on its figures.
  await page.evaluate(() => { location.hash = "#purchase"; });
  await expect(page.locator('[data-draft="purchase"] [name="reference"]')).toHaveValue("");
  await expect(page.locator('#purchase-lines [data-line-field="item"]')).toHaveCount(1);
  await expect(page.locator('#purchase-lines [data-line-field="quantity"]'), "a new line, with the form's own starting quantity — not the 600 just bought").toHaveValue("1");
  expect(watch.problems).toEqual([]);
});

test("the payment slide offers six ways to pay: part paid asks for an amount, udhaar for the days, and a cheque is sent to its own screen", async ({ page }) => {
  await pickItem(page, "#sale-lines", steel.name);
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', "10");
  await typeInto(page, '#sale-lines [data-line-field="rate"]', "90");
  await nextSlide(page, "customer");
  await expect(page.locator('#sale-customer-choices [aria-pressed="true"]'), "a new sale starts with the walk-in customer chosen").toHaveText("Walk-in / cash customer");
  await chooseCustomer(page, buyer.id);
  await nextSlide(page, "payment");

  const tiles = await page.locator("#sale-frame [data-pay]").evaluateAll((all) => all.map((tile) => ({ way: (tile as HTMLElement).dataset.pay, label: (tile as HTMLElement).innerText, pressed: tile.getAttribute("aria-pressed"), disabled: (tile as HTMLButtonElement).disabled })));
  expect(tiles).toEqual([
    { way: "CASH", label: "Cash", pressed: "true", disabled: false }, { way: "UPI", label: "UPI", pressed: "false", disabled: false },
    { way: "CARD", label: "Card", pressed: "false", disabled: false }, { way: "UDHAAR", label: "Udhaar", pressed: "false", disabled: false },
    { way: "PART", label: "Part paid", pressed: "false", disabled: false }, { way: "CHEQUE", label: "Cheque", pressed: "false", disabled: true },
  ]);
  await expect(page.locator("#sale-cheque-note"), "the cheque tile is off, and the slide says where a cheque is entered").toBeVisible();
  await expect(page.locator("#sale-cheque-note")).toContainText(/heque/);

  // Cash, UPI and card: the money is received now, by that mode, and the amount box is off.
  const paid = () => page.evaluate(() => { const box = (name: string) => document.querySelector(`[data-draft="sale"] [name="${name}"]`) as HTMLInputElement; return { terms: box("terms").value, paidBy: box("paidBy").value, paidByOff: box("paidBy").disabled, amountOff: box("paidAmount").disabled }; });
  await page.locator('[data-pay="UPI"]').click();
  expect(await paid()).toEqual({ terms: "now", paidBy: "UPI", paidByOff: false, amountOff: true });
  await page.locator('[data-pay="CARD"]').click();
  expect((await paid()).paidBy).toBe("CARD");
  // Udhaar: nothing is received — no mode and no amount go to the server — and the days to pay within appear.
  await page.locator('[data-pay="UDHAAR"]').click();
  const udhaar = await paid();
  expect([udhaar.paidByOff, udhaar.amountOff]).toEqual([true, true]);
  await expect(page.locator("#sale-udhaar-days")).toBeVisible();
  const chips = await page.locator("#sale-udhaar-days [data-days]").allInnerTexts();
  expect(chips.slice(1), "the days to pay within are said in words").toEqual(["7 days", "15 days", "30 days"]);
  expect(await page.locator("#sale-udhaar-days [data-days]").evaluateAll((chips) => chips.map((chip) => (chip as HTMLElement).dataset.days))).toEqual(["0", "7", "15", "30"]);
  await expect(page.locator('#sale-udhaar-days [aria-pressed="true"]')).toHaveAttribute("data-days", "30");
  await page.locator('#sale-udhaar-days [data-days="7"]').click();
  await expect(page.locator('[data-draft="sale"] [name="terms"]')).toHaveValue("7");
  // Part paid: the amount box opens, and only now.
  await page.locator('[data-pay="PART"]').click();
  await expect(page.locator("#sale-part-paid")).toBeVisible();
  expect((await paid()).amountOff).toBe(false);
  await expect(page.locator("#sale-udhaar-days")).toBeHidden();
  await page.locator('[data-pay="CASH"]').click();
  await expect(page.locator("#sale-part-paid")).toBeHidden();
  await expect(page.locator('[data-draft="sale"] [name="paidAmount"]')).toBeDisabled();
});

test("a part-paid sale is recorded as typed; the done screen says where the money went, offers the customer a WhatsApp message with the amount still due, and the form is left fresh", async ({ page }) => {
  await toPayment(page, soap, "10", "30", buyer.id);
  await page.locator('[data-pay="PART"]').click();
  await page.locator('[data-draft="sale"] [name="paidAmount"]').focus();
  await page.keyboard.type("100");
  await page.locator('[data-draft="sale"] [name="paidBy"]').selectOption("UPI");
  await expect(page.locator("#sale-review-ok")).toBeVisible();
  await expect(page.locator("#sale-next")).toHaveText("Make bill");
  const mark = watch.mark();
  await page.locator("#sale-next").click();
  const done = page.locator('[data-slide="done"]');
  await expect(done).toBeVisible({ timeout: 15_000 });

  const record = watch.bodyOf("/api/sales/record", mark);
  expect([record.paidAmount, record.paidBy, record.terms]).toEqual(["100", "UPI", "now"]);
  expect(record.requestId, "every sale carries its own key, so pressing twice is one bill").toMatch(/^[0-9a-f-]{36}$/);
  expect(sentLines("/api/sales/record", mark).map((line) => [line.quantity, line.rate])).toEqual([["10", "30"]]);

  await expect(done).toContainText("Bill made");
  // 10 × ₹30 = ₹300 + 5% GST ₹15 = ₹315, of which ₹100 came by UPI: the rest goes on the customer's khata.
  await expect(done).toContainText(`UPI payment of ₹100.00 received; ₹215.00 added to ${buyer.name}’s khata. Stock updated.`);
  // The message the customer gets: the amount still to pay, never the whole bill, and the bill's number.
  const chat = new URL((await done.locator('a[href^="https://wa.me/"]').getAttribute("href"))!);
  expect(`${chat.origin}${chat.pathname}`, "the customer's own number, as WhatsApp wants it").toBe(`https://wa.me/91${buyerPhone}`);
  expect(chat.searchParams.get("text")!).toMatch(new RegExp(`^Hello ${buyer.name}, thank you for shopping at .+\\. Bill INV/\\d{2}-\\d{2}/\\d{6}: ₹315\\.00\\.\\nStill to pay: ₹215\\.00\\.`));

  // The form after a recorded sale: walk-in chosen, one fresh line, today's date, and no draft to bring the old sale back.
  await done.getByRole("button", { name: "New bill", exact: true }).click();
  await expect(slide(page)).toHaveAttribute("data-slide", "items");
  await expect(page.locator('#sale-lines [data-line-field="item"]')).toHaveCount(1);
  await expect(page.locator('#sale-lines [data-line-field="item"]'), "no item left on the line").toHaveValue("");
  await expect(page.locator('[data-draft="sale"] [name="party"] option:checked')).toHaveText("Walk-in / cash customer");
  await expect(page.locator('[data-draft="sale"] [name="date"]')).toHaveValue(shop.today);
  await expect(page.locator("#sale-draft-date-note")).toBeHidden();
  const left = await page.evaluate(() => JSON.parse(localStorage.getItem("karobar.draft.sale") ?? "null"));
  expect(left === null || (left.__lines ?? []).every((line: any) => line.quantity !== "10"), "the saved draft no longer holds the sale just made").toBe(true);
  await page.reload();
  await expect(page.locator('[data-draft="sale"] [name="party"]')).not.toHaveValue("");
  await expect(page.locator('[data-draft="sale"] [name="party"] option:checked'), "a reload does not bring the old customer back").toHaveText("Walk-in / cash customer");
  await expect(page.locator('#sale-lines [data-line-field="quantity"]'), "nor the old line").not.toHaveValue("10");
});

test("the tax and the total on the sale are what the server says, never worked out in the page", async ({ page }) => {
  const restore = await respondWith(page, "/api/sales/estimate", { body: { state: "estimate", ready: true, total: 999.99, totals: { subtotal: 922.22, totalTax: 77.77, total: 999.99, roundOff: 0 }, lines: [], placeOfSupply: null, ewayBill: null, eInvoice: null, dateNotice: null, refusals: [] } });
  await pickItem(page, "#sale-lines", steel.name);
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', "3");
  await typeInto(page, '#sale-lines [data-line-field="rate"]', "100");
  // The figures on screen are the server's, whatever 3 × ₹100 would come to here.
  await expect(page.locator('[data-draft="sale"] [data-calculated="total"]')).toHaveText("₹999.99");
  await expect(page.locator('[data-draft="sale"] [data-calculated="tax"]')).toHaveText("₹77.77");
  await expect(page.locator('#sale-bill-bar [data-calculated="total"]'), "and the bar on every slide").toHaveText("₹999.99");
  await restore();
  expect(watch.problems).toEqual([]);
});

test("when the server cannot price the bill yet, the figures stay as dashes rather than a guess", async ({ page }) => {
  await respondWith(page, "/api/sales/estimate", { body: { state: "estimate", ready: false, total: null, totals: null, lines: [], refusals: [{ code: "CUSTOMER_REQUIRED", "en-IN": "Choose a customer", "hi-IN": "ग्राहक चुनिए" }] } });
  await pickItem(page, "#sale-lines", steel.name);
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', "2");
  await typeInto(page, '#sale-lines [data-line-field="rate"]', "100");
  await expect(page.locator('[data-draft="sale"] [data-calculated="total"]')).toHaveText("—");
  await expect(page.locator('[data-draft="sale"] [data-calculated="tax"]')).toHaveText("—");
  // The shown subtotal is only the sum of what was typed (before tax) — the one figure the page may add up.
  await expect(page.locator('[data-draft="sale"] [data-calculated="subtotal"]')).toHaveText("₹200.00");
});

test("an issued bill can be cancelled, but only with a reason; what cancelling does is shown first", async ({ page }) => {
  await toPayment(page, soap, "1", "100", buyer.id);
  await expect(page.locator("#sale-review-ok")).toBeVisible();
  await page.locator("#sale-next").click();
  const done = page.locator('[data-slide="done"]');
  await expect(done).toBeVisible({ timeout: 15_000 });
  const number = /INV\/\d{2}-\d{2}\/\d{6}/.exec(await done.innerText())![0];

  const mark = watch.mark();
  await done.getByRole("button", { name: "Cancel this bill" }).click();
  await expect(page.locator("#cancel-bill-dialog")).toBeVisible();
  await watch.requested("/api/sales/cancel/preview", mark);
  await expect(page.locator("#cancel-bill-message")).toHaveText(`${number} for ₹105.00 will be cancelled.`);
  await expect(page.locator("#cancel-bill-effects")).toContainText(`The number ${number} stays used and the bill stays on record, marked CANCELLED. No new bill will ever get this number.`);
  await expect(page.locator("#cancel-bill-effects")).toContainText(`1 PCS of ${soap.name} go back into stock.`);
  expect(watch.calls(mark), "looking at what cancelling does cancels nothing").not.toContain("POST /api/sales/cancel");

  // No reason, no cancellation: the box is required, so nothing is sent.
  await page.locator("#cancel-bill-confirm").click();
  expect(watch.calls(mark)).not.toContain("POST /api/sales/cancel");
  expect(await page.locator('#cancel-bill-form [name="reason"]').evaluate((box) => (box as HTMLTextAreaElement).validity.valueMissing)).toBe(true);
  await page.locator('#cancel-bill-form [name="reason"]').fill("Customer changed their mind");
  await page.locator("#cancel-bill-confirm").click();
  const cancelled = await watch.requested("/api/sales/cancel", mark);
  expect(JSON.parse(cancelled.body!).reason).toBe("Customer changed their mind");
  await expect(page.locator("#cancel-bill-dialog")).toBeHidden();
  // The number stays on record, marked cancelled — it is never reused.
  await expect(page.locator("#sale-bill-panel")).toContainText(/cancelled/i);
  await expect(page.locator("#sale-bill-panel")).toContainText(number);
});
