/**
 * Issue #350 — every run starts with fresh rate-limit counters, as a new day would. They are kept in
 * PostgreSQL across restarts (as they must be for a real shop), so without this a second run within
 * 15 minutes would find the owner's address out of sign-in codes.
 *
 * It deletes rows, so it fails closed, like the demo sign-in (#446): it runs only when it is told it
 * is a test — NODE_ENV=test, a DATABASE_URL given explicitly, and that database marked as a test one
 * (its name contains "test", or KAROBAR_TEST_DATABASE=1). Anything else stops the run with a reason;
 * it never guesses, and never falls back to a default database.
 */
import pg from "pg";

export const testDatabaseUrl = (env: Readonly<Record<string, string | undefined>>): string => {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() !== "test") {
    throw new Error("The browser tests clear rate-limit counters, so they run only with NODE_ENV=test.");
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set. The browser tests need their own test database, named explicitly.");
  const name = decodeURIComponent(URL.parse(url)?.pathname.replace(/^\//, "") ?? "");
  if (!/test/i.test(name) && env.KAROBAR_TEST_DATABASE !== "1") {
    throw new Error(`The database "${name}" is not marked as a test database. Use one whose name contains "test", or set KAROBAR_TEST_DATABASE=1 for a throwaway database.`);
  }
  return url;
};

export default async function globalSetup() {
  const client = new pg.Client({ connectionString: testDatabaseUrl(process.env) });
  await client.connect();
  try {
    await client.query("DELETE FROM rate_limit_counters");
  } catch (error) {
    // Not migrated yet: nothing counted, nothing to clear.
    if ((error as { code?: string }).code !== "42P01") throw error;
  } finally {
    await client.end();
  }
}
