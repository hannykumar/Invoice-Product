/**
 * Issue #500 on real PostgreSQL: old plaintext frozen bill copies are sealed by the one-off (and
 * stay unchangeable afterwards), and a removed person's sign-in address can be anonymised only
 * through the audited `anonymise_user` function — never by a plain UPDATE from the app role.
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the sealing tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
const login = `invoice_app_seal_${randomBytes(6).toString('hex')}`;
const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const NO_PRIVILEGE = '42501';

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { migrate } = await import('../../../packages/platform/src/migrations.ts');
  owner = createDatabase(url);
  await migrate(owner);
  await migrate(owner); // a second run on an already-migrated database changes nothing
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login; appUrl.password = password;
  app = createDatabase(appUrl.toString());
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const company = async (): Promise<string> => {
  const id = randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Sealing Traders')", [id]);
  return id;
};
const person = async (companyIds: readonly string[], active = true): Promise<{ id: string; email: string }> => {
  const id = randomUUID(); const email = `seal-${id}@example.invalid`;
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, email]);
  for (const companyId of companyIds) {
    await app.unitOfWork(companyId, (uow) => uow.sql.query('INSERT INTO memberships (company_id, user_id, active) VALUES ($1, $2, $3)', [companyId, id, active]));
  }
  return { id, email };
};
const asCompany = <T>(companyId: string, work: (sql: { query: (s: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>) =>
  app.unitOfWork(companyId, (uow) => work(uow.sql as never));
const anonymise = (companyId: string, userId: string, actorId: string, inCompany = companyId) =>
  asCompany(inCompany, async (sql) => (await sql.query('SELECT anonymise_user($1, $2, $3, $4, $5) AS removed', [companyId, userId, actorId, 'session-1', 'test'])).rows[0]!.removed);

test('#500: old plaintext frozen rows are sealed once, unchanged otherwise, and stay frozen', { skip }, async () => {
  const { appEncryption, isEncryptedPayload, unsealJson, appRecordBoundTo } = await import('../src/field-encryption.ts');
  const { sealFrozenAppRecords } = await import('../src/seal-frozen-records.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  const companyId = await company(); const other = await company();
  const plain = { pan: 'ABCDE1234F', total: '1180.00' };
  // Written as a pre-#352 row was: plaintext and frozen (the trigger only refuses UPDATE and DELETE).
  for (const id of [companyId, other]) {
    await asCompany(id, (sql) => sql.query("INSERT INTO app_records (company_id, kind, key, value, frozen) VALUES ($1, 'bill_print', 'INV-1', $2::jsonb, true), ($1, 'bill_print', 'INV-TOMB', 'null'::jsonb, true)", [id, JSON.stringify(plain)]));
  }
  const before = (await owner.query("SELECT kind, key, frozen, created_at, updated_at FROM app_records WHERE company_id = $1 ORDER BY key", [companyId])).rows;

  await assert.rejects(asCompany(companyId, (sql) => sql.query("UPDATE app_records SET value = '{}'::jsonb WHERE company_id = $1", [companyId])), /cannot be changed or removed/, 'the app role cannot touch a frozen row');
  await assert.rejects(sealFrozenAppRecords(owner, encryption, { apply: true }), /name of the person who approved/);

  const preview = await sealFrozenAppRecords(owner, encryption, { apply: false });
  assert.equal(preview.mode, 'preview');
  assert.ok(preview.perCompany[companyId] === 1 && preview.perCompany[other] === 1);
  const stillPlain = (await owner.query("SELECT value FROM app_records WHERE company_id = $1 AND key = 'INV-1'", [companyId])).rows[0]!.value;
  assert.deepEqual(stillPlain, plain, 'a preview writes nothing');

  const applied = await sealFrozenAppRecords(owner, encryption, { apply: true, approvedBy: 'Synthetic Owner' });
  assert.equal(applied.mode, 'applied'); assert.equal(applied.approvedBy, 'Synthetic Owner');
  assert.ok(applied.total >= 2);
  const sealed = (await owner.query("SELECT value, value::text AS text FROM app_records WHERE company_id = $1 AND key = 'INV-1'", [companyId])).rows[0]!;
  assert.ok(isEncryptedPayload(sealed.value)); assert.ok(!String(sealed.text).includes('ABCDE1234F'));
  assert.deepEqual(await unsealJson(encryption, sealed.value, appRecordBoundTo(companyId, 'bill_print', 'INV-1')), plain);
  await assert.rejects(unsealJson(encryption, sealed.value, appRecordBoundTo(other, 'bill_print', 'INV-1')), () => true, 'a copy cannot be moved to another company');
  const after = (await owner.query("SELECT kind, key, frozen, created_at, updated_at FROM app_records WHERE company_id = $1 ORDER BY key", [companyId])).rows;
  assert.deepEqual(after, before, 'no row was added or removed and no date, key or frozen flag changed');
  assert.equal((await owner.query("SELECT value FROM app_records WHERE company_id = $1 AND key = 'INV-TOMB'", [companyId])).rows[0]!.value, null);

  assert.equal((await sealFrozenAppRecords(owner, encryption, { apply: true, approvedBy: 'Synthetic Owner' })).perCompany[companyId], undefined, 'a second run finds nothing');
  await assert.rejects(asCompany(companyId, (sql) => sql.query("UPDATE app_records SET value = '{}'::jsonb WHERE company_id = $1", [companyId])), /cannot be changed or removed/, 'the freeze is back on');
  await assert.rejects(owner.query("UPDATE app_records SET value = '{}'::jsonb WHERE company_id = $1 AND key = 'INV-1'", [companyId]), () => true, 'and so is the owner\'s');
  // The app role sees only its own company's copies.
  const seen = await asCompany(companyId, (sql) => sql.query('SELECT DISTINCT company_id FROM app_records'));
  assert.deepEqual(seen.rows.map((r) => r.company_id), [companyId]);
});

test('#500: a plain UPDATE of a sign-in address is refused; only anonymise_user changes it, once, with an audit row', { skip }, async () => {
  const companyId = await company();
  const actor = await person([companyId]); const leaver = await person([companyId]);
  await assert.rejects(app.query("UPDATE users SET email = 'x@example.invalid' WHERE id = $1", [leaver.id]), refused(NO_PRIVILEGE));
  await assert.rejects(app.query('SELECT anonymise_user($1, $2, $3, $4, $5)', [companyId, leaver.id, actor.id, 's', 'r']), refused(NO_PRIVILEGE), 'no company context, no removal');

  assert.equal(await anonymise(companyId, leaver.id, actor.id), true);
  const row = (await owner.query('SELECT email, phone, display_name, active FROM users WHERE id = $1', [leaver.id])).rows[0]!;
  assert.equal(row.email, `removed-${leaver.id}@anonymised.invalid`); assert.equal(row.active, false); assert.equal(row.phone, null);
  const audits = (await owner.query("SELECT actor_id, before_json, after_json::text AS after, reason FROM audit_events WHERE company_id = $1 AND action = 'privacy.sign_in_address_removed'", [companyId])).rows;
  assert.equal(audits.length, 1); assert.equal(audits[0]!.actor_id, actor.id); assert.equal(audits[0]!.before_json, null);
  assert.ok(!JSON.stringify(audits).includes(leaver.email), 'the audit row never carries the old address');
  assert.equal(await anonymise(companyId, leaver.id, actor.id), true, 'a repeat is a no-op');
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE company_id = $1 AND action = 'privacy.sign_in_address_removed'", [companyId])).rows[0]!.n, 1);
  await assert.rejects(app.query("UPDATE audit_events SET reason = 'x' WHERE company_id = $1", [companyId]), refused(NO_PRIVILEGE));
});

test('#500: anonymise_user refuses other companies, strangers and people who still belong elsewhere', { skip }, async () => {
  const mine = await company(); const theirs = await company();
  const actor = await person([mine]); const stranger = await person([theirs]); const shared = await person([mine, theirs]);
  const outsider = await person([theirs]);
  await assert.rejects(anonymise(mine, stranger.id, actor.id), refused(NO_PRIVILEGE), 'not a member of this company');
  await assert.rejects(anonymise(theirs, outsider.id, actor.id, theirs), refused(NO_PRIVILEGE), 'the requester must belong to the company');
  await assert.rejects(anonymise(theirs, outsider.id, outsider.id, mine), refused(NO_PRIVILEGE), 'the company named must be the caller\'s own');
  assert.equal(await anonymise(mine, shared.id, actor.id), false, 'still a member of another business: address kept');
  const kept = (await owner.query('SELECT email, active FROM users WHERE id = ANY($1)', [[stranger.id, shared.id]])).rows;
  assert.ok(kept.every((r) => String(r.email).startsWith('seal-') && r.active === true));
  const left = await person([mine], false);
  assert.equal(await anonymise(mine, left.id, actor.id), true, 'an inactive member of only this company is removable');
});
