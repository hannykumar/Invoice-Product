/**
 * Issue #355 — upgrade plan: the Plan screen lists what the business is on and the other plans;
 * choosing one asks the subscription service and the screen shows the new plan. (The Pay button
 * itself is covered by the subscription contract tests; here the assertion is the choice a
 * person can actually make on the screen.)
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("choose a different plan on the Plan screen (#355)", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await page.goto("/#plan");

  await expect(page.locator("#plan-options .activity-row").first()).toBeVisible();
  const before = await page.locator("#plan-name").innerText();

  // Every plan except the current one has a choose button — take the first offered.
  const choose = page.locator("#plan-options .activity-row button").first();
  const chosen = await choose.innerText();
  await choose.click();

  // The subscription service's own answer, in the recorded box.
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-icon")).toHaveText("✓", { timeout: 20_000 });
  await page.locator("#review-cancel").click();
  await expect(page.locator("#review-dialog")).toBeHidden();

  // The screen now names the chosen plan.
  await expect(page.locator("#plan-name")).toHaveText(chosen);
  await expect(page.locator("#plan-name")).not.toHaveText(before);
});
