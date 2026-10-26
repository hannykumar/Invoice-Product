/**
 * Issue #352 — the privacy routes over the running application: the owner exports the account's
 * data, asks for deletion, is told plainly what stays and why, and a legal hold stops deletion.
 * A viewer is refused (the generated #280 tests cover every POST for her).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { apiRuntime } from '../src/runtime.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

const COMPANY = '00000000-0000-4000-8000-000000000001';
const post = (path: string, session: string, body: Record<string, unknown> = {}) =>
  handleApi('POST', path, body, `Bearer ${session}`).then((r) => ({ status: r.status, body: JSON.parse(String(r.body)) as Record<string, any> }));

test('#352: the owner exports everything the account holds, and the reply keeps its request id', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', COMPANY);
  const key = `export-${Date.now()}`;
  const first = await post('/api/privacy/export', owner, { requestId: key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.export !== undefined, 'the export came back');
  assert.equal(first.body.export.subjectId, COMPANY);
  assert.ok(Object.keys(first.body.export.data?.app ?? {}).length > 0, 'the account\'s records are in the export');
  // A retry with the same key replays the settled request instead of doing it again.
  const again = await post('/api/privacy/export', owner, { requestId: key });
  assert.equal(again.status, 200);
  assert.equal(again.body.request.id, first.body.request.id);
  assert.equal(again.body.export, undefined, 'the replay answers with the request, not a second export');
});

test('#352: a legal hold stops deletion and says so, releasing it lets deletion through, and the kept note is plain', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', COMPANY);
  const held = await post('/api/privacy/legal-holds', owner, { reason: 'GST notice period' });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const blocked = await post('/api/privacy/deletion', owner, { requestId: `del-${Date.now()}-a` });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.request.status, 'blocked', JSON.stringify(blocked.body));
  const released = await post(`/api/privacy/legal-holds/${held.body.hold.id}/release`, owner, { reason: 'notice answered' });
  assert.equal(released.status, 200);
  const gone = await post('/api/privacy/deletion', owner, { requestId: `del-${Date.now()}-b` });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.ok(gone.body.deletedRecords > 0, 'records were removed');
  assert.ok(Array.isArray(gone.body.kept) && gone.body.kept.length > 0, 'the reply says what stays and why');
  assert.match(gone.body.kept.join(' '), /section 36|GST|eight years/i);
});

test('#352: field sealing round-trips and refuses a ciphertext moved to a different row', async () => {
  const { appEncryption, sealJson, unsealJson, sealMasterData, unsealMasterData, isEncryptedPayload, APP_FIELD_KEY_ID } = await import('../src/field-encryption.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  const sealed = await sealJson(encryption, APP_FIELD_KEY_ID, '{"pan":"ABCDE1234F"}', 'app-records/co/kind/key');
  assert.ok(isEncryptedPayload(sealed));
  assert.equal(sealed.algorithm, 'aes-256-gcm');
  assert.deepEqual(await unsealJson(encryption, sealed, 'app-records/co/kind/key'), { pan: 'ABCDE1234F' });
  // The same ciphertext under a different row's binding cannot be opened.
  await assert.rejects(unsealJson(encryption, sealed, 'app-records/co/kind/other'));
  const master = await sealMasterData(encryption, { id: 'p1', companyId: 'co', pan: 'ABCDE1234F', name: 'Rao' } as any, 'master-versions/co/party');
  assert.equal(master.id, 'p1');
  assert.ok(isEncryptedPayload(master.__sealed));
  assert.deepEqual(await unsealMasterData(encryption, master, 'master-versions/co/party'), { id: 'p1', companyId: 'co', pan: 'ABCDE1234F', name: 'Rao' });
});

test('#352: a master with bigint money seals and reopens, and a production server without keys fails closed', async () => {
  const { appEncryption, sealMasterData, unsealMasterData } = await import('../src/field-encryption.ts');
  const encryption = appEncryption({ NODE_ENV: 'test' });
  // Masters carry bigint paise; plain JSON.stringify would throw before the seal even starts.
  const master = await sealMasterData(encryption, { id: 'p2', companyId: 'co', creditLimitPaise: 10000n } as any, 'master-versions/co/party');
  assert.deepEqual(await unsealMasterData(encryption, master, 'master-versions/co/party'), { id: 'p2', companyId: 'co', creditLimitPaise: 10000n });
  assert.throws(() => appEncryption({ NODE_ENV: 'production' }), /APP_ENCRYPTION_KEYS/);
  assert.throws(() => appEncryption({ NODE_ENV: 'production', APP_ENCRYPTION_KEYS: 'bad' }), /32-byte/);
});

test('#352: an account scrub skips the frozen copies of issued documents', async () => {
  const { DurableMap, scrubDurableRecords } = await import('../src/durable.ts');
  const open = new DurableMap<{ note: string }>(`test_open_${Date.now()}`, () => 'co-1');
  const frozen = new DurableMap<{ note: string }>(`test_frozen_${Date.now()}`, () => 'co-1', { frozen: true });
  open.set('k1', { note: 'mutable' });
  frozen.set('print-1', { note: 'issued copy' });
  assert.equal(scrubDurableRecords('co-1'), 1);
  assert.equal(open.has('k1'), false, 'the mutable record went');
  assert.equal(frozen.get('print-1')?.note, 'issued copy', 'the issued copy stayed — the law keeps it');
});

test('#352: a privacy record cannot be placed for somebody else', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', COMPANY);
  const forged = await post('/api/privacy/consents', owner, { subjectId: 'someone-else', noticeVersion: 'v1', decision: 'granted' });
  assert.equal(forged.status, 422, JSON.stringify(forged.body));
  const held = await post('/api/privacy/legal-holds', owner, { subjectId: 'someone-else', reason: 'x' });
  assert.equal(held.status, 422, JSON.stringify(held.body));
});

