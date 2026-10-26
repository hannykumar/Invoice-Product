/**
 * Issue #352 — `PostgresAccountDataStore` + `PostgresPrivacyStore` + `PostgresBackupRepository` on
 * real PostgreSQL: export carries the tenant's rows and no other's, deletion tombstones and is
 * blocked by a legal hold, and the sealed app_records hold no plain personal data.
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the privacy tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
let db: TransactionalExecutor;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { migrate } = await import('../../../packages/platform/src/migrations.ts');
  const { seed } = await import('../../../packages/platform/src/seed.ts');
  db = createDatabase(url);
  await migrate(db);
  await seed(db);
});

after(async () => { await db?.close(); });

test('#352: app_records rows written through the durable map are sealed, and no dump shows a PAN', { skip }, async () => {
  const { appEncryption, isEncryptedPayload } = await import('../src/field-encryption.ts');
  const { enableDurability, DurableMap, durableEntries, asOneAction } = await import('../src/durable.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  enableDurability(db, encryption);
  const marker = `pan_probe_${Date.now()}`;
  await asOneAction(db, SAMPOORNA, async () => { new DurableMap('privacy_probe', () => SAMPOORNA).set(marker, { pan: 'ABCDE1234F', bank: '12345678901' }); });
  const { rows } = await db.query("SELECT value::text AS value FROM app_records WHERE company_id = $1 AND key = $2", [SAMPOORNA, marker]);
  const stored = JSON.parse(String(rows[0]?.value));
  assert.ok(isEncryptedPayload(stored), `the row is sealed: ${stored}`);
  assert.ok(!String(rows[0]?.value).includes('ABCDE1234F'), 'no plain PAN in the column');
  // And the read path opens it back.
  const reloaded = await durableEntries(SAMPOORNA);
  assert.equal(JSON.stringify(reloaded['privacy_probe']).includes('ABCDE1234F'), true);
});

test('#352: export carries the tenant\'s rows only, a legal hold blocks deletion, and deletion keeps the books', { skip }, async () => {
  const { PostgresAccountDataStore } = await import('../src/privacy-application.ts');
  const { PostgresPrivacyStore } = await import('../../../ops/security/src/postgres-store.ts');
  const { PrivacyService } = await import('../../../ops/security/src/privacy.ts');
  const { PostgresAuditLog } = await import('../../../packages/platform/src/postgres-audit.ts');
  const { appEncryption } = await import('../src/field-encryption.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  const privacy = new PrivacyService(new PostgresAuditLog(db), new PostgresAccountDataStore(db, encryption), () => new Date(), new PostgresPrivacyStore(db));
  const context = { companyId: KONKAN, actorId: '00000000-0000-4000-8000-000000000013', requestId: 'probe-1', permissions: new Set(['privacy.manage', 'privacy.export', 'privacy.delete']) } as any;
  // Export: the company's own rows, never the other tenant's.
  const request = await privacy.request(context, KONKAN, 'export', `exp-${Date.now()}`);
  const exported = await privacy.executeExport(context, request.id);
  const tables = exported.data as Record<string, unknown[]>;
  assert.equal(exported.subjectId, KONKAN);
  for (const [table, rows] of Object.entries(tables)) {
    if (table === 'companies') continue;
    for (const row of rows) if (row && typeof row === 'object' && 'company_id' in row) assert.equal((row as { company_id: string }).company_id, KONKAN, `${table} leaked another tenant`);
  }
  assert.ok(Object.keys(tables).length > 5, 'the dump covers the tenant tables');
  // Deletion runs against a company made for the test, so the seeded companies stay signed-in-able.
  const probe = randomUUID();
  const probeUser = randomUUID();
  await db.query('INSERT INTO companies (id, legal_name) VALUES ($1, $2)', [probe, 'Probe Traders']);
  await db.query('INSERT INTO users (id, email, display_name, active) VALUES ($1, $2, $3, true)', [probeUser, 'probe@probe.example.invalid', 'Probe Owner']);
  await db.query("INSERT INTO memberships (company_id, user_id, permissions, active) VALUES ($1, $2, '[]'::jsonb, true)", [probe, probeUser]);
  await db.query("INSERT INTO app_records (company_id, kind, key, value) VALUES ($1, 'privacy_probe', 'probe', '\"x\"'::jsonb)", [probe]);
  const probeContext = { companyId: probe, actorId: probeUser, requestId: 'probe-2', permissions: context.permissions } as any;
  // Hold: deletion answers blocked, not erased.
  await privacy.placeLegalHold(probeContext, probe, 'assessment under way');
  const heldRequest = await privacy.request(probeContext, probe, 'deletion', `del-${Date.now()}-held`);
  const blockedOutcome = await privacy.executeDeletion(probeContext, heldRequest.id);
  assert.equal(blockedOutcome.request.status, 'blocked');
  // Release and delete: the account's access goes, its register and audit stay.
  const { rows: holdRows } = await db.query('SELECT id FROM privacy_legal_holds WHERE company_id = $1', [probe]);
  await privacy.releaseLegalHold(probeContext, String((holdRows[0] as { id: string }).id), 'resolved');
  const delRequest = await privacy.request(probeContext, probe, 'deletion', `del-${Date.now()}-go`);
  const outcome = await privacy.executeDeletion(probeContext, delRequest.id);
  assert.ok((outcome.result?.deletedRecords ?? 0) >= 3, `app record + membership + user removed: ${JSON.stringify(outcome.result)}`);
  assert.ok((outcome.result?.retainedRecords ?? 0) > 0, 'the audit trail and register are kept');
  const { rows: alive } = await db.query("SELECT count(*)::int AS n FROM app_records WHERE company_id = $1 AND value <> 'null'::jsonb", [probe]);
  assert.equal((alive[0] as { n: number }).n, 0, 'every unfrozen record is tombstoned');
  const { rows: member } = await db.query('SELECT count(*)::int AS n FROM memberships WHERE company_id = $1 AND active = true', [probe]);
  assert.equal((member[0] as { n: number }).n, 0, 'nobody can sign in to the removed account');
});
