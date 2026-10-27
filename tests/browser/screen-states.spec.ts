/**
 * Issue #353 — every screen that reads from the books handles the four states, driven in the real
 * browser against the real page: loading (a skeleton and aria-busy), empty (a sentence and the next
 * step), error (what happened, what to do, Try again — and never a stack trace or an id) and ready.
 *
 * The list of screens is not written here: it is read from the page's own markup (`data-screen`),
 * so a screen added later without a state region fails this file until it handles the states.
 */
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers.ts";

const views = (page: Page, kind: string) => page.evaluate((k) => [...document.querySelectorAll(`.view[data-screen="${k}"]`)].map((view) => view.id.replace("view-", "")), kind);
const stateOf = (page: Page, view: string) => page.locator(`#view-${view} [data-state-region]`).first();
const open = (page: Page, view: string) => page.evaluate((v) => { location.hash = v; }, view);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.locator("#home-money-main")).not.toBeEmpty();
});

test("every screen declares what kind it is, and a data screen has exactly one state region (#353)", async ({ page }) => {
  const all = await page.evaluate(() => [...document.querySelectorAll(".view")].map((view) => ({ id: view.id, kind: view.getAttribute("data-screen"), regions: view.querySelectorAll(":scope > [data-state-region]").length })));
  expect(all.length).toBeGreaterThan(20);
  for (const view of all) {
    expect(["data", "form", "static"], `${view.id} must say data-screen="data|form|static"`).toContain(view.kind);
    expect(view.regions, `${view.id}: a data screen has one state region, the others none`).toBe(view.kind === "data" ? 1 : 0);
  }
});

test("with the network off, every data screen says so in plain words and offers Try again (#353)", async ({ page, context }) => {
  const data = await views(page, "data");
  await context.setOffline(true);
  for (const view of data) {
    await open(page, "more");
    await open(page, view);
    const region = stateOf(page, view);
    await expect(region, `${view}: offline`).toHaveAttribute("data-state", "error");
    const text = (await region.innerText()).toLowerCase();
    expect(text, `${view}: says it cannot reach Karobar`).toContain("can't reach karobar");
    expect(text, `${view}: no technical words`).not.toMatch(/failed to fetch|typeerror|undefined|stack|networkerror|\bhttp\b|\b50\d\b/);
    await expect(region.getByRole("button", { name: "Try again" }), `${view}: a Try again button`).toBeVisible();
    await expect(region.getByRole("alert")).toBeVisible();
  }
  await context.setOffline(false);
});

test("Try again reads the screen again and lands on the result, with focus kept (#353)", async ({ page, context }) => {
  await open(page, "team");
  await context.setOffline(true);
  await open(page, "more");
  await open(page, "team");
  const region = stateOf(page, "team");
  await expect(region).toHaveAttribute("data-state", "error");
  await context.setOffline(false);
  await region.getByRole("button", { name: "Try again" }).click();
  await expect(region).toHaveAttribute("data-state", "ready");
  await expect(region).toHaveAttribute("aria-busy", "false");
  const focusInside = await page.evaluate(() => document.activeElement?.closest("[data-state-region]")?.id);
  expect(focusInside, "focus must not fall to the top of the page").toBe("screen-state-team");
});

test("a server fault is explained as ours, with no status code or id (#353)", async ({ page }) => {
  await page.route("**/api/team**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "SERVER_BOOM", message: "pg connection 10.0.0.4 refused (req 7f3a)" }) }));
  await open(page, "more");
  await open(page, "team");
  const region = stateOf(page, "team");
  await expect(region).toHaveAttribute("data-state", "error");
  const text = await region.innerText();
  expect(text).toContain("problem on its side");
  expect(text).not.toMatch(/pg connection|10\.0\.0\.4|7f3a|SERVER_BOOM|503/);
});

test("a slow answer shows loading: a skeleton, aria-busy and a polite status (#353)", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/team**", async (route) => { await held; await route.continue(); });
  await open(page, "more");
  await open(page, "team");
  const region = stateOf(page, "team");
  await expect(region).toHaveAttribute("data-state", "loading");
  await expect(region).toHaveAttribute("aria-busy", "true");
  await expect(region.getByRole("status")).toHaveText("Loading…");
  await expect(region.locator(".skeleton-bar").first()).toBeVisible();
  release();
  await expect(region).toHaveAttribute("data-state", "ready");
});

test("an empty list says what is missing and offers the next step (#353)", async ({ page }) => {
  await page.route("**/api/dashboard**", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, activity: [] } });
  });
  await open(page, "more");
  await open(page, "activity");
  const region = stateOf(page, "activity");
  await expect(region).toHaveAttribute("data-state", "empty");
  await expect(region).toContainText("No recorded activity");
  await region.getByRole("button").click();
  await expect(page.locator("#view-sale")).toHaveClass(/active/);
});

test("an empty Items list offers Add item, and the button opens the add box (#353)", async ({ page }) => {
  await page.route("**/api/catalogue**", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, items: [] } });
  });
  await page.reload();
  await expect(page.locator("#home-money-main")).not.toBeEmpty();
  await open(page, "items");
  const region = stateOf(page, "items");
  await expect(region).toHaveAttribute("data-state", "empty");
  await region.getByRole("button").click();
  await expect(page.locator("#item-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#item-dialog")).toBeHidden();
});

test("a write that fails is announced at once and the button comes back (#353)", async ({ page, context }) => {
  await open(page, "design");
  await expect(page.locator("#design-content")).toBeVisible();
  await context.setOffline(false);
  await page.locator("#design-demo-fail").click();
  await expect(page.locator("#design-demo-status")).toHaveAttribute("data-kind", "error");
  await expect(page.locator("#announce-urgent")).toContainText("problem");
  await expect(page.locator("#design-demo-fail")).toBeEnabled();
});

test("a form button is off while its request is in flight, so it cannot be sent twice (#353)", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/team/invite", async (route) => { await held; await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "X", message: "Already invited." }) }); });
  await open(page, "team");
  const form = page.locator("#team-invite");
  await form.locator("input").first().fill("someone@example.invalid");
  const send = form.locator('button[type="submit"]');
  await send.click();
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute("aria-busy", "true");
  release();
  await expect(send).toBeEnabled();
});
