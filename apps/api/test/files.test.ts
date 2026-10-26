/**
 * Issue #341 — files kept privately, through the real server: a signed address to upload to, the
 * screening once the file has arrived, a one-minute address to open it. Done when: no object is
 * public; a wrong type, a file too large, and a user of another company trying to download are
 * all refused. Runs on the local store (CLAUDE.md rule 5: no production credential).
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

process.env.FILE_STORE_DIR = await mkdtemp(join(tmpdir(), 'karobar-files-test-'));
const { apiServer } = await import('../src/server.ts');
const { signInOverHttp } = await import('./sign-in-helper.ts');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
/** A small but real one-page PDF: screening parses the whole file (#401), so a bare header is held. */
const PDF = (() => {
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += `${object}\n`; }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
})();
let base = '';

before(async () => {
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => apiServer.close(() => resolve())));

/** `cookie` is the session cookie from signing in (#342). */
const call = async (method: string, path: string, cookie: string, body?: unknown): Promise<Record<string, any>> => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ...(await response.json() as Record<string, any>) };
};
const signIn = (companyId: string, address: string): Promise<string> => signInOverHttp(base, address, companyId);
/** What the browser does with the signed address: it puts the file there itself. */
const put = (upload: { url: string; method: string; headers: Record<string, string> }, bytes: Buffer, contentType = upload.headers['content-type']!) =>
  fetch(`${base}${upload.url}`, { method: upload.method, headers: { ...upload.headers, 'content-type': contentType, origin: base }, body: new Uint8Array(bytes) });

const upload = async (token: string, file: { purpose: string; fileName: string; contentType: string; bytes: Buffer; sizeBytes?: number }) => {
  const requested = await call('POST', '/api/files/uploads', token, { purpose: file.purpose, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes ?? file.bytes.length });
  assert.equal(requested.status, 200, JSON.stringify(requested));
  assert.equal((await put(requested.upload, file.bytes)).status, 200);
  const done = await call('POST', `/api/files/${requested.file.id}/complete`, token);
  assert.equal(done.status, 200, JSON.stringify(done));
  return done;
};

test('a logo: uploaded straight to storage, screened, and opened through a short-lived address', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const requested = await call('POST', '/api/files/uploads', owner, { purpose: 'branding_logo', fileName: 'logo.png', contentType: 'image/png', sizeBytes: PNG.length });
  assert.equal(requested.status, 200);
  assert.equal(requested.file.state, 'pending');
  assert.match(requested.upload.url, /^\/api\/files\/blob\?token=/);
  // Until it has been screened it cannot be opened.
  assert.equal((await call('GET', `/api/files/${requested.file.id}/link`, owner)).status, 403);
  assert.equal((await put(requested.upload, PNG)).status, 200);
  const done = await call('POST', `/api/files/${requested.file.id}/complete`, owner);
  assert.equal(done.file.state, 'available');
  const link = await call('GET', `/api/files/${requested.file.id}/link`, owner);
  assert.equal(link.status, 200);
  const fetched = await fetch(`${base}${link.download.url}`);
  assert.equal(fetched.status, 200);
  assert.match(String(fetched.headers.get('content-disposition')), /^attachment; filename="logo.png"$/);
  assert.equal(fetched.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG);
  // The upload address was for one file: it cannot be used to replace it.
  assert.equal((await put(requested.upload, PDF, 'image/png')).status, 403);
});

test('no file is public: no address, an altered one, or one used for another method opens anything', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const done = await upload(owner, { purpose: 'branding_logo', fileName: 'logo.png', contentType: 'image/png', bytes: PNG });
  const link = await call('GET', `/api/files/${done.file.id}/link`, owner);
  const token = new URL(link.download.url, base).searchParams.get('token')!;
  assert.equal((await fetch(`${base}/api/files/blob`)).status, 403);
  assert.equal((await fetch(`${base}/api/files/blob?token=${token.slice(0, -2)}xx`)).status, 403);
  assert.equal((await fetch(`${base}/api/files/blob?token=${token}`, { method: 'PUT', headers: { origin: base, 'content-type': 'image/png' }, body: PNG })).status, 403);
});

test('a wrong type is refused before an address is issued, and a file that is not what it claims is held', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const program = await call('POST', '/api/files/uploads', owner, { purpose: 'purchase_bill', fileName: 'bill.exe', contentType: 'application/pdf', sizeBytes: 100 });
  assert.equal(program.status, 422);
  assert.equal(program.code, 'FILE_TYPE');
  const svg = await call('POST', '/api/files/uploads', owner, { purpose: 'branding_logo', fileName: 'logo.svg', contentType: 'image/svg+xml', sizeBytes: 100 });
  assert.equal(svg.status, 422);
  // Says it is a picture, is a PDF: kept, held, and never opened.
  const disguised = await upload(owner, { purpose: 'branding_logo', fileName: 'logo.png', contentType: 'image/png', bytes: PDF });
  assert.equal(disguised.file.state, 'quarantined');
  assert.equal(disguised.file.reason, 'FILE_TYPE_MISMATCH');
  assert.match(disguised.file.message, /named like a PNG but its contents are a PDF/);
  assert.equal((await call('GET', `/api/files/${disguised.file.id}/link`, owner)).status, 403);
  // A PDF is a fine supplier's bill.
  const bill = await upload(owner, { purpose: 'purchase_bill', fileName: 'shree-ram-steels-482.pdf', contentType: 'application/pdf', bytes: PDF });
  assert.equal(bill.file.state, 'available');
});

test('too large: refused when it says so, and held when it arrives larger than it said', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const declared = await call('POST', '/api/files/uploads', owner, { purpose: 'branding_logo', fileName: 'logo.png', contentType: 'image/png', sizeBytes: 2 * 1024 * 1024 });
  assert.equal(declared.status, 422);
  assert.equal(declared.code, 'FILE_TOO_LARGE');
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10)]);
  const arrived = await upload(owner, { purpose: 'branding_logo', fileName: 'logo.png', contentType: 'image/png', bytes: big, sizeBytes: 1000 });
  assert.equal(arrived.file.state, 'quarantined');
  assert.equal(arrived.file.reason, 'FILE_TOO_LARGE');
});

test('a person of another company cannot open the file, and one without the right cannot add or open a bill', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const bill = await upload(owner, { purpose: 'purchase_bill', fileName: 'bill.pdf', contentType: 'application/pdf', bytes: PDF });
  const konkan = await signIn(KONKAN, 'owner@konkan.example.invalid');
  assert.equal((await call('GET', `/api/files/${bill.file.id}/link`, konkan)).status, 404);
  assert.equal((await call('POST', `/api/files/${bill.file.id}/complete`, konkan)).status, 404);
  const viewer = await signIn(SAMPOORNA, 'viewer@sampoorna.example.invalid');
  assert.equal((await call('GET', `/api/files/${bill.file.id}/link`, viewer)).status, 403);
  assert.equal((await call('POST', '/api/files/uploads', viewer, { purpose: 'purchase_bill', fileName: 'bill.pdf', contentType: 'application/pdf', sizeBytes: 100 })).status, 403);
});

test('outside development no scanner answers yet, so every file waits, held, for a virus check (#401)', async () => {
  const { malwareScanner } = await import('../src/files-application.ts');
  assert.equal(await malwareScanner({ NODE_ENV: 'production' }).scan(PNG), 'unscanned');
  assert.equal(await malwareScanner({ NODE_ENV: 'development' }).scan(PNG), 'clean');
});
