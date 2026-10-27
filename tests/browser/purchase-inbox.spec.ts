/**
 * Issue #489 — from a supplier's bill to a recorded purchase, through the Supplier bills inbox in a
 * real browser against real PostgreSQL: add the file, see what was read and the words it was read
 * from, correct the bill number, check, record once — then add the same file again and be told
 * the shop has it already. The reader is the development stand-in under NODE_ENV=test (no OCR vendor
 * is contracted yet); every name and GST number is invented.
 */
import { expect, test } from "@playwright/test";
import { addItem, apiCall, apiSignIn, ensureBusinessDetails, findOrAddSupplier, signIn, today, unique } from "./helpers.ts";
import { sampleBillLines, sampleBillPdf } from "../../apps/api/src/inbox-ocr.ts";

test("add a supplier bill to the inbox, correct it, record it, and a second copy is recognised (#489)", async ({ page, request }) => {
  const cookie = await apiSignIn(request);
  await ensureBusinessDetails(request, cookie);
  const itemName = unique("Basmati Rice");
  await addItem(request, cookie, itemName, "45");
  const supplier = await findOrAddSupplier(request, cookie, unique("Annapurna Traders"));
  const catalogue = await apiCall(request, cookie, "/api/catalogue");
  const known = catalogue.suppliers.find((party: { id: string }) => party.id === supplier.id);
  const supplierGstin = String(known?.gstin ?? "29AAFCD1234K1ZN");
  const number = unique("INB-").replace(/\s/g, "-");
  const date = await today(request, cookie);
  const [year, month] = date.split("-");
  const billDate = `15/${month}/${year}`;
  const identity = await apiCall(request, cookie, "/api/business-details");
  const ours = String(identity.details?.gstin ?? identity.prefill?.gstin ?? "29AAAAA0000A1ZY");
  const pdf = Buffer.from(sampleBillPdf(sampleBillLines({
    supplierName: supplier.name, supplierGstin, buyerGstin: ours, number, date: billDate,
    item: itemName, hsn: "34011190", quantity: "10", unit: "PCS", rate: "20.00", taxable: "200.00", igst: "10.00", total: "210.00",
  }), number));

  await page.goto("/");
  await signIn(page);
  await page.goto("/#purchase-inbox");
  await expect(page.locator("#inbox-title")).toBeVisible();

  // Add the file.
  await page.locator("#inbox-file").setInputFiles({ name: "annapurna-bill.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.locator("#inbox-add-button").click();
  await expect(page.locator("#inbox-add-result")).toContainText(/added to your inbox/i, { timeout: 20_000 });
  const row = page.locator("#inbox-list .activity-row", { hasText: number });
  await expect(row).toContainText("Ready to check");

  // Open it: every figure shows how sure we are and the words it was read from.
  await row.getByRole("button", { name: /open/i }).click();
  const detail = page.locator("#inbox-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(`Invoice No: ${number}`);
  await expect(detail).toContainText(/Read clearly/);
  await expect(detail.locator('select[name="supplierId"]')).toHaveValue(supplier.id);

  // Correct the bill number as the paper bill has it, add what was bought, check.
  const corrected = `${number}-C`;
  await detail.locator('input[name="reference"]').fill(corrected);
  await detail.locator('select[data-field="item"]').first().selectOption({ label: itemName });
  await detail.locator('input[data-field="quantity"]').first().fill("10");
  await detail.locator('input[data-field="rate"]').first().fill("20");
  await detail.locator('select[data-field="gst"]').first().selectOption("500");
  await detail.getByRole("button", { name: /check the bill/i }).click();
  await expect(detail).toContainText(/Recording bill/);
  await detail.getByRole("button", { name: /record once/i }).click();
  await expect(detail).toContainText(/Recorded:/, { timeout: 20_000 });
  await expect(detail).toContainText(`Bill number: read as ${number}, recorded as ${corrected}.`);

  // The list now says so, and the same file added again is the one the shop already has.
  await expect(page.locator("#inbox-list .activity-row", { hasText: number })).toContainText("Recorded");
  await page.locator("#inbox-file").setInputFiles({ name: "annapurna-bill.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.locator("#inbox-add-button").click();
  await expect(page.locator("#inbox-add-result")).toContainText(/already have/i, { timeout: 20_000 });

  // It is a bill in the books, under the corrected number.
  const dashboard = await apiCall(request, cookie, "/api/dashboard");
  expect(JSON.stringify(dashboard.activity)).toContain(corrected);
});

test("the inbox says plainly when it is empty or cannot be opened (#489)", async ({ page }) => {
  await page.goto("/");
  await signIn(page, "owner@konkan.example.invalid");
  await page.goto("/#purchase-inbox");
  await expect(page.locator("#inbox-list")).toContainText(/Nothing here yet/);
  // The list's request fails: the screen says so and offers to try again.
  await page.route("**/api/purchase-inbox?**", (route) => route.abort());
  await page.locator("#inbox-refresh").click();
  await expect(page.locator("#inbox-list")).toContainText(/could not be opened/);
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
});
