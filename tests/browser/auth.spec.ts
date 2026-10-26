/**
 * Issue #355 — sign-up and sign-in with the stand-in code, in a real browser.
 *
 * Sign-in is the two-tap code flow of #342: the address, then the code the development
 * identity provider shows in the hint. Sign-up today is the same flow on an address nobody has
 * used: the stand-in provider accepts it, the account is recorded, and the app says plainly
 * that no business has added this person yet (#342's FORBIDDEN) — the door a teammate's invite
 * (#343) will open.
 */
import { expect, test } from "@playwright/test";
import { DEMO_CODE, OWNER, signIn, unique } from "./helpers.ts";

test.describe("sign-up and sign-in (#355)", () => {
  test("the owner signs in with the stand-in code and reaches the dashboard", async ({ page }) => {
    await page.goto("/");
    // The login dialog opens by itself when nobody is signed in.
    const dialog = page.locator("#login-dialog");
    await expect(dialog).toBeVisible();
    const form = page.locator("#login-form");
    await form.locator('[name="address"]').fill(OWNER);
    await form.locator('button[type="submit"]').click();
    // The stand-in provider's hint names the code, the way a real message would carry it.
    await expect(page.locator("#login-hint")).toContainText(DEMO_CODE);
    await expect(page.locator("#login-code-field")).toBeVisible();
    await form.locator('[name="code"]').fill(DEMO_CODE);
    await form.locator('button[type="submit"]').click();
    await expect(dialog).toBeHidden();
    // The dashboard the owner lands on.
    await expect(page.locator(".view.active")).toHaveId("view-dashboard");
    await expect(page.locator("#view-dashboard h1")).toBeVisible();
  });

  test("a wrong code is refused with a reason, and the dialog stays open", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("#login-form");
    await form.locator('[name="address"]').fill(OWNER);
    await form.locator('button[type="submit"]').click();
    await expect(page.locator("#login-code-field")).toBeVisible();
    await form.locator('[name="code"]').fill("000000");
    await form.locator('button[type="submit"]').click();
    await expect(page.locator("#login-error")).not.toBeEmpty();
    await expect(page.locator("#login-dialog")).toBeVisible();
  });

  test("a new address signs up with the stand-in code and is told no business has added it yet", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("#login-form");
    await form.locator('[name="address"]').fill(`${unique("new-owner").replaceAll(" ", ".")}@example.invalid`);
    await form.locator('button[type="submit"]').click();
    await expect(page.locator("#login-hint")).toContainText(DEMO_CODE);
    await form.locator('[name="code"]').fill(DEMO_CODE);
    await form.locator('button[type="submit"]').click();
    // Signed up, but no company owns this address: the server refuses with a sentence (#342).
    await expect(page.locator("#login-error")).toContainText(/signed up|no business/i);
    await expect(page.locator("#login-dialog")).toBeVisible();
  });

  test("a signed-in owner sees their business's own screens", async ({ page }) => {
    await page.goto("/");
    await signIn(page);
    // The more-sheet navigates to every screen; GST returns is one of them.
    await page.locator('[data-view="more"]').click();
    await page.locator('[data-view="gst-returns"]').click();
    await expect(page.locator("#view-gst-returns")).toBeVisible();
    await expect(page.locator("#gst-return-form")).toBeVisible();
  });
});
