/**
 * Issue #305 / #311 (ported from Puppeteer by #496) — the sale in slides, driven in a real browser
 * against the real app on real PostgreSQL.
 *
 * The full-trade check (#242, tests/e2e/full-trade.test.ts) drives the trade over HTTP. This file
 * drives the same step 3 through the slides themselves, by keyboard only: Items → Customer →
 * Payment → Transport → Make bill, and asserts the bill the owner sees: ₹42,500 + IGST ₹7,650 =
 * ₹50,150, and the e-way bill raised by itself with no visit to the E-way bill screen. Then a
 * walk-in cash sale of three items, counting the taps after the items (the issue asks for five at
 * most; it is three), and the 600 KGS sale that is refused with the purchase hand-off.
 *
 * The three run in order: the first leaves 50 KGS in stock and a customer last charged ₹90, which
 * the third relies on. Every name is unique to the run, so an earlier run's records never collide.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { syntheticGstin } from "../../packages/masters/src/fixtures.ts";
import {
  apiCall, apiSignIn, baseURL, ensureBusinessDetails, pickItem, signIn, today,
} from "./helpers.ts";
import { grantVehicleRecordConsent } from "./db.ts";
import { keepOffline } from "./offline.ts";

test.describe.configure({ mode: "serial" });

/**
 * A name that is new every run. `helpers.unique` is a clock reading, so two runs a few minutes apart
 * differ only in their last characters, and the app treats that as the same item or customer.
 */
const distinct = (word: string) => `${word} ${randomUUID().slice(0, 8)}`;

let cookie: string;
let steelName: string;
let customerName: string;
let customerId: string;
let soapNames: string[];

const addGoods = async (request: APIRequestContext, name: string, unit: string, price: string, rate: string, hsnSac: string) => {
  const result = await apiCall(request, cookie, "/api/items", {
    name, kind: "goods", hsnSac, unit, taxKind: "taxable", ratePercentTimes100: rate, basis: "Browser test item", price, acknowledgeSimilar: true,
  });
  return result.item.id as string;
};

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    await grantVehicleRecordConsent();
    cookie = await apiSignIn(request);
    await ensureBusinessDetails(request, cookie);
    // The app flags a second bill from the same supplier on the same day for much the same amount as a
    // likely duplicate, and earlier runs left theirs behind. A supplier new to every run keeps each
    // run's bills its own, so they can be the plain figures of the original test.
    const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const gstinFor = (state: string) => syntheticGstin(state, `AAA${letter()}${letter()}${1000 + Math.floor(Math.random() * 9000)}${letter()}`);
    const supplier = await apiCall(request, cookie, "/api/suppliers", {
      legalName: distinct("Krishna Steel"), gstin: gstinFor("29"), registration: "regular", stateCode: "29", pincode: "560058",
      line1: "Plot 5, Peenya Industrial Area", city: "Bengaluru", acknowledgeSimilar: true,
    });
    const supplierId = supplier.supplier.id as string;
    // Full trade, steps 1 and 2 (the same requests the Purchase screen and the customer box send).
    steelName = distinct("TMT Steel Bar");
    const steel = await addGoods(request, steelName, "KGS", "90", "1800", "72142000");
    await apiCall(request, cookie, "/api/purchases/record", {
      supplierId, reference: distinct("SRS"), date: await today(request, cookie), amount: "37760",
      lines: JSON.stringify([{ itemId: steel, quantity: "500", unit: "KGS", rate: "64", gst: "1800" }]),
    });
    customerName = distinct("Mehta Construction");
    const mehta = await apiCall(request, cookie, "/api/customers", {
      legalName: customerName, registration: "regular", gstin: gstinFor("27"),
      line1: "Plot 22, MIDC Bhosari", city: "Pune", pincode: "411026", acknowledgeSimilar: true,
    });
    customerId = mehta.customer.id as string;
    // Three counter goods with a usual price, so a walk-in bill needs no typing.
    soapNames = [distinct("Herbal Soap"), distinct("Neem Soap"), distinct("Rose Soap")];
    const soaps: string[] = [];
    for (const [index, name] of soapNames.entries()) soaps.push(await addGoods(request, name, "PCS", ["40", "30", "35"][index]!, "500", "34011190"));
    await apiCall(request, cookie, "/api/purchases/record", {
      supplierId, reference: distinct("SRS"), date: await today(request, cookie),
      lines: JSON.stringify(soaps.map((itemId) => ({ itemId, quantity: "100", unit: "PCS", rate: "20", gst: "500" }))),
    });
  } finally {
    await request.dispose();
  }
});

test.beforeEach(async ({ page }) => {
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

/** Focuses a box, selects what is in it, and types over it: the keyboard's way of "tap the number". */
async function typeInto(page: Page, selector: string, value: string) {
  const box = page.locator(selector).last();
  await box.focus();
  await box.evaluate((input) => { (input as HTMLInputElement).select(); });
  await page.keyboard.type(value);
}

/** Takes Mehta on the Customer slide: the chip when it is offered, else the picker past five. */
async function chooseCustomer(page: Page, byKeyboard: boolean) {
  const chip = page.locator("#sale-customer-choices button", { hasText: customerName }).first();
  if ((await chip.count()) === 0) {
    await page.locator('[data-draft="sale"] select[name="party"]').selectOption({ value: customerId });
  } else if (byKeyboard) {
    await chip.focus();
    await page.keyboard.press("Enter");
  } else {
    await chip.click();
  }
}

test("#305: full-trade step 3 through the slides, by keyboard: ₹50,150 and the e-way bill raised by itself (#311)", async ({ page, request }) => {
  await expect(slide(page)).toHaveAttribute("data-slide", "items");
  await expect(page.locator("#sale-next")).toHaveText("Next");
  await pickItem(page, "#sale-lines", steelName);
  // Tap the number to type it: 450 KGS at ₹90.
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', "450");
  await typeInto(page, '#sale-lines [data-line-field="rate"]', "90");
  // Freight: the box opens from the keyboard.
  await page.locator("#sale-charges summary").focus();
  await page.keyboard.press("Enter");
  await page.locator('[name="freight"]').focus();
  await page.keyboard.type("2000");
  // ← → move between slides; each slide's heading takes the focus.
  await expect(page.locator('#sale-bill-bar [data-calculated="total"]')).toHaveText("₹50,150.00");
  await page.locator("#sale-slide-items").focus();
  await page.keyboard.press("ArrowRight");
  await expect(slide(page)).toHaveAttribute("data-slide", "customer");
  await expect(page.locator("#sale-slide-customer")).toBeFocused();
  await expect(page.locator("#sale-step")).toHaveText(/^Step 2 of \d: Who is buying\?$/);
  // Walk-in is chosen until somebody else is: Mehta, from the keyboard.
  await expect(page.locator('#sale-customer-choices [aria-pressed="true"]')).toHaveText("Walk-in / cash customer");
  await chooseCustomer(page, true);
  const checks = page.locator("#sale-customer-checks li");
  await expect(checks.nth(0)).toHaveText("Maharashtra sale · IGST");
  await expect(checks.nth(1)).toHaveText("e-way bill needed — raised after you make the bill");
  await expect(page.locator('#sale-bill-bar [data-calculated="total"]'), "the total is in the bar on every slide").toHaveText("₹50,150.00");

  await page.keyboard.press("ArrowRight");
  await expect(slide(page)).toHaveAttribute("data-slide", "payment");
  await expect(page.locator("#sale-slide-payment")).toBeFocused();
  // Udhaar, 30 days: the tile from the keyboard; thirty days comes pressed.
  await page.locator('[data-pay="UDHAAR"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('#sale-udhaar-days [aria-pressed="true"]')).toHaveAttribute("data-days", "30");
  await expect(page.locator("#sale-review-ok")).toBeVisible();
  await expect(page.locator("#sale-review-ok [data-line-text]")).toHaveText("e-way bill needed — raised after you make the bill");
  // The one warning: the turnover question (full trade, step 3), with its button.
  await expect(page.locator("#sale-review-warning [data-line-text]")).toHaveText(/^We don't know yet whether you need e-invoices/);
  await expect(page.locator("#sale-review-turnover")).toBeVisible();
  await expect(page.locator(".bill-summary strong:visible")).toHaveText(["₹40,500.00", "₹2,000.00", "₹7,650.00", "₹50,150.00"]);
  await expect(page.locator("#sale-next"), "goods that need an e-way bill get the Transport slide before Make bill").toHaveText("Next");

  // Transport: the vehicle, and its check (#29) as one line.
  await page.locator("#sale-slide-payment").focus();
  await page.keyboard.press("ArrowRight");
  await expect(slide(page)).toHaveAttribute("data-slide", "transport");
  await page.locator('[name="vehicleNumber"]').focus();
  await page.keyboard.type("KA01AB1234");
  await expect(page.locator("#sale-vehicle-check")).toBeVisible();
  await expect(page.locator("#sale-vehicle-check")).toHaveText(/KA01AB1234 is on the transport department's record/);
  await expect(page.locator("#sale-next")).toHaveText("Make bill");
  // Arrow keys never make a bill: → on the last slide stays there.
  await page.locator("#sale-slide-transport").focus();
  await page.keyboard.press("ArrowRight");
  await expect(slide(page)).toHaveAttribute("data-slide", "transport");

  await page.locator("#sale-next").focus();
  await page.keyboard.press("Enter");
  const doneSlide = page.locator('[data-slide="done"]');
  await expect(doneSlide).toBeVisible({ timeout: 15_000 });
  await expect(doneSlide).toContainText("Bill made");
  await expect(doneSlide).toContainText(/INV\/26-27\/\d{6}/);
  await expect(doneSlide).toContainText("₹50,150.00");
  const done = (await doneSlide.innerText()).trim();
  const raised = done.match(/E-way bill (\d{12}) raised by itself · valid until (.+)/);
  expect(raised, done).not.toBeNull();
  // The same e-way bill the E-way bill screen shows for this bill — it was never opened.
  const number = done.match(/INV\/26-27\/\d{6}/)![0];
  const bill = (await apiCall(request, cookie, "/api/eway/bills")).invoices.find((row: any) => row.number === number);
  expect(bill.label).toBe(`e-way bill ${raised![1]}`);
  expect(bill.customer).toBe(customerName);
  await expect(page.locator("#sale-bill-bar")).toBeHidden();
  // "New bill" from the done slide starts again on the Items slide.
  await doneSlide.getByRole("button", { name: "New bill", exact: true }).click();
  await expect(slide(page)).toHaveAttribute("data-slide", "items");
});

test("#305: a walk-in cash sale of three items is three taps after the items, with no typing", async ({ page }) => {
  for (const [index, name] of soapNames.entries()) {
    if (index > 0) {
      await page.locator("#sale-add-line").focus();
      await page.keyboard.press("Enter");
    }
    await pickItem(page, "#sale-lines", name);
  }
  const rates = page.locator('#sale-lines [data-line-field="rate"]');
  await expect(rates).toHaveCount(3);
  for (const [index, price] of ["40", "30", "35"].entries()) await expect(rates.nth(index), "each at its usual price").toHaveValue(price);
  let taps = 0;
  const tap = async () => { taps += 1; await page.locator("#sale-next").click(); };
  await tap();
  await expect(slide(page)).toHaveAttribute("data-slide", "customer");
  await tap();
  await expect(slide(page)).toHaveAttribute("data-slide", "payment");
  await expect(page.locator('[data-pay="CASH"]'), "cash is already chosen").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sale-review-ok")).toContainText(/Paid now by Cash/);
  await expect(page.locator("#sale-next")).toHaveText("Make bill");
  await tap();
  await expect(page.locator('[data-slide="done"]')).toBeVisible({ timeout: 15_000 });
  expect(taps).toBe(3);
  await expect(page.locator('[data-slide="done"]')).toContainText(/Cash received from Walk-in\. Stock updated\./);
});

test("#305: 600 KGS with 50 in stock is refused on the Payment slide, with \"Enter the purchase bill\", and no bill is made", async ({ page, request }) => {
  const before = (await apiCall(request, cookie, "/api/reports")).sales.rows.length;
  await pickItem(page, "#sale-lines", steelName);
  await typeInto(page, '#sale-lines [data-line-field="quantity"]', "600");
  await page.locator("#sale-next").click();
  await chooseCustomer(page, false);
  // The customer was last charged ₹90: the price the app filled in follows the customer chosen after the items.
  await expect(page.locator('#sale-lines [data-line-field="rate"]')).toHaveValue("90");
  await page.locator("#sale-next").click();
  await expect(page.locator("#review-dialog")).toHaveAttribute("open", "", { timeout: 15_000 });
  await expect(page.locator("#review-purchase")).toBeVisible();
  await expect(page.locator("#review-body")).toHaveText(new RegExp(`^You have 50 KGS of ${steelName} in Bengaluru · Peenya godown\\. This bill asks for 600 KGS\\.`));
  await expect(page.locator("#review-purchase")).toHaveText("Enter the purchase bill");
  expect((await apiCall(request, cookie, "/api/reports")).sales.rows.length, "no bill number used up").toBe(before);
});
