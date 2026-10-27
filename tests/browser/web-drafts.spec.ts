/**
 * Issue #495 (replaces #266's and its follow-up's source-slicing harnesses) — a form left half done
 * on this device comes back correctly on another day, and when its lists arrive late.
 *
 * Each test seeds the draft the way the page itself keeps it (localStorage), reloads the real page and
 * reads what the person sees. The late-lists case holds the server's answer on the wire, types while
 * it waits, then lets it through — the situation the old test could only imitate with fake boxes.
 */
import { expect, test, type Page } from "@playwright/test";
import { apiSignIn, baseURL, signIn } from "./helpers.ts";
import { keepOffline } from "./offline.ts";
import { addCustomer, addGoods, distinct, openShop, type Shop } from "./arrange.ts";
import { holdRequests, watchPage, type PageWatch } from "./page-watch.ts";

let shop: Shop;
let customer: { id: string; name: string };
let goods: { id: string; name: string };
let watch: PageWatch;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const daysBefore = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    shop = await openShop(request, await apiSignIn(request));
    customer = await addCustomer(request, shop, distinct("Draft Customer"));
    goods = await addGoods(request, shop, { name: distinct("Draft Steel"), unit: "KGS", price: "90", rate: "1800", stock: "600" });
  } finally { await request.dispose(); }
});

const field = (flow: string, name: string) => `[data-draft="${flow}"] [name="${name}"]`;
const partyField = (flow: string) => (flow === "purchase" ? "supplierId" : flow === "sale" ? "party" : "partyId");

/** Signs in, leaves a draft on the device, and opens the screen afresh — as a person returning the next day does. */
async function returnTo(page: Page, flow: string, saved: Record<string, unknown>, options: { hold?: string; locale?: string } = {}) {
  watch = watchPage(page);
  await keepOffline(page, baseURL());
  await page.goto("/");
  await signIn(page);
  await page.evaluate(([key, value, locale]) => { localStorage.setItem(key!, value!); localStorage.setItem("karobar.locale", locale!); }, [`karobar.draft.${flow}`, JSON.stringify(saved), options.locale ?? "en-IN"]);
  const held = options.hold === undefined ? undefined : await holdRequests(page, options.hold);
  await page.goto(`/#${flow}`);
  await page.reload();
  await expect(page.locator(".view.active")).toHaveAttribute("id", `view-${flow}`);
  return held;
}
const listsLoaded = (page: Page, flow: string) => expect.poll(() => page.locator(`${field(flow, partyField(flow))} option`).count()).toBeGreaterThan(1);
const note = (page: Page, flow: string) => page.locator(`#${flow}-draft-date-note`);
const stored = (page: Page, flow: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), `karobar.draft.${flow}`);

test("a sale started on an earlier day comes back dated today, with one line saying so", async ({ page }) => {
  const started = daysBefore(shop.today, 1);
  await returnTo(page, "sale", { party: customer.id, date: started, __startedOn: started, __savedOn: started });
  await listsLoaded(page, "sale");
  await expect(page.locator(field("sale", "date"))).toHaveValue(shop.today);
  await expect(note(page, "sale")).toBeVisible();
  await expect(note(page, "sale").locator("[data-note-text]")).toHaveText(`This sale was started on ${longDate(started)}. Its date is now today, ${longDate(shop.today)}. Change it only if the goods really left on another day.`);
});

test("a sale dated yesterday on purpose today is left alone when the page is reloaded the same day", async ({ page }) => {
  const yesterday = daysBefore(shop.today, 1);
  await returnTo(page, "sale", { party: customer.id, date: yesterday, __startedOn: shop.today, __savedOn: shop.today });
  await listsLoaded(page, "sale");
  await expect(page.locator(field("sale", "date"))).toHaveValue(yesterday);
  await expect(note(page, "sale")).toBeHidden();
});

test("a supplier bill keeps the supplier's own date, and money entries keep the day the money moved — each says so", async ({ page }) => {
  const started = daysBefore(shop.today, 1);
  const billDate = daysBefore(shop.today, 2);
  await returnTo(page, "purchase", { supplierId: shop.supplier.id, reference: "SRS-101", date: billDate, __startedOn: started, __savedOn: started });
  await listsLoaded(page, "purchase");
  await expect(page.locator(field("purchase", "date")), "the supplier's bill date is never changed").toHaveValue(billDate);
  await expect(note(page, "purchase").locator("[data-note-text]")).toHaveText(`This supplier bill was started on ${longDate(started)}. Its bill date is kept as ${longDate(billDate)}, because it is the supplier's date. Check it against their bill.`);

  for (const flow of ["payment", "paid"]) {
    await returnTo(page, flow, { amount: "500", date: started, __startedOn: started, __savedOn: started });
    await listsLoaded(page, flow);
    await expect(page.locator(field(flow, "date")), `${flow}: the day the money moved is kept`).toHaveValue(started);
    await expect(note(page, flow).locator("[data-note-text]")).toHaveText(`This entry was started on ${longDate(started)}. Its date is kept as ${longDate(started)}. Change it if the money moved on another day.`);
  }
});

test("the date line is said in Hindi to a Hindi reader", async ({ page }) => {
  const started = daysBefore(shop.today, 1);
  await returnTo(page, "sale", { party: customer.id, date: started, __startedOn: started, __savedOn: started }, { locale: "hi-IN" });
  await listsLoaded(page, "sale");
  const hindi = await note(page, "sale").locator("[data-note-text]").textContent();
  expect(hindi).toMatch(/[ऀ-ॿ]/);
  expect(hindi).not.toMatch(/was started on/);
});

test("a sale's customer and item lines come back even when the lists arrive after the draft is put back", async ({ page }) => {
  const saved = { party: customer.id, reference: "PO-7", date: shop.today, __lines: [{ item: goods.id, quantity: "450", rate: "90" }], __startedOn: shop.today, __savedOn: shop.today };
  const slow = await returnTo(page, "sale", saved, { hold: "/api/catalogue" });
  try {
    await expect(page.locator(field("sale", "reference"))).toBeAttached();
    await expect(page.locator(field("sale", "party")), "the customer list is not here yet, so the box cannot show the customer").toHaveValue("");
    // Something is typed while the lists are still on their way: the saved customer and lines survive it.
    // (The reference box sits on a later slide, so it is changed as the page's own input event would.)
    await page.locator(field("sale", "reference")).evaluate((input) => { (input as HTMLInputElement).value = "PO-7A"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await expect.poll(() => stored(page, "sale").then((draft) => draft.reference)).toBe("PO-7A");
    const waiting = await stored(page, "sale");
    expect(waiting.party, "the customer is kept while waiting").toBe(customer.id);
    expect(waiting.__lines, "and so are the lines").toEqual(saved.__lines);
  } finally { await slow!.release(); }
  await listsLoaded(page, "sale");
  await expect(page.locator(field("sale", "party"))).toHaveValue(customer.id);
  await expect(page.locator('#sale-lines [data-line-field="quantity"]')).toHaveValue("450");
  await expect(page.locator('#sale-lines [data-line-field="rate"]')).toHaveValue("90");
  await expect(page.locator("#sale-lines [data-item-search]"), "the item box shows the item by its name").toHaveValue(goods.name);
  const after = await stored(page, "sale");
  expect(after.party).toBe(customer.id);
  expect(after.__lines.map((line: any) => [line.item, line.quantity, line.rate]), "the lines on screen are what is saved now").toEqual([[goods.id, "450", "90"]]);
});

test("a supplier bill gets its supplier, line and GST rate back; money entries get their party; a removed party is let go", async ({ page }) => {
  await returnTo(page, "purchase", { supplierId: shop.supplier.id, reference: "SRS-101", date: shop.today, __lines: [{ item: goods.id, quantity: "500", rate: "64", gst: "1800" }], __startedOn: shop.today, __savedOn: shop.today });
  await listsLoaded(page, "purchase");
  await expect(page.locator('#purchase-lines [data-line-field="gst"]')).toHaveValue("1800");
  await expect(page.locator(field("purchase", "supplierId"))).toHaveValue(shop.supplier.id);
  await expect(page.locator('#purchase-lines [data-line-field="quantity"]')).toHaveValue("500");
  await expect(page.locator('#purchase-lines [data-line-field="rate"]')).toHaveValue("64");

  for (const [flow, party] of [["payment", customer.id], ["paid", shop.supplier.id]] as const) {
    await returnTo(page, flow, { partyId: party, amount: "500", date: shop.today, __startedOn: shop.today, __savedOn: shop.today });
    await listsLoaded(page, flow);
    await expect(page.locator(field(flow, "partyId")), flow).toHaveValue(party);
  }

  // The list has loaded and the saved customer is no longer on it: it is let go, not kept for ever.
  await returnTo(page, "payment", { partyId: "removed-long-ago", amount: "500", date: shop.today, __startedOn: shop.today, __savedOn: shop.today });
  await listsLoaded(page, "payment");
  await expect(page.locator(field("payment", "partyId"))).toHaveValue("");
  await page.locator(field("payment", "amount")).fill("600");
  await expect.poll(() => stored(page, "payment").then((draft) => draft.partyId)).toBe("");
  expect(watch.problems).toEqual([]);
});
