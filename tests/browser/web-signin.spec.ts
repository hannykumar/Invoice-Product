/**
 * Issue #495 — the first thing anyone meets: the sign-in. Each test is a visitor who has never been
 * here (Playwright gives every test its own cookies and storage), and what they see.
 *
 * Replaces the source-text checks on the automatic tester sign-in (the owner's request), the
 * invitation link, the HttpOnly session and "no password box"; and the connection banner (#312).
 */
import { expect, test, type Page } from "@playwright/test";
import { baseURL, signIn } from "./helpers.ts";
import { keepOffline } from "./offline.ts";
import { respondWith, watchPage, type PageWatch } from "./page-watch.ts";

let watch: PageWatch;

async function visit(page: Page, path = "/") {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto(path);
}
const loginDialog = (page: Page) => page.locator("#login-dialog");

test("a visitor meets the sign-in dialog, which asks for an address and a code — never a password", async ({ page }) => {
  await visit(page);
  await expect(loginDialog(page)).toBeVisible();
  await expect(page.locator('input[type="password"]'), "there is no password box anywhere on the page").toHaveCount(0);
  await expect(page.locator('#login-form [name="address"]')).toBeVisible();
  await expect(page.locator('#login-form [name="code"]'), "the code is asked for after the address, not before").toBeHidden();
  // The help text is tied to the dialog for a screen reader.
  await expect(loginDialog(page)).toHaveAttribute("aria-labelledby", "login-title");
  await expect(loginDialog(page)).toHaveAttribute("aria-describedby", "login-help");
  await expect(page.locator("#login-help")).not.toBeEmpty();
  // Hindi, before anyone is signed in.
  await page.locator("#locale").selectOption("hi-IN");
  await expect(page.locator("#login-title")).toHaveText(/[ऀ-ॿ]/);
  await page.locator("#locale").selectOption("en-IN");
  await expect(page.locator("#login-title")).not.toHaveText(/[ऀ-ॿ]/);

});

test("the session is a cookie set by the server that the page cannot read: none in storage, none sent as a header", async ({ page }) => {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  await expect(page.locator("#view-dashboard h1")).toHaveText(/^Namaste/);
  expect(await page.evaluate(() => document.cookie), "scripts see no cookie").toBe("");
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "__Host-karobar_session");
  expect(session, "the server set the session cookie").toBeDefined();
  expect(session!.httpOnly, "which scripts cannot read").toBe(true);
  expect(session!.secure).toBe(true);
  expect(session!.sameSite).toBe("Lax");
  expect(watch.sent.length).toBeGreaterThan(3);
  expect(watch.sent.every((sent) => sent.headers.authorization === undefined), "and no request carries a bearer token").toBe(true);
  expect(await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(([key, value]) => /session|token|bearer/i.test(key) || /^[A-Za-z0-9_-]{32,}$/.test(value)))).toEqual([]);
});

test("on a developer's machine the page signs in as the tester by itself — no dialog, no code", async ({ page }) => {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  // The server says the tester route is on offer (as it does on a developer's machine); the real server then signs in.
  const restore = await respondWith(page, "/api/auth/tester", { method: "GET", body: { automatic: true } });
  await page.goto("/");
  await expect(page.locator("#view-dashboard h1")).toHaveText(/^Namaste/);
  await restore();
  await expect(loginDialog(page), "nobody met the sign-in dialog").toBeHidden();
  const calls = watch.calls();
  expect(calls).toContain("POST /api/auth/tester");
  expect(calls, "and nobody was asked for a code").not.toContain("POST /api/auth/code");
});

test("where the tester route is not there (a shop's real server answers 404), the page asks for the address and shows no tester button", async ({ page }) => {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await respondWith(page, "/api/auth/tester", { status: 404, body: { error: "not found" } });
  await page.goto("/");
  await expect(loginDialog(page)).toBeVisible();
  await watch.requested("/api/auth/tester");
  await expect(page.locator("#login-tester")).toBeHidden();
  expect(watch.calls()).not.toContain("POST /api/auth/tester");
});

test("an invitation link is taken up by its own sign-in, never by the automatic tester", async ({ page }) => {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  // Even where the tester route is on offer, a person who followed an invitation signs in as themselves.
  await respondWith(page, "/api/auth/tester", { method: "GET", body: { automatic: true } });
  await page.goto("/#join=invite-token-for-a-test");
  await expect(loginDialog(page)).toBeVisible();
  await watch.requested("/api/auth/tester");
  expect(watch.calls().filter((call) => call === "POST /api/auth/tester")).toEqual([]);
  await expect(page.locator("#login-help")).toContainText(/invit/i);
  expect(await page.evaluate(() => location.hash), "the invitation token leaves the address bar").toBe("#dashboard");
});

test("the connection banner is hidden while the shop answers and appears, in plain words, only when it does not", async ({ page }) => {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  await expect(page.locator("#connection-banner")).toBeHidden();
  const restore = await respondWith(page, "/api/dashboard", { status: 503, body: { error: { code: "UNAVAILABLE", message: "down" } } });
  await page.reload();
  await expect(page.locator("#connection-banner")).toBeVisible();
  await expect(page.locator("#connection-banner strong")).toHaveText("Nothing was saved");
  await expect(page.locator("#connection-banner")).toContainText("That did not work, and nothing was changed. Please try again.");
  await expect(page.locator("#connection-banner")).toHaveAttribute("role", "status");
  await restore();
  await page.reload();
  await expect(page.locator("#connection-banner")).toBeHidden();
});
