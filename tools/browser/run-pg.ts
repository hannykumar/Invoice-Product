/**
 * Issue #494 — the browser suite on a database of its own.
 *
 * `npm run test:browser:pg` takes DATABASE_URL (a PostgreSQL login that may create databases — the
 * `invoice` login from compose.yaml is one), makes a brand-new database beside it, migrates and seeds
 * it, makes a login that is only a member of `invoice_app` (so row-level security applies to the
 * server exactly as in production), runs the Playwright suite against the real web server on that
 * login, and drops everything afterwards, pass or fail. Two runs never share a row.
 *
 * It never falls back to the in-memory store: no DATABASE_URL means no run, with the way to get one.
 * Extra arguments go to Playwright: `npm run test:browser:pg -- tests/browser/bill.spec.ts`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { appDatabase, freePort } from "../../apps/api/test/processes.ts";

const adminUrl = process.env.DATABASE_URL?.trim();
if (!adminUrl) {
  console.error([
    "DATABASE_URL is not set, so there is no PostgreSQL to run the browser tests on.",
    "The browser tests never use the in-memory store. To start the database from compose.yaml:",
    "  docker compose up -d --wait db",
    "  export DATABASE_URL=postgresql://invoice:invoice@localhost:5432/invoice",
    "  npm run test:browser:pg",
  ].join("\n"));
  process.exit(2);
}

const name = `karobar_browser_test_${randomBytes(6).toString("hex")}`;
const withDatabase = (url: string, database: string): string => {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
};

const admin = new pg.Client({ connectionString: adminUrl });
try {
  await admin.connect();
} catch (error) {
  console.error(`Could not reach PostgreSQL at DATABASE_URL (${(error as Error).message}).\nIs the database up? docker compose up -d --wait db`);
  process.exit(2);
}

let exitCode = 1;
let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  const ownerUrl = withDatabase(adminUrl, name);
  database = await appDatabase(ownerUrl); // migrate + seed as the owner, then the invoice_app login
  const port = await freePort();
  console.log(`Browser tests on a fresh PostgreSQL database "${name}" (migrated, seeded), web server on port ${port}.`);
  const run = spawn("npx", ["playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: database.appUrl,
      KAROBAR_OWNER_DATABASE_URL: ownerUrl,
      KAROBAR_TEST_DATABASE: "1",
      KAROBAR_FRESH_DATABASE: "1",
      WEB_PORT: String(port),
    },
  });
  const stop = () => run.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  exitCode = await new Promise<number>((resolve) => run.once("exit", (code) => resolve(code ?? 1)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await database?.close().catch(() => undefined); // drops the invoice_app login
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((error) => console.error(`Could not drop "${name}": ${(error as Error).message}`));
  await admin.end();
}
process.exit(exitCode);
