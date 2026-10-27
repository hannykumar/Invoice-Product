/**
 * Issue #355 — make a bill, through the slides a shopkeeper taps: Items → Customer → Payment →
 * Make bill, ending on the done screen with the bill's own number and total. The goods and the
 * customer are arranged through the same API routes the screens themselves call, against real
 * PostgreSQL — only the driving is by browser.
 */
import { expect, test } from "@playwright/test";
import {
  addCustomer, addItem, apiSignIn, ensureBusinessDetails, findOrAddSupplier, pickItem, recordPurchase, signIn, unique,
} from "./helpers.ts";

test.describe("make a bill (#355)", () => {
  let customerName: string;
  let customerId: string;
  let itemName: string;

  test.beforeEach(async ({ request }) => {
    const cookie = await apiSignIn(request);
    await ensureBusinessDetails(request, cookie);
    itemName = unique("Counter Soap");
    customerName = unique("Ravi Kirana");
    const itemId = await addItem(request, cookie, itemName, "30");
    const { id: supplierId } = await findOrAddSupplier(request, cookie, unique("Krishna Steel"));
    // Stock in first, the way the shop works: a supplier bill before the counter sale.
    await recordPurchase(request, cookie, {
      supplierId, reference: unique("KSS"), itemId, quantity: "100", rate: "20", gst: "500",
    });
    customerId = await addCustomer(request, cookie, customerName);
  });

  test("two soaps at the usual price: number and total on the done screen", async ({ page }) => {
    await page.goto("/");
    await signIn(page);
    await page.goto("/#sale");
    // The pickers fill once the catalogue has answered.
    await expect(page.locator('[data-draft="sale"] select[name="party"] option').nth(1)).toBeAttached();
    await expect(page.locator("#sale-lines [data-item-search]").first()).toBeVisible();

    // Items: search, take the match, tap the quantity up.
    await pickItem(page, "#sale-lines", itemName);
    await page.locator('#sale-lines [data-line-field="quantity"]').last().fill("2");
    // The usual price is filled for the counter — ₹30 a piece, so ₹60 + ₹3 GST = ₹63.
    await expect(page.locator('#sale-lines [data-line-field="rate"]').last()).toHaveValue("30");

    // Customer: the named buyer. The slide offers five chips; past that, the picker.
    await page.locator("#sale-next").click();
    await expect(page.locator("#sale-customer-choices")).toBeVisible();
    const chip = page.locator("#sale-customer-choices button", { hasText: customerName }).first();
    if ((await chip.count()) > 0) await chip.click();
    else await page.locator('[data-draft="sale"] select[name="party"]').selectOption({ value: customerId });

    // Payment: cash is already chosen; "Make bill" once the review says so.
    await page.locator("#sale-next").click();
    await expect(page.locator("#sale-next")).toHaveText("Make bill", { timeout: 20_000 });
    await page.locator("#sale-next").click();

    const done = page.locator('[data-slide="done"]');
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(done).toContainText("Bill made");
    await expect(done).toContainText("₹63.00");
    const number = await done.locator(".done-number").innerText();
    expect(number).toMatch(/INV\/26-27\/\d{6}/);
  });
});
