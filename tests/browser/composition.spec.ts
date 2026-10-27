/**
 * Issue #296 — a business that pays GST under the composition scheme: it says so (the change is
 * checked in words first, then confirmed), and the GST returns screen sends it to CMP-08 and GSTR-4
 * instead of GSTR-1 and GSTR-3B.
 *
 * Runs on the second seeded company (Konkan Fresh Foods), so changing its scheme cannot disturb the
 * flows that share the first. The change starts on the next 1 April, which is after any bill the
 * company has, and a repeat run finds it already there and goes on to the screens.
 */
import { expect, test } from "@playwright/test";
import { apiCall, apiSignIn, signIn, today } from "./helpers.ts";

const KONKAN = "owner@konkan.example.invalid";

/** The 1 April after `date`, which no bill can be dated on or after yet. */
const nextApril = (date: string): string => {
  const year = Number(date.slice(0, 4));
  return `${date.slice(5) < "04-01" ? year : year + 1}-04-01`;
};

test("choose the composition scheme, read what it changes, and find CMP-08 where GSTR-1 was (#296)", async ({ page, request }) => {
  const cookie = await apiSignIn(request, KONKAN);
  const date = await today(request, cookie);
  const from = nextApril(date);
  const before = await apiCall(request, cookie, "/api/composition/scheme");

  await page.goto("/");
  await signIn(page, KONKAN);
  await page.goto("/#composition");
  await expect(page.locator("#composition-title")).toBeVisible();

  if (before.history.length === 0) {
    const form = page.locator("#composition-root form");
    await form.locator('[name="effectiveFrom"]').fill(from);
    await form.locator('[name="newlyRegistered"]').check();
    for (const name of ["withinLimit", "noInterState", "noEcommerce", "rateConfirmed"]) await form.locator(`[name="${name}"]`).check();
    await page.getByRole("button", { name: "Check what this changes" }).click();
    // The change is described in plain words before anything is saved.
    await expect(page.locator("#composition-root")).toContainText("Bills of Supply");
    await expect(page.locator("#composition-root")).toContainText("composition taxable person, not eligible to collect tax on supplies");
    await expect(page.locator("#composition-root")).toContainText("ITC-03");
    expect((await apiCall(request, cookie, "/api/composition/scheme")).history).toHaveLength(0);
    await page.getByRole("button", { name: "Confirm and change the scheme" }).click();
    await expect(page.locator("#composition-root")).toContainText(from);
  }
  const after = await apiCall(request, cookie, "/api/composition/scheme");
  expect(after.history.length).toBeGreaterThan(0);
  expect(after.history[0].scheme).toBe("COMPOSITION");

  // From the day the scheme starts, the regular returns screen points to CMP-08 and GSTR-4.
  const start = after.history[0].effectiveFrom as string;
  await page.goto("/#gst-returns");
  await page.locator('#gst-return-form [name="period"]').fill(`${start.slice(0, 7)}`);
  await page.locator('#gst-return-form button[type="submit"]').click();
  await expect(page.locator("#gst-summary")).toContainText("CMP-08");
  await page.getByRole("button", { name: "Open the composition returns" }).click();
  await expect(page.locator("#composition-title")).toBeVisible();
});
