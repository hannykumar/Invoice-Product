/**
 * Issue #495 — money received and money paid, and the safety of every review dialog, in a real browser.
 *
 * Replaces the source-text checks on "the picker is a list, not a typed name", "Nothing was saved",
 * "Record once", the busy states and the request routes. Each test drives the real forms and asserts
 * what the person reads and what the page sends.
 */
import { expect, test, type Page } from "@playwright/test";
import { apiSignIn, baseURL, signIn } from "./helpers.ts";
import { keepOffline } from "./offline.ts";
import { addCustomer, addSupplier, distinct, openShop, type Shop } from "./arrange.ts";
import { holdRequests, watchPage, type PageWatch } from "./page-watch.ts";

let shop: Shop;
let customer: { id: string; name: string };
let owedSupplier: { id: string; name: string };
let watch: PageWatch;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    shop = await openShop(request, await apiSignIn(request));
    customer = await addCustomer(request, shop, distinct("Money Customer"));
    owedSupplier = await addSupplier(request, shop, distinct("Money Supplier"));
  } finally { await request.dispose(); }
});

async function openMoney(page: Page, view: "payment" | "paid") {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  await page.goto(`/#${view}`);
  const party = page.locator(`[data-draft="${view}"] [name="partyId"]`);
  // The pickers fill once the catalogue has answered.
  await expect.poll(() => party.locator("option").count()).toBeGreaterThan(1);
  return party;
}
const review = (page: Page) => ({ dialog: page.locator("#review-dialog"), title: page.locator("#review-title"), body: page.locator("#review-body"), confirm: page.locator("#review-confirm"), keepEditing: page.locator("#review-cancel") });

test("money received picks a customer from the list and money paid picks a supplier — there is no box to type a name", async ({ page }) => {
  const party = await openMoney(page, "payment");
  const options = await party.locator("option").allTextContents();
  expect(options[0], "nobody is chosen until the shopkeeper chooses").toMatch(/^Choose the customer who paid/);
  expect(options.some((text) => text.includes(customer.name))).toBe(true);
  expect(options.every((text) => !text.includes(owedSupplier.name)), "a supplier is never offered as the one who paid us").toBe(true);
  await expect(page.locator('[data-draft="payment"] input[name="party"], [data-draft="paid"] input[name="party"]')).toHaveCount(0);

  await page.evaluate(() => { location.hash = "#paid"; });
  const paid = page.locator('[data-draft="paid"] [name="partyId"]');
  await expect(paid.locator("option").first()).toHaveText(/^Choose the supplier you paid/);
  const suppliers = await paid.locator("option").allTextContents();
  expect(suppliers.some((text) => text.includes(owedSupplier.name))).toBe(true);
  expect(suppliers.every((text) => !text.includes(customer.name)), "and a customer is never offered as the one we paid").toBe(true);

  // Every way of paying is sent by its own name, in whatever language the screen speaks.
  for (const view of ["payment", "paid"]) {
    const values = await page.locator(`[data-draft="${view}"] [name="method"] option`).evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value));
    expect([...values].sort()).toEqual(["BANK_TRANSFER", "CASH", "CHEQUE", "UPI"]);
    for (const name of ["chequeNumber", "chequeDate"]) await expect(page.locator(`[data-draft="${view}"] [name="${name}"]`)).toHaveCount(1);
  }
  await page.locator("#locale").selectOption("hi-IN");
  await expect(page.locator('[data-draft="paid"] [name="method"] option').first()).toHaveText(/[ऀ-ॿ]/);
  const hindi = await page.locator('[data-draft="paid"] [name="method"] option').evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value));
  expect([...hindi].sort(), "the values stay English even when the words are Hindi").toEqual(["BANK_TRANSFER", "CASH", "CHEQUE", "UPI"]);
});

test("choosing a customer reads their open bills; the review asks first, and nothing is recorded until \"Record once\"", async ({ page }) => {
  const party = await openMoney(page, "payment");
  const { dialog, title, body, confirm, keepEditing } = review(page);
  const mark = watch.mark();
  await party.selectOption(customer.id);
  await watch.requested("/api/payments/open-bills", mark);
  expect(watch.bodyOf("/api/payments/open-bills", mark).partyId).toBe(customer.id);

  await page.locator('[data-draft="payment"] [name="amount"]').fill("500");
  await page.locator('[data-draft="payment"] button[type="submit"]').click();
  await expect(dialog).toBeVisible();
  await expect(title).toHaveText("Money received — check it");
  await expect(body).toHaveText(`₹500.00 will reduce what ${customer.name} owes.`);
  await expect(confirm).toHaveText("Record once");
  expect(watch.calls(mark)).toContain("POST /api/payments/preview");
  expect(watch.calls(mark), "a review records nothing").not.toContain("POST /api/payments/record");

  await keepEditing.click();
  await expect(dialog).toBeHidden();
  expect(watch.calls(mark), "Keep editing records nothing either").not.toContain("POST /api/payments/record");
  await expect(page.locator('[data-draft="payment"] [name="amount"]'), "and what was typed is still there").toHaveValue("500");

  // Record: the very same request key as the review, so pressing it twice is one entry, never two.
  await page.locator('[data-draft="payment"] button[type="submit"]').click();
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(title).toHaveText(/recorded/);
  const preview = watch.bodyOf("/api/payments/preview", mark);
  const record = watch.bodyOf("/api/payments/record", mark);
  expect(record.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(record.requestId, "the key rides from the review to the record").toBe(preview.requestId);
  expect({ ...record, requestId: "" }, "what is recorded is exactly what was checked").toEqual({ ...preview, requestId: "" });
  expect([record.direction, record.partyId, record.amount]).toEqual(["RECEIPT", customer.id, "500"]);
  await expect(body).toHaveText(new RegExp(`₹500\\.00 received from ${customer.name} is in your books as RECEIPT/`));
  await watch.requested("/api/payments/voucher", mark);
  await expect(page.locator("#view-payment [data-voucher-panel]"), "and the voucher is shown under the form").toBeVisible();
  // After anything is recorded every list that could have changed is read again, so no screen shows yesterday's books.
  for (const list of ["/api/dashboard", "/api/einvoices/invoices", "/api/eway/bills", "/api/challans", "/api/returns/documents", "/api/returns/notes", "/api/reminders"]) {
    await watch.requested(list, watch.sent.findIndex((sent) => sent.path === "/api/payments/record"));
  }
  expect(watch.problems).toEqual([]);
});

test("a new review is a new entry: the request key is never reused for the next one", async ({ page }) => {
  const party = await openMoney(page, "payment");
  const { dialog, title, confirm } = review(page);
  const enter = async (amount: string) => {
    await party.selectOption(customer.id);
    await page.locator('[data-draft="payment"] [name="amount"]').fill(amount);
    await page.locator('[data-draft="payment"] button[type="submit"]').click();
    await expect(confirm).toBeVisible();
  };
  const first = watch.mark();
  await enter("100");
  const key = watch.bodyOf("/api/payments/preview", first).requestId;
  expect(key).toBeTruthy();
  await confirm.click();
  await expect(title).toHaveText(/recorded/);
  expect(watch.bodyOf("/api/payments/record", first).requestId).toBe(key);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const second = watch.mark();
  await enter("110");
  expect(watch.bodyOf("/api/payments/preview", second).requestId, "a new review is a new entry").not.toBe(key);
});

test("while the server is checking, the form says it is busy and the dialog cannot be dismissed into a half state", async ({ page }) => {
  const party = await openMoney(page, "payment");
  const { dialog, body, confirm, keepEditing } = review(page);
  await party.selectOption(customer.id);
  await page.locator('[data-draft="payment"] [name="amount"]').fill("250");
  const slow = await holdRequests(page, "/api/payments/preview");
  await page.locator('[data-draft="payment"] button[type="submit"]').click();
  await expect(page.locator('[data-draft="payment"]')).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-draft="payment"] button[type="submit"]'), "the button cannot be pressed twice").toBeDisabled();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(keepEditing, "Keep editing waits for the answer").toBeDisabled();
  await expect(confirm, "and Record is not offered until there is something to record").toBeHidden();
  await slow.release();
  await expect(confirm).toBeVisible();
  await expect(page.locator('[data-draft="payment"]')).toHaveAttribute("aria-busy", "false");
  await expect(dialog).toHaveAttribute("aria-busy", "false");
  await expect(keepEditing).toBeEnabled();
  await expect(body).toContainText("₹250.00");
});

test("a refusal from the server reads \"Nothing was saved\", in the reader's language, and records nothing", async ({ page }) => {
  const party = await openMoney(page, "paid");
  const { dialog, title, body, confirm } = review(page);
  await party.selectOption(owedSupplier.id);
  await page.locator('[data-draft="paid"] [name="amount"]').fill("250");
  const mark = watch.mark();
  await page.locator('[data-draft="paid"] button[type="submit"]').click();
  await expect(dialog).toBeVisible();
  await expect(title).toHaveText("Nothing was saved");
  await expect(body).toHaveText(new RegExp(`^You have no bill from ${owedSupplier.name} yet\\.`));
  await expect(confirm, "there is nothing to record, so no Record button").toBeHidden();
  expect(watch.calls(mark)).not.toContain("POST /api/payments/record");
  await page.keyboard.press("Escape");

  // The same refusal for a Hindi reader: the title is Hindi, and still nothing is saved.
  await page.locator("#locale").selectOption("hi-IN");
  await page.locator('[data-draft="paid"] button[type="submit"]').click();
  await expect(dialog).toBeVisible();
  await expect(title).toHaveText(/[ऀ-ॿ]/);
  await expect(title).not.toHaveText("Nothing was saved");
  expect(watch.calls(mark)).not.toContain("POST /api/payments/record");
});
