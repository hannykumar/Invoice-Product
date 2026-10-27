import { defineConfig } from "@playwright/test";

/**
 * Issue #355 — the flows that must never break, driven in a real browser against the real
 * application: `npm run web` serving the same page a shopkeeper opens, keeping its books in
 * real PostgreSQL. Nothing inside the app is mocked. The only stand-ins are the ones the app
 * itself swaps in under NODE_ENV=test: the development sign-in code (#342, fail-closed so it
 * can never reach production) and the connector-v1 providers (government, bank, messaging,
 * payments).
 *
 * `npm run test:browser:pg` (#494) is the way to run it: a fresh, migrated and seeded database for the
 * run, the server on a least-privilege login so row-level security applies, dropped afterwards.
 * `npm run test:browser` alone runs against a database you migrated and seeded yourself
 * (`npm run db:migrate && npm run db:seed`).
 * Run it with NODE_ENV=test and a test database (its name contains "test", or KAROBAR_TEST_DATABASE=1):
 * the setup clears its rate-limit counters (#350) and refuses any other database.
 */
const port = Number(process.env.WEB_PORT ?? process.env.PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://invoice:invoice@localhost:5432/invoice";

export default defineConfig({
  testDir: "./tests/browser",
  // #350: rate-limit counters start fresh each run (they live in PostgreSQL, across restarts).
  globalSetup: "./tests/browser/global-setup.ts",
  // One shared demo company in one database. The flows run in sequence; each leaves records
  // behind that the others must tolerate, the way the shop's own books accumulate.
  workers: 1,
  fullyParallel: false,
  // Zero retries on purpose: a flaky flow is a finding to file, not a failure to hide.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run web",
    url: baseURL,
    // Never on a fresh-database run (#494): a server already on the port would be on some other database.
    reuseExistingServer: !process.env.CI && !process.env.KAROBAR_FRESH_DATABASE,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WEB_PORT: String(port),
      DATABASE_URL: databaseUrl,
    },
  },
});
