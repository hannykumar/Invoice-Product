/**
 * Issue #355 — invite a teammate. The Team screen ships with #343 (PR #478, open when this
 * suite was written): the invite form is `#team-invite` (an address and a role) and a created
 * invite shows its sign-in link in `#team-link`. The test is skipped, with the reason written,
 * until that screen lands on main — it self-enables the day `#view-team` exists.
 */
import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers.ts";

test("invite a teammate from the Team screen (#355)", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await page.goto("/#team");
  const view = page.locator("#view-team");
  await view.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
  test.skip(
    (await view.count()) === 0,
    "the Team screen is #343's — it lands with PR #478, which was still open on main; unskip when it merges",
  );

  const invite = page.locator("#team-invite");
  await invite.locator('[name="address"]').fill(`${unique("teammate").replaceAll(" ", ".")}@example.invalid`);
  await invite.locator('select[name="role"]').selectOption("staff");
  await invite.locator('button[type="submit"]').click();

  // The link to send the teammate, shown to the owner.
  await expect(page.locator("#team-link")).toBeVisible();
  await expect(page.locator("#team-link")).toContainText(/https?:\/\//);
});
