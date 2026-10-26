/**
 * Issue #355 — invite a teammate. The Team screen is #343's (PR #478, merged): the invite form
 * is `#team-invite` (an address and a role) and a created invite shows its sign-in link in
 * `#team-link`.
 */
import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers.ts";

test("invite a teammate from the Team screen (#355)", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await page.goto("/#team");
  await expect(page.locator("#view-team")).toBeVisible();

  const invite = page.locator("#team-invite");
  await invite.locator('[name="address"]').fill(`${unique("teammate").replaceAll(" ", ".")}@example.invalid`);
  await invite.locator('select[name="role"]').selectOption("staff");
  await invite.locator('button[type="submit"]').click();

  // The link to send the teammate, shown to the owner.
  await expect(page.locator("#team-link")).toBeVisible();
  await expect(page.locator("#team-link")).toContainText(/https?:\/\//);
});
