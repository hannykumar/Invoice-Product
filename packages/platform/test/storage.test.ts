/** Issue #341 — the two storage adapters: signed addresses that allow exactly one thing, briefly. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalObjectStore, presignS3, SpacesObjectStore } from '../src/storage.ts';

const KEY = '00000000-0000-4000-8000-000000000001/purchase_bill/11111111-2222-4333-8444-555555555555';

test('the S3 signature is the one AWS publishes for its pre-signed URL example', () => {
  // docs.aws.amazon.com, "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", GET example.
  const url = presignS3({
    endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'examplebucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: () => new Date('2013-05-24T00:00:00Z'),
  }, { method: 'GET', key: 'test.txt', expiresInSeconds: 86400 });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(new URL(url).host, 'examplebucket.s3.amazonaws.com');
});

test('a Spaces upload address signs its content type and keeps the object private; a download is an attachment', async () => {
  const spaces = new SpacesObjectStore({ endpoint: 'https://blr1.digitaloceanspaces.com', region: 'blr1', bucket: 'karobar-files', accessKeyId: 'DO00EXAMPLE', secretAccessKey: 'example-secret', now: () => new Date('2026-10-22T10:00:00Z') });
  const up = await spaces.presignUpload(KEY, { contentType: 'application/pdf', expiresInSeconds: 300 });
  const signed = new URL(up.url);
  assert.equal(signed.host, 'karobar-files.blr1.digitaloceanspaces.com');
  assert.equal(signed.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host;x-amz-acl');
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '300');
  assert.deepEqual(up.headers, { 'content-type': 'application/pdf', 'x-amz-acl': 'private' });
  const down = new URL((await spaces.presignDownload(KEY, { fileName: 'bill "482".pdf', expiresInSeconds: 60 })).url);
  assert.equal(down.searchParams.get('response-content-disposition'), 'attachment; filename="bill _482_.pdf"');
  await assert.rejects(spaces.presignUpload('../another-company/x', { contentType: 'application/pdf', expiresInSeconds: 60 }), /STORAGE_KEY_INVALID/);
});

test('a local address allows its one method, type and file, until it expires', async () => {
  let now = Date.parse('2026-10-22T10:00:00Z');
  const local = new LocalObjectStore({ dir: await mkdtemp(join(tmpdir(), 'karobar-store-')), baseUrl: '/blob', now: () => now });
  const token = (url: string) => new URL(url, 'http://x').searchParams.get('token')!;
  const up = token((await local.presignUpload(KEY, { contentType: 'image/png', expiresInSeconds: 300 })).url);
  const bytes = Buffer.from('png bytes');
  assert.equal((await local.accept(up, { method: 'GET', contentType: '', body: Buffer.alloc(0), maxBytes: 100 })).status, 403, 'not for reading');
  assert.equal((await local.accept(up, { method: 'PUT', contentType: 'application/pdf', body: bytes, maxBytes: 100 })).status, 403, 'not another type');
  assert.equal((await local.accept(up, { method: 'PUT', contentType: 'image/png', body: bytes, maxBytes: 4 })).status, 413);
  // A changed character in the middle of the signature (the last one can carry only padding bits).
  const middle = up.length - 10;
  const altered = `${up.slice(0, middle)}${up[middle] === 'A' ? 'B' : 'A'}${up.slice(middle + 1)}`;
  assert.equal((await local.accept(altered, { method: 'PUT', contentType: 'image/png', body: bytes, maxBytes: 100 })).status, 403, 'not altered');
  assert.equal((await local.accept(up, { method: 'PUT', contentType: 'image/png; charset=binary', body: bytes, maxBytes: 100 })).status, 200);
  assert.equal((await local.accept(up, { method: 'PUT', contentType: 'image/png', body: bytes, maxBytes: 100 })).status, 403, 'never replaced');
  const read = await local.read(KEY, 3);
  assert.deepEqual({ size: read?.sizeBytes, kept: read?.bytes.length }, { size: bytes.length, kept: 3 }, 'never read past the limit');
  const down = token((await local.presignDownload(KEY, { fileName: 'logo.png', expiresInSeconds: 60 })).url);
  assert.equal((await local.accept(down, { method: 'GET', contentType: '', body: Buffer.alloc(0), maxBytes: 0 })).status, 200);
  now += 61_000;
  assert.equal((await local.accept(down, { method: 'GET', contentType: '', body: Buffer.alloc(0), maxBytes: 0 })).status, 403, 'expired');
  await assert.rejects(local.presignUpload('00000000-0000-4000-8000-000000000001/../x', { contentType: 'image/png', expiresInSeconds: 60 }), /STORAGE_KEY_INVALID/);
});
