import { defineConfig } from "@playwright/test";

/**
 * Issue #355 — the flows that must never break, driven in a real browser against the real
 * application: `npm run web` serving the same page a shopkeeper opens, keeping its books in
 * real PostgreSQL. Nothing inside the app is mocked. The only stand-ins are the ones the app
 * itself swaps in under NODE_ENV=test: the development sign-in code (#342, fail-closed so it
 * can never reach production) and the connector-v1 providers (government, bank, messaging,
 * payments).
 *
 * Migrate and seed the database first: `npm run db:migrate && npm run db:seed`.
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
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WEB_PORT: String(port),
      DATABASE_URL: databaseUrl,
    },
  },
});
