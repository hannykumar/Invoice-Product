/**
 * Issue #355 — record a purchase: a supplier's bill typed on the Purchase screen, previewed
 * like every financial action, then confirmed. The recorded box repeats what the server saved —
 * the supplier's name, their bill number, what is owed — against real PostgreSQL.
 */
import { expect, test } from "@playwright/test";
import {
  addItem, apiSignIn, ensureBusinessDetails, findOrAddSupplier, pickItem, signIn, today, unique,
} from "./helpers.ts";

test("record a supplier bill through the Purchase screen (#355)", async ({ page, request }) => {
  const cookie = await apiSignIn(request);
  await ensureBusinessDetails(request, cookie);
  const itemName = unique("Sack Rice");
  const reference = unique("AT-");
  await addItem(request, cookie, itemName, "45");
  const supplier = await findOrAddSupplier(request, cookie, unique("Annapurna Traders"));
  const supplierName = supplier.name;
  const date = await today(request, cookie);

  await page.goto("/");
  await signIn(page);
  await page.goto("/#purchase");
  const form = page.locator('[data-draft="purchase"]');
  await expect(form).toBeVisible();
  // The pickers fill once the catalogue has answered.
  await expect(form.locator('[name="supplierId"] option').nth(1)).toBeAttached();

  await form.locator('[name="supplierId"]').selectOption({ value: supplier.id });
  await form.locator('[name="reference"]').fill(reference);
  await form.locator('[name="date"]').fill(date);

  // One line: the item, how many, at what rate, at 5% GST.
  await pickItem(page, "#purchase-lines", itemName);
  await page.locator('#purchase-lines [data-line-field="quantity"]').last().fill("10");
  await page.locator('#purchase-lines [data-line-field="rate"]').last().fill("20");
  await page.locator('#purchase-lines [data-line-field="gst"]').last().selectOption("500");

  await form.locator('button[type="submit"]').click();

  // Preview first, always: the review dialog opens before anything is saved.
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-confirm")).toBeVisible();
  await page.locator("#review-confirm").click();

  // Recorded: the server repeats the bill it saved.
  await expect(page.locator("#review-icon")).toHaveText("✓", { timeout: 20_000 });
  await expect(page.locator("#review-title")).toContainText(/recorded/i);
  await expect(page.locator("#review-body")).toContainText(supplierName);
  await expect(page.locator("#review-body")).toContainText(reference);
});
