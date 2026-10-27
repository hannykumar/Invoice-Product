/**
 * Issue #494 — what only a real PostgreSQL can prove, driven through the browser and the web server's
 * own API. These do not run on the in-memory store, and they refuse to pass if the server is on it:
 *
 *  1. a bill made through the app is a balanced row in the database (the server is not in memory);
 *  2. the web server is killed outright and started again on the same database: the bill, the
 *     customer, the signed-in session and the next bill number are all still there, in the browser;
 *  3. company B, signed in through the browser, cannot see company A's bill — not on screen, not by
 *     asking the API for it by id (row-level security answers as if it did not exist).
 *
 * Run it with `npm run test:browser:pg`, which sets up the database and the owner's address below.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import pg from "pg";
import { DEMO_CODE, unique } from "./helpers.ts";

const SAMPOORNA = "owner@sampoorna.example.invalid";
const KONKAN = "owner@konkan.example.invalid";
const SAMPOORNA_ID = "00000000-0000-4000-8000-000000000001";
const KONKAN_ID = "00000000-0000-4000-8000-000000000011";
const SESSION = "__Host-karobar_session";
const WEB_SERVER = fileURLToPath(new URL("../../apps/web/server.ts", import.meta.url));

/** The owner's connection: it reads past row-level security, to look at what the app wrote. */
const ownerUrl = process.env.KAROBAR_OWNER_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
let owner: pg.Client;

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error("DATABASE_URL is not set: these tests need PostgreSQL. Run `npm run test:browser:pg`.");
  owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  // Loud, not skipped: a database that was never migrated is not one these tests may pass on.
  const migrated = await owner.query("SELECT count(*)::int AS n FROM schema_migrations");
  if (migrated.rows[0].n === 0) throw new Error("The database has no migrations applied. Run `npm run test:browser:pg`.");
});
test.afterAll(async () => { await owner?.end(); });

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
  });
});

/** The real `npm run web` entry on its own port and the same database as the suite's server. */
async function startWeb(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--experimental-strip-types", WEB_SERVER], {
    env: { ...process.env, NODE_ENV: "test", WEB_PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const until = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return child; } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`The web server exited with ${child.exitCode} before it listened.`);
    if (Date.now() > until) { child.kill("SIGKILL"); throw new Error("The web server did not start in 90 seconds."); }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Kills it outright, as a crash or a lost machine would: no shutdown code runs. */
async function crash(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

const call = async (request: APIRequestContext, base: string, token: string | undefined, path: string, body?: Record<string, unknown>) => {
  const reply = await request.fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: base, ...(token ? { cookie: `${SESSION}=${token}` } : {}) },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: reply.status(), json: (await reply.json()) as Record<string, any> };
};

const signInOver = async (request: APIRequestContext, base: string, address: string, companyId: string): Promise<string> => {
  const reply = await request.post(`${base}/api/auth/sign-in`, { headers: { origin: base }, data: { address, code: DEMO_CODE, companyId } });
  const token = (reply.headers()["set-cookie"] ?? "").match(new RegExp(`${SESSION}=([^;]+)`))?.[1];
  if (!reply.ok() || !token) throw new Error(`/api/auth/sign-in -> ${reply.status()}: ${await reply.text()}`);
  return token;
};

/**
 * Gives a browser the session that an API sign-in made. The login dialog is walked in full by auth.spec.ts;
 * asking for more codes here would spend the run's allowance of five from one address (#350).
 */
async function openSession(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([{ name: SESSION, value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  await context.addInitScript(() => localStorage.setItem("karobar.signedIn", "1"));
}

/** A customer, a service and one bill of 2 × ₹500 (+18% GST), made through the app's own routes. */
async function makeBill(request: APIRequestContext, base: string, token: string, label: string) {
  const details = await call(request, base, token, "/api/business-details");
  if (details.json.details === null) {
    const saved = await call(request, base, token, "/api/business-details", { legalName: "Sampoorna Traders", address1: "Plot 14, 2nd Phase, Peenya Industrial Area", city: "Bengaluru", pincode: "560058", stateCode: "29" });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  }
  const customerName = `Lakshmi Stores ${label}`;
  const customer = await call(request, base, token, "/api/customers", { name: customerName, registration: "unregistered", stateCode: "29", pincode: "560058", city: "Bengaluru", address1: "12 MG Road", acknowledgeSimilar: true });
  expect(customer.status, JSON.stringify(customer.json)).toBe(200);
  const item = await call(request, base, token, "/api/items", { name: `Repair visit ${label}`, hsn: "998729", unit: "NOS", price: "500", kind: "service", ratePercent: "18", basis: "Rate this business charges", effectiveFrom: "2026-04-01", acknowledgeSimilar: true });
  expect(item.status, JSON.stringify(item.json)).toBe(200);
  const sale = { customerId: customer.json.customer.id, itemId: item.json.item.id, rate: "500", date: "2026-10-16", terms: "0" };
  const first = await call(request, base, token, "/api/sales/record", { ...sale, quantity: "2", reference: `pg-${label}-1`, requestId: `pg-${label}-1` });
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  return { customerName, sale, id: String(first.json.invoice.id), number: String(first.json.invoice.number) };
}

test("a bill made through the app is a balanced row in PostgreSQL, so the server is not on the in-memory store (#494)", async ({ request, baseURL }) => {
  const token = await signInOver(request, baseURL!, SAMPOORNA, SAMPOORNA_ID);
  const bill = await makeBill(request, baseURL!, token, unique("row"));
  const rows = (await owner.query(
    `SELECT i.state, i.invoice_value_paise::text AS value,
            (SELECT sum(debit_minor) - sum(credit_minor) FROM journal_line j WHERE j.voucher_id = i.voucher_id)::text AS imbalance
       FROM sales_invoices i WHERE i.company_id = $1 AND i.number = $2`, [SAMPOORNA_ID, bill.number])).rows;
  expect(rows, "the bill must be in the database the suite was given; if this fails the server is not using it").toHaveLength(1);
  expect(rows[0]).toEqual({ state: "FINAL", value: "118000", imbalance: "0" });
});

test("after the web server is killed and started again, the bill, the customer and the sign-in are still there (#494)", async ({ browser, request }) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined = await startWeb(port);
  try {
    const label = unique("restart");
    const token = await signInOver(request, base, SAMPOORNA, SAMPOORNA_ID);
    const context = await browser.newContext({ baseURL: base });
    await openSession(context, token);
    const page = await context.newPage();
    await page.goto("/#dashboard");
    await expect(page.locator("#login-dialog")).toBeHidden();
    const bill = await makeBill(request, base, token, label);

    await crash(server);
    server = await startWeb(port);

    // The same page, the same session: it lived in the database, not in the process that died.
    // A reload, not just a new address: the page asks the restarted server for everything again.
    await page.goto("/#dashboard");
    await page.reload();
    await expect(page.locator("#login-dialog")).toBeHidden();
    await expect(page.locator("body")).toContainText(bill.customerName, { timeout: 20_000 });

    // The frozen print copy of the bill and the next bill number came back with it.
    expect((await call(request, base, token, `/api/sales/${bill.id}/preview`)).status).toBe(200);
    const second = await call(request, base, token, "/api/sales/record", { ...bill.sale, quantity: "1", reference: `pg-${label}-2`, requestId: `pg-${label}-2` });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(Number(String(second.json.invoice.number).slice(-6))).toBeGreaterThan(Number(bill.number.slice(-6)));
    await context.close();
  } finally {
    await crash(server);
  }
});

test("company B, signed in through the browser, cannot see company A's bill on screen or by its id (#494)", async ({ page, request, baseURL }) => {
  const sampoornaToken = await signInOver(request, baseURL!, SAMPOORNA, SAMPOORNA_ID);
  const bill = await makeBill(request, baseURL!, sampoornaToken, unique("private"));
  // Company A really can see it: the check below would pass trivially if the bill had not been made.
  expect((await call(request, baseURL!, sampoornaToken, `/api/sales/${bill.id}/preview`)).status).toBe(200);

  const konkanToken = await signInOver(request, baseURL!, KONKAN, KONKAN_ID);
  await openSession(page.context(), konkanToken);
  await page.goto("/#dashboard");
  await expect(page.locator("#login-dialog")).toBeHidden();
  await expect(page.locator("#view-dashboard")).toBeVisible();
  // Give the dashboard its time to draw before asserting something is absent.
  await expect(page.locator("#view-dashboard")).not.toContainText("Loading", { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText(bill.customerName);
  await expect(page.locator("body")).not.toContainText(bill.number);

  // And straight at the API, with company B's own session cookie from the browser.
  const cookie = (await page.context().cookies()).find((c) => c.name === SESSION)?.value;
  expect(cookie, "the browser holds company B's session").toBe(konkanToken);
  const stolen = await call(request, baseURL!, cookie, `/api/sales/${bill.id}/preview`);
  expect(stolen.status).toBe(404);
  const catalogue = await call(request, baseURL!, cookie, "/api/catalogue");
  expect(JSON.stringify(catalogue.json)).not.toContain(bill.customerName);
});
