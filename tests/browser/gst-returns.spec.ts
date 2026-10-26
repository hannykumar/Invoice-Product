/**
 * Issue #355 — prepare a GST return: the month picked, the return built from the books that
 * month holds, then approved. The books are arranged through the same routes the screens call —
 * a supplier bill and a counter bill in the month — so the return the owner reads has real
 * figures on it, against real PostgreSQL.
 */
import { expect, test } from "@playwright/test";
import {
  addCustomer, addItem, apiCall, apiSignIn, ensureBusinessDetails, findOrAddSupplier,
  recordPurchase, signIn, today, unique,
} from "./helpers.ts";

test("prepare this month's return and approve it (#355)", async ({ page, request }) => {
  const cookie = await apiSignIn(request);
  await ensureBusinessDetails(request, cookie);

  // Something in the month for the return to carry: goods in, goods out.
  const itemId = await addItem(request, cookie, unique("Month Soap"), "30");
  const { id: supplierId } = await findOrAddSupplier(request, cookie, unique("Month Supplier"));
  await recordPurchase(request, cookie, {
    supplierId, reference: unique("GSTR-IN"), itemId, quantity: "50", rate: "20", gst: "500",
  });
  const customerId = await addCustomer(request, cookie, unique("Month Customer"));
  const date = await today(request, cookie);
  await apiCall(request, cookie, "/api/sales/record", {
    customerId, date, terms: "now", paidBy: "CASH",
    requestId: `gstr-${Date.now()}`,
    lines: JSON.stringify([{ itemId, quantity: "2", unit: "PCS", rate: "30" }]),
  });

  await page.goto("/");
  await signIn(page);
  await page.goto("/#gst-returns");
  await expect(page.locator("#gst-return-form")).toBeVisible();

  const period = date.slice(0, 7);
  await page.locator('#gst-return-form [name="period"]').fill(period);
  await page.locator('#gst-return-form button[type="submit"]').click();

  // The month's return: its period label, its status pill, the books it reconciles.
  await expect(page.locator("#gst-heading")).toBeVisible();
  await expect(page.locator("#gst-title")).not.toHaveText("—");
  await expect(page.locator("#gst-summary")).not.toBeEmpty();
  await expect(page.locator("#gst-3b-panel")).toBeVisible();
  await expect(page.locator("#gst-books-panel")).toBeVisible();

  const approve = page.locator("#gst-approve");
  await expect(page.locator("#gst-actions-panel")).toBeVisible();
  if (await approve.isEnabled()) {
    // First run on a fresh month: the owner approves, and the figures are fixed against their name.
    await approve.click();
    await expect(page.locator("#gst-action-result")).toContainText("Approved", { timeout: 20_000 });
    await expect(page.locator("#gst-export")).toBeEnabled();
    await expect(approve).toBeDisabled();

    // Approved figures are fixed against the owner's name: one more sale in the same month,
    // then the month asked for again, must show exactly the figures that were approved.
    const frozen = await page.locator("#gst-3b-panel").innerText();
    await apiCall(request, cookie, "/api/sales/record", {
      customerId, date, terms: "now", paidBy: "CASH",
      requestId: `gstr-drift-${Date.now()}`,
      lines: JSON.stringify([{ itemId, quantity: "1", unit: "PCS", rate: "30" }]),
    });
    await page.locator('#gst-return-form button[type="submit"]').click();
    await expect(page.locator("#gst-3b-panel")).toHaveText(frozen, { useInnerText: true });
  } else {
    // A rerun on a month already approved: the pill says so and the button stays disabled,
    // and the figures the month already carries are the frozen ones — no drift check is
    // possible without a fresh approve, so the first-run branch above owns that check.
    await expect(page.locator("#gst-status")).toContainText(/approv/i);
    await expect(page.locator("#gst-3b-panel")).not.toBeEmpty();
  }
});
