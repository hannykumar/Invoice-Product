/**
 * Issue #355 — shared helpers for the browser flows. UI sign-in goes through the real login
 * dialog; API sign-in (for arranging stock and records a flow needs) goes through the same two
 * routes the dialog calls.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const OWNER = "owner@sampoorna.example.invalid";
export const DEMO_CODE = "246810";

export const baseURL = () => `http://127.0.0.1:${process.env.WEB_PORT ?? process.env.PORT ?? 4173}`;

/** Names that stay unique across runs, so records from an earlier run never collide. */
export const unique = (word: string) => `${word} ${Date.now().toString(36)}`;

/**
 * Sessions already opened through the dialog in this run, by address. #350 limits how many codes one
 * address may ask for (5 in 15 minutes), as it should for a real shop; so the dialog is walked in full
 * once per address (auth.spec.ts walks it end to end), and later flows reuse that session.
 */
const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>>();

/** Signs in through the login dialog exactly as the shopkeeper does: address, then the code. */
export async function signIn(page: Page, address = OWNER) {
  const opened = sessions.get(address);
  if (opened !== undefined) {
    await page.context().addCookies(opened);
    await page.evaluate(() => localStorage.setItem("karobar.signedIn", "1"));
    await page.reload();
    await expect(page.locator("#login-dialog")).toBeHidden();
    return;
  }
  const form = page.locator("#login-form");
  await expect(page.locator("#login-dialog")).toBeVisible();
  await form.locator('[name="address"]').fill(address);
  await form.locator('button[type="submit"]').click();
  // The stand-in provider tells the developer the code in the hint, the way a real message would.
  await expect(page.locator("#login-hint")).toContainText("246810");
  await form.locator('[name="code"]').fill(DEMO_CODE);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#login-dialog")).toBeHidden();
  sessions.set(address, (await page.context().cookies()).filter((cookie) => cookie.name === "__Host-karobar_session"));
}

/** A session cookie from the two sign-in routes — for arranging data a flow needs. */
export async function apiSignIn(request: APIRequestContext, address = OWNER): Promise<string> {
  const base = baseURL();
  // The stand-in provider needs no code sent first, and asking for one would count against #350's
  // code limits; the dialog flow (signIn) asks for one as a person does.
  const answer = await request.post(`${base}/api/auth/sign-in`, { data: { address, code: DEMO_CODE } });
  const cookie = (answer.headers()["set-cookie"] ?? "").match(/__Host-karobar_session=([^;]+)/)?.[1];
  if (!answer.ok() || !cookie) throw new Error(`/api/auth/sign-in -> ${answer.status()}: ${await answer.text()}`);
  return cookie;
}

/** One JSON call on the session: GET with no body, POST with one. */
export async function apiCall(request: APIRequestContext, cookie: string, path: string, body?: Record<string, unknown>) {
  const base = baseURL();
  const reply = await request.fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      cookie: `__Host-karobar_session=${cookie}`,
      // The app refuses cross-site posts without its own origin (#349).
      origin: base,
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await reply.json()) as Record<string, any>;
  if (!reply.ok()) throw new Error(`${path} -> ${reply.status()}: ${JSON.stringify(json)}`);
  return json;
}

/** The day the app calls today — purchase and sale dates follow it. */
export const today = (request: APIRequestContext, cookie: string) =>
  apiCall(request, cookie, "/api/dashboard").then((data) => data.today as string);

/** An item in the item list, so a bill line or purchase line can find it. */
export async function addItem(request: APIRequestContext, cookie: string, name: string, price = "30") {
  const result = await apiCall(request, cookie, "/api/items", {
    name,
    kind: "goods",
    hsnSac: "34011190",
    unit: "PCS",
    taxKind: "taxable",
    ratePercentTimes100: "500",
    basis: "Browser test item",
    price,
    // Names are unique per run; the fuzzy "similar item" check is acknowledged, not dodged.
    acknowledgeSimilar: true,
  });
  return result.item.id as string;
}

/** A supplier in the supplier list, with a structurally valid invented GST number. */
export async function addSupplier(request: APIRequestContext, cookie: string, name: string) {
  const result = await apiCall(request, cookie, "/api/suppliers", {
    legalName: name,
    gstin: "29AAFCD1234K1ZN",
    registration: "regular",
    stateCode: "29",
    pincode: "560058",
    line1: "Plot 5, Peenya Industrial Area",
    city: "Bengaluru",
    acknowledgeSimilar: true,
  });
  return result.supplier.id as string;
}

/**
 * One supplier is enough for arranging stock; the app dedupes suppliers by GST number, so an
 * earlier supplier (from this suite or the seed) is reused when one is already there.
 */
export async function findOrAddSupplier(request: APIRequestContext, cookie: string, name: string) {
  const catalogue = await apiCall(request, cookie, "/api/catalogue");
  const existing = catalogue.suppliers[0];
  if (existing) return { id: existing.id as string, name: existing.name as string };
  return { id: await addSupplier(request, cookie, name), name };
}

/** The business's own address, without which the law refuses every bill (BUSINESS_ADDRESS_MISSING). */
export async function ensureBusinessDetails(request: APIRequestContext, cookie: string) {
  const current = await apiCall(request, cookie, "/api/business-details");
  if (current.details !== null) return;
  await apiCall(request, cookie, "/api/business-details", {
    legalName: current.prefill.legalName ?? "Sampoorna Traders",
    tradeName: "Sampoorna",
    address1: "No. 14, 2nd Main, Peenya Industrial Area",
    city: "Bengaluru",
    pincode: "560058",
    stateCode: "29",
    phone: "9829011223",
  });
}

/** A named customer, so a bill has somebody to be made out to. */
export async function addCustomer(request: APIRequestContext, cookie: string, name: string) {
  const result = await apiCall(request, cookie, "/api/customers", {
    legalName: name,
    registration: "unregistered",
    stateCode: "29",
    pincode: "560058",
    line1: "MG Road",
    city: "Bengaluru",
    acknowledgeSimilar: true,
  });
  return result.customer.id as string;
}

/** A recorded supplier bill — how stock and what is owed reach the books in these tests. */
export async function recordPurchase(
  request: APIRequestContext,
  cookie: string,
  input: { supplierId: string; reference: string; itemId: string; quantity: string; rate: string; gst: string },
) {
  const date = await today(request, cookie);
  return apiCall(request, cookie, "/api/purchases/record", {
    supplierId: input.supplierId,
    reference: input.reference,
    date,
    lines: JSON.stringify([
      { itemId: input.itemId, quantity: input.quantity, unit: "PCS", rate: input.rate, gst: input.gst },
    ]),
  });
}

/** Types in an item-pick box and takes the first match, as a person does. */
export async function pickItem(page: Page, scope: string, query: string) {
  const box = page.locator(`${scope} [data-item-search]`).last();
  await box.click();
  await box.fill(query);
  const list = page.locator(".item-picker-list:visible").last();
  await expect(list).not.toBeEmpty();
  await page.keyboard.press("Enter");
}
