/**
 * Issue #496 — the one thing a browser spec cannot arrange through the API: the demo shop's
 * consent to ask the transport department about a vehicle. The in-memory demo is built with it
 * already given; a real company on PostgreSQL gives it through `VehicleRecordService.grantConsent`,
 * which has no screen or route yet. So the spec writes the same row the service would, into the
 * test database that `global-setup.ts` already refuses to touch unless it is marked as one.
 */
import pg from "pg";
import { PERMITTED_VEHICLE_FIELDS } from "../../packages/transport/src/vehicle-record-types.ts";
import { testDatabaseUrl } from "./global-setup.ts";

export async function grantVehicleRecordConsent(owner = "owner@sampoorna.example.invalid", business = "Sampoorna Traders") {
  const client = new pg.Client({ connectionString: testDatabaseUrl(process.env) });
  await client.connect();
  try {
    await client.query("BEGIN");
    const company = (await client.query("SELECT id FROM companies WHERE legal_name = $1", [business])).rows[0];
    const user = (await client.query("SELECT id FROM users WHERE email = $1", [owner])).rows[0];
    if (company === undefined || user === undefined) throw new Error(`Run npm run db:seed first: no ${business} / ${owner} in the test database.`);
    await client.query("SELECT set_config('app.company_id', $1, true)", [company.id]);
    await client.query(
      `INSERT INTO vehicle_record_consents (company_id, purpose, fields, granted_by, credential_reference)
       VALUES ($1, 'TRANSPORT_SUITABILITY', $2::jsonb, $3, $4)
       ON CONFLICT (company_id, purpose) DO UPDATE SET fields = EXCLUDED.fields, revoked_at = NULL, revoked_by = NULL`,
      [company.id, JSON.stringify(PERMITTED_VEHICLE_FIELDS), user.id, `vault://vehicle/${company.id}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
