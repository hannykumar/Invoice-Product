/**
 * Issue #353 — keyboard and screen-reader access, checked on the rendered page. The rules are in
 * a11y-audit.ts (WCAG 2.2 AA, the ones a browser can decide). Real screen readers and a real phone
 * are NOT covered; docs/ui-conventions.md says so.
 */
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./a11y-audit.ts";
import { signIn } from "./helpers.ts";

const open = async (page: Page, view: string) => { await page.evaluate((v) => { location.hash = v; }, view); await expect(page.locator(`#view-${view}`)).toHaveClass(/active/); };
const allViews = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".view")].map((view) => view.id.replace("view-", "")));

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.locator("#home-money-main")).not.toBeEmpty();
});

// One visit to each screen, judged four ways (light and dark, phone and desktop width). Opening a screen
// reads from the server, and the per-person limit of #350 is 600 requests a minute, so the screens are
// opened once, not once per combination.
test("every screen passes the DOM checks, light and dark, at 375 and 1100 px wide (#353)", async ({ page }) => {
  const problems: string[] = [];
  const looks = [
    { scheme: "light", width: 375 }, { scheme: "light", width: 1100 }, { scheme: "dark", width: 375 }, { scheme: "dark", width: 1100 },
  ] as const;
  for (const view of await allViews(page)) {
    await open(page, view);
    // Let the screen's own read settle; a skeleton is judged on its own below.
    await page.waitForFunction((v) => document.querySelector(`#view-${v} > [data-state="loading"]`) === null, view);
    for (const { scheme, width } of looks) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      for (const found of await audit(page, `#view-${view}`)) problems.push(`${view} (${scheme}, ${width}px): ${found.rule} · ${found.where} · ${found.detail}`);
      if (width === 375) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) problems.push(`${view} (${scheme}, ${width}px): 1.4.10 reflow · the page scrolls sideways by ${overflow}px`);
      }
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the whole shell has names, a landmark and live regions (#353)", async ({ page }) => {
  expect(await audit(page, "body > .app-shell")).toEqual([]);
  await expect(page.locator("main#main")).toHaveCount(1);
  await expect(page.locator("#announce-polite")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#announce-urgent")).toHaveAttribute("role", "alert");
  await expect(page.locator("html")).toHaveAttribute("lang", /./);
});

test("Tab goes to the skip link first, and Enter lands in the main part (#353)", async ({ page }) => {
  // A fresh page, as a person arrives at it: nothing focused yet.
  await page.reload();
  await expect(page.locator("#home-money-main")).not.toBeEmpty();
  await page.keyboard.press("Tab");
  const skip = page.locator(".skip-link");
  await expect(skip).toBeFocused();
  expect(await skip.boundingBox()).not.toBeNull();
  await page.evaluate(() => { location.hash = "plan"; });
  await expect(page.locator("#view-plan")).toHaveClass(/active/);
  await page.reload();
  await expect(page.locator("#view-plan")).toHaveClass(/active/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  // Skipping stays on the same screen (it once went Home) and puts focus on the main part.
  await expect(page.locator("main#main")).toBeFocused();
  await expect(page.locator("#view-plan")).toHaveClass(/active/);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("main") !== null)).toBe(true);
});

test("everything on a screen can be reached by Tab, and the focus is always visible (#353)", async ({ page }) => {
  for (const view of ["dashboard", "team", "plan", "items", "design"]) {
    await open(page, view);
    await page.waitForFunction((v) => document.querySelector(`#view-${v} > [data-state="loading"]`) === null, view);
    const wanted = await page.evaluate((v) => [...document.querySelectorAll(`#view-${v} button, #view-${v} input:not([type=hidden]), #view-${v} select, #view-${v} textarea, #view-${v} a[href]`)]
      .filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && !node.closest("[hidden]") && getComputedStyle(node).visibility !== "hidden"; })
      .map((node, index) => { node.setAttribute("data-tab-probe", String(index)); return index; }), view);
    // Start just before the screen's first control: focus the heading, then Tab on.
    await page.locator(`#view-${view} h1`).focus();
    const reached = new Set<string>();
    const unseen: string[] = [];
    for (let step = 0; step < wanted.length + 5; step += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null;
        if (!node) return null;
        const style = getComputedStyle(node);
        const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
        return { probe: node.getAttribute("data-tab-probe"), ring: ring || style.boxShadow !== "none", label: `${node.tagName.toLowerCase()}#${node.id}` };
      });
      if (info?.probe !== null && info?.probe !== undefined) reached.add(info.probe);
      // Tab from the last control goes up to the browser's own bar, and the page reports <body>: not a control.
      if (info && !info.ring && info.label !== "body#") unseen.push(info.label);
    }
    const missed = wanted.filter((index) => !reached.has(String(index)));
    expect(missed, `${view}: controls Tab never reached`).toEqual([]);
    expect(unseen, `${view}: focus had no visible ring on`).toEqual([]);
  }
});

test("a box keeps Tab inside it, Esc closes it and focus goes back to the button (#353)", async ({ page }) => {
  await open(page, "design");
  const opener = page.locator("#design-demo-dialog");
  await opener.focus();
  await page.keyboard.press("Enter");
  const box = page.locator("#design-demo-dialog-box");
  await expect(box).toBeVisible();
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    // Inside the box, or on <body> while the browser's own bar has it: never a control on the page behind.
    expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement?.closest("dialog") !== null), `Tab press ${press + 1} left the box`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await expect(opener).toBeFocused();
});

test("F2 opens a new bill from anywhere, by keyboard alone (#353)", async ({ page }) => {
  await open(page, "plan");
  await page.keyboard.press("F2");
  await expect(page.locator("#view-sale")).toHaveClass(/active/);
});

test("with reduced motion asked for, the loading bars do not animate (#353)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "design");
  expect(await page.locator("#design-demo-loading .skeleton-bar").first().evaluate((bar) => getComputedStyle(bar).animationName)).toBe("none");
});

test("an invalid field is marked, explained beside the box and given focus (#353)", async ({ page }) => {
  await open(page, "design");
  const field = page.locator("#design-demo-field");
  await field.fill("29ABCDE1234F1Z9X");
  await page.locator("#design-demo-form button[type=submit]").click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  const help = await field.getAttribute("aria-describedby");
  await expect(page.locator(`#${help}`)).toContainText("does not match");
});
