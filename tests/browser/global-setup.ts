/**
 * Issue #350 — every run starts with fresh rate-limit counters, as a new day would. They are kept in
 * PostgreSQL across restarts (as they must be for a real shop), so without this a second run within
 * 15 minutes would find the owner's address out of sign-in codes. Test databases only.
 */
import pg from "pg";

export default async function globalSetup() {
  if (!["test", "development"].includes((process.env.NODE_ENV ?? "test").trim().toLowerCase())) return;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://invoice:invoice@localhost:5432/invoice" });
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
