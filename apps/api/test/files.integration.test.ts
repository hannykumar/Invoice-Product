/**
 * Issue #341 — `stored_files` on PostgreSQL, as the application's own role: one company never sees
 * another's file, and a file's record is screened once and never changed after.
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the file storage tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SAMPOORNA_OWNER = '00000000-0000-4000-8000-000000000003';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const login = `invoice_app_files_${randomBytes(6).toString('hex')}`;
let owner: TransactionalExecutor;
let app: TransactionalExecutor;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { migrate } = await import('../../../packages/platform/src/migrations.ts');
  const { seed } = await import('../../../packages/platform/src/seed.ts');
  owner = createDatabase(url);
  await migrate(owner);
  await seed(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
});

after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

test('a stored file is its company\'s alone, screened once, never deleted, and kept under its own company\'s key', { skip }, async () => {
  const id = randomUUID();
  const key = `${SAMPOORNA}/purchase_bill/${id}`;
  await app.unitOfWork(SAMPOORNA, ({ sql }) => sql.query(
    `INSERT INTO stored_files (id, company_id, purpose, object_key, file_name, declared_type, declared_bytes, state, uploaded_by)
     VALUES ($1, $2, 'purchase_bill', $3, 'bill.pdf', 'application/pdf', 100, 'pending', $4)`, [id, SAMPOORNA, key, SAMPOORNA_OWNER]));
  // Another company: not there, even by id.
  assert.equal((await app.tenantTransaction(KONKAN, (sql) => sql.query('SELECT id FROM stored_files WHERE id = $1', [id]))).rows.length, 0);
  // A key under another company's prefix is refused by the table itself.
  await assert.rejects(app.unitOfWork(SAMPOORNA, ({ sql }) => sql.query(
    `INSERT INTO stored_files (id, company_id, purpose, object_key, file_name, declared_type, declared_bytes, state, uploaded_by)
     VALUES ($1, $2, 'purchase_bill', $3, 'bill.pdf', 'application/pdf', 100, 'pending', $4)`, [randomUUID(), SAMPOORNA, `${KONKAN}/purchase_bill/${randomUUID()}`, SAMPOORNA_OWNER])), /check constraint/);
  // Screened once: pending to available; after that the record does not change, and is never deleted.
  await app.unitOfWork(SAMPOORNA, ({ sql }) => sql.query("UPDATE stored_files SET state = 'available', detected_type = 'pdf', size_bytes = 100 WHERE id = $1", [id]));
  await assert.rejects(app.unitOfWork(SAMPOORNA, ({ sql }) => sql.query("UPDATE stored_files SET state = 'quarantined', quarantine_reason = 'X' WHERE id = $1", [id])), /screened once/);
  await assert.rejects(app.unitOfWork(SAMPOORNA, ({ sql }) => sql.query('DELETE FROM stored_files WHERE id = $1', [id])), /permission denied/);
});
