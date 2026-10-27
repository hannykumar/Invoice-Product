/**
 * Issue #495 — the page's screens, navigation, languages and layout, driven in a real browser.
 *
 * These replace what apps/web/test/web.test.ts used to check by reading app.js and index.html as
 * text. A regular expression over the source proves a string exists, not that a button opens its
 * screen. Every check here loads the real page from the real server, clicks and types like a person,
 * and asserts what the person sees (text, focus, what is shown or hidden, computed layout) and what
 * the page sends to the server. See docs/testing.md, "Testing the web app".
 */
import { expect, test, type Page } from "@playwright/test";
import { apiSignIn, baseURL, signIn } from "./helpers.ts";
import { addCustomer, addGoods, distinct, openShop, recordSale, type Shop } from "./arrange.ts";
import { keepOffline } from "./offline.ts";
import { watchPage, type PageWatch } from "./page-watch.ts";

let watch: PageWatch;
let shop: Shop;
let goods: { id: string; name: string };

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    shop = await openShop(request, await apiSignIn(request));
    // Something sold on credit and something paid for, so Home has bills to show chips on.
    goods = await addGoods(request, shop, { name: distinct("Screen Test Soap"), stock: "40", price: "30" });
    const customer = await addCustomer(request, shop, distinct("Screen Test Customer"));
    await recordSale(request, shop, { customerId: customer.id, itemId: goods.id, quantity: "2", rate: "30" });
    await recordSale(request, shop, { customerId: customer.id, itemId: goods.id, quantity: "3", rate: "30", terms: "30" });
  } finally { await request.dispose(); }
});

/** A signed-in page on `#hash`, refusing every host but the local server. */
async function openApp(page: Page, hash = "") {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  if (hash !== "") await page.goto(`/#${hash}`);
  await expect(page.locator("#login-dialog")).toBeHidden();
}

const screenNow = (page: Page) => page.evaluate(() => document.querySelector(".view.active")?.id.replace(/^view-/, ""));
/** Opens a screen the way an old bookmark does: by its address. */
async function openByAddress(page: Page, view: string) {
  await page.evaluate((target) => { location.hash = `#${target}`; }, view);
  await expect(page.locator(".view.active")).toHaveAttribute("id", `view-${view}`);
}
const tab = (page: Page, view: string) => page.locator(`.app-tabbar [data-view="${view}"]`);

test("the page opens signed in with no error, and Home is the first screen", async ({ page }) => {
  await openApp(page);
  expect(await screenNow(page)).toBe("dashboard");
  await expect(page.locator("#view-dashboard h1")).toHaveText(/^Namaste, /);
  await expect(page.locator("#login-dialog")).toBeHidden();
  expect(watch.problems).toEqual([]);
});

test("every screen opens from its address, shows exactly one screen, and puts the cursor on its heading", async ({ page }) => {
  await openApp(page);
  const screens = await page.$$eval("section.view", (sections) => sections.map((section) => section.id.replace(/^view-/, "")));
  expect(screens.length, "the check must cover the real screens").toBeGreaterThanOrEqual(28);
  for (const screen of screens) {
    await openByAddress(page, screen);
    await expect(page.locator(".view.active"), `${screen}: one screen on show`).toHaveCount(1);
    const named = page.locator(`#view-${screen}`).locator("h1").first();
    await expect(named, `${screen}: a heading names the screen`).not.toBeEmpty();
    await expect(named, `${screen}: the heading takes the focus so a screen reader starts there`).toBeFocused();
    expect(await page.evaluate(() => location.hash)).toBe(`#${screen}`);
    expect(await page.locator(`#view-${screen}`).getAttribute("aria-labelledby"), `${screen}: labelled by its heading`).toBe(await named.getAttribute("id"));
  }
  // An address nobody knows lands on Home, never on a blank page.
  await page.evaluate(() => { location.hash = "#no-such-screen"; });
  await expect(page.locator(".view.active")).toHaveAttribute("id", "view-dashboard");
  expect(watch.problems).toEqual([]);
});

test("five tabs — Home, Khata, + Bill, Items, More — are the whole menu, and More reaches every other screen", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".app-tabbar small")).toHaveText(["Home", "Khata", "Bill", "Items", "More"]);
  await expect(page.locator(".sidebar, .bottom-nav, #menu-button"), "the old 22-item menu is gone").toHaveCount(0);

  await tab(page, "items").click();
  expect(await screenNow(page)).toBe("items");
  await expect(tab(page, "items"), "the tab for the screen on show is marked").toHaveAttribute("aria-current", "page");
  await expect(tab(page, "dashboard")).not.toHaveAttribute("aria-current", /.*/);

  // Khata is who owes what: it opens Reports on the dues.
  await tab(page, "reports").click();
  expect(await screenNow(page)).toBe("reports");
  await expect(page.locator("#report-dues")).toBeAttached();

  await tab(page, "more").click();
  expect(await screenNow(page)).toBe("more");
  await expect(page.locator("#view-more h2")).toHaveText(["GST", "Stock", "People", "Business settings", "Reports"]);

  // No screen was dropped: each is one tap on a tab, a choice on + Bill, or a line on More (the design page has its own address).
  const reachable = await page.$$eval("[data-view]", (links) => [...new Set(links.map((link) => (link as HTMLElement).dataset.view))]);
  const screens = await page.$$eval("section.view", (sections) => sections.map((section) => section.id.replace(/^view-/, "")));
  expect(screens.filter((screen) => !reachable.includes(screen) && screen !== "design")).toEqual([]);
  // Every line on More actually opens the screen it names.
  const lines = await page.$$eval("#view-more [data-view]", (links) => links.map((entry) => (entry as HTMLElement).dataset.view!));
  expect(lines.length).toBeGreaterThan(15);
  for (const line of lines) {
    await openByAddress(page, "more");
    await page.locator(`#view-more [data-view="${line}"]`).first().click();
    expect(await screenNow(page), `More → ${line}`).toBe(line);
  }
  // The tab for a screen that is not a tab is More.
  await expect(page.locator("#more-tab")).toHaveAttribute("aria-current", "page");
});

test("+ Bill, F2 and Alt+N open a new sale from any screen; \"Other bills\" lists the rest and closes when one is chosen", async ({ page }) => {
  await openApp(page);
  await page.locator("#bill-button").click();
  expect(await screenNow(page)).toBe("sale");
  await expect(page.locator("#bill-button")).toHaveAttribute("aria-current", "page");

  await openByAddress(page, "items");
  await page.keyboard.press("F2");
  expect(await screenNow(page)).toBe("sale");
  await openByAddress(page, "paid");
  await page.keyboard.press("Alt+KeyN");
  expect(await screenNow(page)).toBe("sale");

  await page.locator("#other-bills").click();
  await expect(page.locator("#bill-sheet")).toBeVisible();
  const choices = await page.$$eval("#bill-sheet [data-view]", (buttons) => buttons.map((button) => ({ view: (button as HTMLElement).dataset.view, label: (button as HTMLElement).innerText.replace(/^\S+\s+/, ""), disabled: (button as HTMLButtonElement).disabled })));
  expect(choices).toEqual([
    { view: "sale", label: "Sale", disabled: false }, { view: "purchase", label: "Purchase", disabled: false },
    { view: "payment", label: "Money received", disabled: false }, { view: "paid", label: "Money paid", disabled: false },
    { view: "presale", label: "Quotation", disabled: false }, { view: "returns", label: "Return", disabled: false },
    { view: "books", label: "Expense", disabled: false },
  ]);
  await expect(page.locator("#bill-sheet [data-view=\"sale\"]"), "Sale is the one the cursor starts on").toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#bill-sheet")).toBeHidden();
  for (const choice of choices.slice(1)) {
    await openByAddress(page, "sale");
    await page.locator("#other-bills").click();
    await expect(page.locator("#bill-sheet")).toBeVisible();
    await page.locator(`#bill-sheet [data-view="${choice.view}"]`).click();
    expect(await screenNow(page), `Other bills → ${choice.label}`).toBe(choice.view);
    await expect(page.locator("#bill-sheet"), "choosing closes the sheet").toBeHidden();
  }
});

test("Hindi: every label speaks Hindi when chosen, and switching back restores English", async ({ page }) => {
  await openApp(page);
  const labels = () => page.evaluate(() => [...document.querySelectorAll("[data-i18n], [data-i18n-aria], [data-i18n-placeholder]")].map((element) => {
    const box = element as HTMLElement;
    return { key: box.dataset.i18n ?? box.dataset.i18nAria ?? box.dataset.i18nPlaceholder!, text: box.dataset.i18n ? box.textContent!.trim() : box.getAttribute(box.dataset.i18nAria ? "aria-label" : "placeholder") ?? "" };
  }));
  const english = await labels();
  expect(english.length, "translated labels on the page").toBeGreaterThan(70);
  expect(english.filter((label) => label.text === ""), "every label has English words").toEqual([]);

  await page.locator("#locale").selectOption("hi-IN");
  await expect(page.locator("#view-dashboard h1")).toHaveText(/नमस्ते/);
  const hindi = await labels();
  expect(hindi.filter((label) => label.text === ""), "every label has Hindi words").toEqual([]);
  const byKey = new Map(english.map((label) => [label.key, label.text]));
  // A label that is the same in both languages is a key that fell back to English (a brand or a unit may legitimately match).
  const fellBack = hindi.filter((label) => label.text === byKey.get(label.key) && /[A-Za-z]{4,}/.test(label.text));
  expect(fellBack.length, `too many labels still in English: ${[...new Set(fellBack.map((label) => label.key))].join(", ")}`).toBeLessThan(hindi.length * 0.1);
  for (const key of ["signOut", "tabHome", "tabKhata", "tabItems", "tabMore", "itemsTitle", "language"]) {
    const shown = hindi.find((label) => label.key === key);
    if (shown) expect(shown.text, `${key} is in Devanagari`).toMatch(/[ऀ-ॿ]/);
  }
  await expect(page.locator("#sign-out")).toHaveText(/[ऀ-ॿ]/);
  await expect(page.locator("html")).toHaveAttribute("lang", "hi-IN");
  expect(await page.evaluate(() => localStorage.getItem("karobar.locale")), "the choice is remembered").toBe("hi-IN");

  await page.locator("#locale").selectOption("en-IN");
  await expect(page.locator("#view-dashboard h1")).toHaveText(/^Namaste/);
  await expect(page.locator("#sign-out")).toHaveText("Sign out");
});

test("Home is one money card, the tasks that need the owner, and recent bills with a status chip — no old tiles", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".metric-card, .attention-panel")).toHaveCount(0);
  await expect(page.locator("#home-money-main")).toContainText("Sales today");
  // Either something needs the owner (each with its one button), or the page says all is clear.
  await expect.poll(async () => (await page.locator("#home-tasks li").count()) > 0 || await page.locator("#home-all-clear").isVisible()).toBe(true);
  const tasks = await page.locator("#home-tasks li").evaluateAll((rows) => rows.map((row) => row.querySelector("button") !== null));
  if (tasks.length > 0) {
    expect(tasks.every(Boolean), "each task offers its one button").toBe(true);
    await expect(page.locator("#home-all-clear"), "not \"all clear\" while something is waiting").toBeHidden();
  }
  const bills = await page.locator("#home-bills li").evaluateAll((rows) => rows.map((row) => row.querySelector(".chip")?.className ?? `NO CHIP: ${(row as HTMLElement).innerHTML.slice(0, 300)}`));
  expect(bills.length, "the recent bills are listed").toBeGreaterThan(0);
  expect(bills.every((chip) => /\bchip (paid|late|due)\b/.test(chip)), `every bill has a status chip: ${bills.join(" | ")}`).toBe(true);
});

test("Home is read again every time it is opened, so a task done elsewhere is gone", async ({ page }) => {
  await openApp(page);
  await tab(page, "items").click();
  const mark = watch.mark();
  await tab(page, "dashboard").click();
  await watch.requested("/api/dashboard", mark);
  await tab(page, "items").click();
  const again = watch.mark();
  await tab(page, "dashboard").click();
  await watch.requested("/api/dashboard", again);
});

test("the Items tab lists every item with what is left, adds one and changes one", async ({ page }) => {
  await openApp(page);
  await tab(page, "items").click();
  const rows = page.locator("#items-list li");
  const mine = rows.filter({ hasText: goods.name });
  await expect(mine).toHaveCount(1);
  // 40 bought, 5 sold: what is left, its HSN code and GST rate, and a way to change it.
  await expect(mine).toContainText("35 PCS");
  await expect(mine).toContainText("HSN 34011190 · GST 5%");
  await expect(mine.getByRole("button", { name: "Change" })).toBeVisible();
  const texts = await rows.allInnerTexts();
  expect(texts.every((row) => /left/i.test(row)), `every item says what is left: ${texts.join(" / ")}`).toBe(true);

  await page.locator("#items-add").click();
  await expect(page.locator("#item-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#item-dialog")).toBeHidden();

  await mine.getByRole("button", { name: "Change" }).click();
  await expect(page.locator("#item-edit-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#item-edit-dialog")).toBeHidden();
});

test("the session is a cookie the page never holds: none in storage, none sent, and signing out closes the books", async ({ page, request }) => {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  // This test signs out, which ends the session, so it uses a session of its own (the shared one is for other specs).
  const own = await apiSignIn(request);
  await page.context().addCookies([{ name: "__Host-karobar_session", value: own, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }]);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("karobar.signedIn", "1"));
  await page.reload();
  await expect(page.locator("#login-dialog")).toBeHidden();
  await expect(page.locator("#view-dashboard h1")).toHaveText(/^Namaste/);

  const stored = await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)]);
  expect(stored.filter(([key, value]) => /session|token|bearer/i.test(key) || /^[A-Za-z0-9_-]{32,}$/.test(value)), "nothing in this browser is a session token").toEqual([]);
  expect(await page.evaluate(() => document.cookie), "the session cookie is HttpOnly, so the page cannot read it").toBe("");
  expect(watch.sent.length).toBeGreaterThan(5);
  expect(watch.sent.every((sent) => sent.headers.authorization === undefined), "no request carries a bearer token").toBe(true);

  const mark = watch.mark();
  await page.locator("#sign-out").click();
  await expect(page.locator("#login-dialog")).toBeVisible();
  await watch.requested("/api/auth/sign-out", mark);
  expect(watch.calls(mark)).toContain("POST /api/auth/sign-out");
  expect(await page.evaluate(() => localStorage.getItem("karobar.signedIn"))).toBeNull();
  expect(await page.evaluate(() => fetch("/api/session", { credentials: "same-origin" }).then((reply) => reply.status)), "the server no longer knows this browser").toBe(401);
});

test("on a phone the five tabs are a bar at the bottom of the screen; on a desktop they are a rail down the left", async ({ page, browser }) => {
  await openApp(page);
  const measure = (view: Page) => view.evaluate(() => {
    const bar = document.querySelector(".app-tabbar") as HTMLElement;
    const box = bar.getBoundingClientRect();
    const tabs = [...bar.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return {
      bottom: box.bottom, left: box.left, width: box.width, height: box.height, viewport: { w: innerWidth, h: innerHeight }, position: getComputedStyle(bar).position,
      tabSpread: Math.max(...tabs.map((tabBox) => tabBox.top)) - Math.min(...tabs.map((tabBox) => tabBox.top)),
      bill: getComputedStyle(document.querySelector(".tabbar .tab-main > span")!).backgroundColor,
      avatar: getComputedStyle(document.querySelector(".topbar-actions .user-avatar")!).display,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const wide = await measure(page);
  expect(wide.left, "a narrow rail at the left edge").toBeLessThanOrEqual(1);
  expect(wide.width).toBeLessThan(wide.viewport.w / 3);
  expect(wide.height, "standing, not lying").toBeGreaterThan(wide.width);
  expect(wide.tabSpread, "five tabs one above the other").toBeGreaterThan(150);

  await page.setViewportSize({ width: 390, height: 780 });
  const small = await measure(page);
  expect(small.position).toBe("fixed");
  expect(Math.abs(small.bottom - small.viewport.h), "the bar sits on the bottom edge").toBeLessThanOrEqual(1);
  expect(small.width, "and spans the width").toBeGreaterThanOrEqual(small.viewport.w - 1);
  expect(small.tabSpread, "all five tabs on one row (the raised + Bill aside)").toBeLessThan(24);
  expect(small.avatar, "the avatar makes room on a phone").toBe("none");
  expect(small.overflowX, "the page never scrolls sideways on a phone").toBe(false);
  expect(small.bill, "+ Bill is the raised coloured button").not.toBe("rgba(0, 0, 0, 0)");
  void browser;
});

test("keyboard focus is always visible, and a person who asked for less motion gets none", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => { const style = getComputedStyle(document.activeElement!); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), tag: document.activeElement!.tagName }; });
  expect(ring.style !== "none" && ring.width > 0, `a focused ${ring.tag} shows an outline`).toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await page.evaluate(() => { const style = getComputedStyle(document.querySelector(".action-button, button")!); return { animation: parseFloat(style.animationDuration), transition: parseFloat(style.transitionDuration) }; });
  expect(motion.animation <= 0.001 && motion.transition <= 0.001, `reduced motion: ${JSON.stringify(motion)}`).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await openByAddress(page, "sale");
  await expect(page.locator("#view-sale .save-state"), "the \"saved on this device\" note is never hidden").toBeVisible();
});
