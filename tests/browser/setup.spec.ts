/**
 * Issue #355 — opening a business: the sign-up side of the app. The setup wizard takes the
 * shopkeeper's answers, checks them, and then creates the books with an opening entry and a
 * trial balance that must say it balances.
 */
import { expect, test } from "@playwright/test";
import { apiCall, apiSignIn, signIn, unique } from "./helpers.ts";

test("opening a business: check the answers, create the books, see them balance (#355)", async ({ page, request }) => {
  await page.goto("/");
  await signIn(page);
  await page.goto("/#setup");
  await expect(page.locator("#setup-form")).toBeVisible();
  // The state list fills once the app has answered /api/states.
  await expect(page.locator('#setup-states option').nth(1)).toBeAttached();

  const legalName = unique("Devin Kirana");
  const form = page.locator("#setup-form");
  await form.locator('[name="legalName"]').fill(legalName);
  await form.locator('[name="businessType"]').selectOption("RETAIL");
  await form.locator('[name="stateCode"]').selectOption("29");
  await form.locator('[name="registration"]').selectOption("UNREGISTERED");
  await form.locator('[name="itemName"]').fill("Toor dal 1kg");
  await form.locator('[name="openingCash"]').fill("5000");

  // "Check these answers" first; only then does "Create the business" appear.
  await page.locator("#setup-check").click();
  await expect(page.locator("#setup-create")).toBeVisible();
  await page.locator("#setup-create").click();

  const result = page.locator("#setup-result");
  await expect(result).toContainText("Business created");
  // The opening entry balances — the badge the owner's own trial balance earns.
  await expect(result.locator(".pill.done")).toContainText("books balance");

  // The wizard's trial balance runs on a simulated fresh company (onboarding-application's
  // freshCompany); what the real company keeps is the business prefill — prove it persisted.
  const cookie = await apiSignIn(request);
  const details = await apiCall(request, cookie, "/api/business-details");
  expect(details.prefill.legalName).toBe(legalName);
});
