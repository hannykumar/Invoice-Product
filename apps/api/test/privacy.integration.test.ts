/**
 * Issue #352 — `PostgresAccountDataStore` + `PostgresPrivacyStore` + `PostgresBackupRepository` on
 * real PostgreSQL: export carries the tenant's rows and no other's, deletion tombstones and is
 * blocked by a legal hold, and the sealed app_records hold no plain personal data.
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
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
  const { enableDurability, DurableMap, durableEntries } = await import('../src/durable.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  enableDurability(db, encryption);
  const marker = `pan-probe-${Date.now()}`;
  new DurableMap('privacy-probe', () => SAMPOORNA).set(marker, { pan: 'ABCDE1234F', bank: '12345678901' });
  const { rows } = await db.query("SELECT value::text AS value FROM app_records WHERE company_id = $1 AND key = $2", [SAMPOORNA, marker]);
  const stored = JSON.parse(String(rows[0]?.value));
  assert.ok(isEncryptedPayload(stored), `the row is sealed: ${stored}`);
  assert.ok(!String(rows[0]?.value).includes('ABCDE1234F'), 'no plain PAN in the column');
  // And the read path opens it back.
  const reloaded = await durableEntries(SAMPOORNA);
  assert.equal(JSON.stringify(reloaded['privacy-probe']).includes('ABCDE1234F'), true);
});

test('#352: export carries the tenant\'s rows only, a legal hold blocks deletion, and deletion keeps the books', { skip }, async () => {
  const { PostgresAccountDataStore } = await import('../src/privacy-application.ts');
  const { PostgresPrivacyStore } = await import('../../../ops/security/src/postgres-store.ts');
  const { PrivacyService } = await import('../../../ops/security/src/privacy.ts');
  const { PostgresAuditLog } = await import('../../../packages/platform/src/postgres-audit.ts');
  const { appEncryption } = await import('../src/field-encryption.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  const privacy = new PrivacyService(new PostgresAuditLog(db), new PostgresAccountDataStore(db, encryption), () => new Date(), new PostgresPrivacyStore(db));
  const context = { companyId: KONKAN, userId: '00000000-0000-4000-8000-000000000004', requestId: 'probe-1' } as any;
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
  // Hold: deletion answers blocked, not erased.
  await privacy.placeLegalHold(context, KONKAN, 'assessment under way');
  const blockedKey = `del-${Date.now()}-held`;
  const heldRequest = await privacy.request(context, KONKAN, 'deletion', blockedKey);
  const blockedOutcome = await privacy.executeDeletion(context, heldRequest.id);
  assert.equal(blockedOutcome.request.status, 'blocked');
  // Release and delete: sessions and memberships go, the books stay.
  const { rows: holdRows } = await db.query('SELECT id FROM privacy_legal_holds WHERE company_id = $1', [KONKAN]);
  await privacy.releaseLegalHold(context, String((holdRows[0] as { id: string }).id), 'resolved');
  const delRequest = await privacy.request(context, KONKAN, 'deletion', `del-${Date.now()}-go`);
  const outcome = await privacy.executeDeletion(context, delRequest.id);
  assert.ok((outcome.result?.deletedRecords ?? 0) > 0, 'rows were removed');
  assert.ok((outcome.result?.retainedRecords ?? 0) > 0, 'the books were kept');
  const { rows: frozen } = await db.query("SELECT count(*)::int AS n FROM app_records WHERE company_id = $1 AND frozen = true", [KONKAN]);
  const { rows: remaining } = await db.query("SELECT count(*)::int AS n FROM app_records WHERE company_id = $1 AND value <> 'null'::jsonb", [KONKAN]);
  assert.equal((remaining[0] as { n: number }).n, (frozen[0] as { n: number }).n, 'only frozen posted rows survive');
});
