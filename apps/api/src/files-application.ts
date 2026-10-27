/**
 * Issue #341 — a file the business keeps (a supplier's bill as scanned, the logo), stored privately.
 *
 * 1. `requestUpload`: who is asking, for what, and is the file plausibly acceptable (its name, the
 *    type it claims and its size) — checked before any address is issued. The storage key is ours,
 *    starting with the company's id; the record is `pending`.
 * 2. The browser puts the file at the signed address itself. It never passes through this server.
 * 3. `completeUpload`: the file is read back from storage and screened by the purchase inbox's own
 *    rules (`packages/purchasing/src/safety.ts`, hardened by #401): its real size and type, a virus
 *    scanner's answer, and a full PDF parse. Only then is it `available`; otherwise `quarantined`,
 *    with the reason.
 * 4. `downloadLink`: a one-minute address, after the same permission check, for an available file
 *    of the signed-in company only. Another company's file id is not found.
 */
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forbidden, invalid, notFound } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { LocalObjectStore, SpacesObjectStore, type ObjectStore, type SignedRequest } from '../../../packages/platform/src/storage.ts';
import { DANGEROUS_EXTENSION, DECLARED_TO_TYPE, MAX_ATTACHMENT_BYTES, screenAttachment, type ScanVerdict, type SupportedType } from '../../../packages/purchasing/src/safety.ts';

export type FilePurpose = 'purchase_bill' | 'branding_logo';

/** What each kind of file may be, how large, and who may put it there or read it back. */
const PURPOSES: Readonly<Record<FilePurpose, { readonly types: readonly SupportedType[]; readonly maxBytes: number; readonly write: string; readonly read: string; readonly what: string }>> = {
  // A scanned bill is the purchase inbox's file: its own 25 MB limit and its own types.
  purchase_bill: { types: ['pdf', 'jpeg', 'png', 'heic'], maxBytes: MAX_ATTACHMENT_BYTES, write: 'ledger.post.purchase', read: 'ledger.post.purchase', what: 'a supplier\'s bill' },
  // A logo is printed on every bill: a picture, and small.
  branding_logo: { types: ['png', 'jpeg'], maxBytes: 1024 * 1024, write: 'branding.write', read: 'dashboard.read', what: 'your logo' },
};
const UPLOAD_SECONDS = 5 * 60;
const DOWNLOAD_SECONDS = 60;

export interface StoredFile {
  readonly id: string;
  readonly companyId: string;
  readonly purpose: FilePurpose;
  readonly objectKey: string;
  readonly fileName: string;
  readonly declaredType: string;
  readonly declaredBytes: number;
  readonly state: 'pending' | 'available' | 'quarantined';
  readonly detectedType: string | null;
  readonly sizeBytes: number | null;
  readonly quarantineReason: string | null;
  readonly quarantineMessage: string | null;
  readonly uploadedBy: string;
}

// ---------------------------------------------------------------------------- where it is kept

let store: ObjectStore | null = null;

/**
 * Spaces when it is configured (decision 0003); a local folder otherwise, on a developer's machine or
 * in a test only. Production without Spaces stops here rather than keeping files on one server's disk.
 */
export const objectStore = (env: NodeJS.ProcessEnv = process.env): ObjectStore => {
  if (store !== null) return store;
  if (env.SPACES_BUCKET !== undefined && env.SPACES_BUCKET !== '') {
    store = new SpacesObjectStore({
      endpoint: env.SPACES_ENDPOINT ?? 'https://blr1.digitaloceanspaces.com', region: env.SPACES_REGION ?? 'blr1', bucket: env.SPACES_BUCKET,
      accessKeyId: env.SPACES_ACCESS_KEY_ID ?? '', secretAccessKey: env.SPACES_SECRET_ACCESS_KEY ?? '',
    });
    return store;
  }
  if (!['', 'development', 'test'].includes((env.NODE_ENV ?? '').trim().toLowerCase())) {
    throw new Error('File storage is not set up: SPACES_BUCKET and its keys are needed outside development.');
  }
  store = new LocalObjectStore({ dir: env.FILE_STORE_DIR ?? join(tmpdir(), 'karobar-files'), baseUrl: '/api/files/blob' });
  return store;
};

/**
 * Issue #341, under #401's rule that a file no virus scanner has answered for is held: the scanner
 * that answers for stored files. None is chosen for production yet, so there every file stays held,
 * "waiting for a virus check", until one is. On a developer's machine and in tests a stand-in answers
 * clean, so the rest of the flow can be tried (CLAUDE.md rule 5).
 */
export interface MalwareScanner { scan(bytes: Uint8Array): Promise<ScanVerdict> }
export const malwareScanner = (env: NodeJS.ProcessEnv = process.env): MalwareScanner =>
  ['', 'development', 'test'].includes((env.NODE_ENV ?? '').trim().toLowerCase())
    ? { async scan() { return 'clean'; } }
    : { async scan() { return 'unscanned'; } };

/** The local store, when that is the one in use: the `/api/files/blob` route answers for it. */
export const localObjectStore = (): LocalObjectStore | null => {
  const current = objectStore();
  return current instanceof LocalObjectStore ? current : null;
};

/** The largest file any purpose accepts: the limit on the local blob route. */
export const MAX_STORED_FILE_BYTES = Math.max(...Object.values(PURPOSES).map((purpose) => purpose.maxBytes));

// ------------------------------------------------------------------------------- the records

interface FileRecords {
  insert(file: StoredFile): Promise<void>;
  find(companyId: string, id: string): Promise<StoredFile | null>;
  screened(file: StoredFile): Promise<void>;
}

const memoryRows = new Map<string, StoredFile>();
const inMemory: FileRecords = {
  async insert(file) { memoryRows.set(`${file.companyId}:${file.id}`, file); },
  async find(companyId, id) { return memoryRows.get(`${companyId}:${id}`) ?? null; },
  async screened(file) { memoryRows.set(`${file.companyId}:${file.id}`, file); },
};

const COLUMNS = 'id, company_id, purpose, object_key, file_name, declared_type, declared_bytes, state, detected_type, size_bytes, quarantine_reason, quarantine_message, uploaded_by';
const fileOf = (r: Record<string, unknown>): StoredFile => ({
  id: String(r.id), companyId: String(r.company_id), purpose: String(r.purpose) as FilePurpose, objectKey: String(r.object_key),
  fileName: String(r.file_name), declaredType: String(r.declared_type), declaredBytes: Number(r.declared_bytes),
  state: String(r.state) as StoredFile['state'], detectedType: r.detected_type === null ? null : String(r.detected_type),
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), quarantineReason: r.quarantine_reason === null ? null : String(r.quarantine_reason),
  quarantineMessage: r.quarantine_message === null ? null : String(r.quarantine_message), uploadedBy: String(r.uploaded_by),
});
const inPostgres = (db: TransactionalExecutor): FileRecords => ({
  async insert(file) {
    await db.requireUnitOfWork(file.companyId).sql.query(
      `INSERT INTO stored_files (id, company_id, purpose, object_key, file_name, declared_type, declared_bytes, state, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [file.id, file.companyId, file.purpose, file.objectKey, file.fileName, file.declaredType, file.declaredBytes, file.uploadedBy]);
  },
  async find(companyId, id) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
    const { rows } = await db.tenantTransaction(companyId, (sql) => sql.query(`SELECT ${COLUMNS} FROM stored_files WHERE company_id = $1 AND id = $2`, [companyId, id]));
    return rows[0] === undefined ? null : fileOf(rows[0]);
  },
  async screened(file) {
    await db.requireUnitOfWork(file.companyId).sql.query(
      `UPDATE stored_files SET state = $3, detected_type = $4, size_bytes = $5, quarantine_reason = $6, quarantine_message = $7, updated_at = now()
        WHERE company_id = $1 AND id = $2 AND state = 'pending'`,
      [file.companyId, file.id, file.state, file.detectedType, file.sizeBytes, file.quarantineReason, file.quarantineMessage]);
  },
});
const recordsOf = (db: TransactionalExecutor | null): FileRecords => (db === null ? inMemory : inPostgres(db));

// ------------------------------------------------------------------------------- the commands

const purposeOf = (value: unknown): FilePurpose => {
  const purpose = String(value ?? '') as FilePurpose;
  if (!(purpose in PURPOSES)) throw invalid('FILE_PURPOSE', 'Say what this file is: a supplier\'s bill or your logo.');
  return purpose;
};

const requirePermission = (actor: ActorContext, permission: string, what: string): void =>
  permissionPortFromActor.require(actor, permission as Parameters<typeof permissionPortFromActor.require>[1], what);

const publicFile = (file: StoredFile) => ({
  id: file.id, purpose: file.purpose, fileName: file.fileName, state: file.state, sizeBytes: file.sizeBytes ?? file.declaredBytes,
  ...(file.state === 'quarantined' ? { reason: file.quarantineReason, message: file.quarantineMessage } : {}),
});

export async function requestUpload(db: TransactionalExecutor | null, actor: ActorContext, input: Record<string, unknown>): Promise<{ file: ReturnType<typeof publicFile>; upload: SignedRequest }> {
  const purpose = purposeOf(input.purpose);
  const rules = PURPOSES[purpose];
  requirePermission(actor, rules.write, `add ${rules.what}`);
  const fileName = String(input.fileName ?? '').trim();
  const declaredType = String(input.contentType ?? '').trim().toLowerCase();
  const declaredBytes = Number(input.sizeBytes);
  if (fileName === '' || fileName.length > 200) throw invalid('FILE_NAME', 'The file needs a name of at most 200 letters.');
  if (DANGEROUS_EXTENSION.test(fileName)) throw invalid('FILE_TYPE', 'Only a PDF or a photo can be kept here. This file is a program or a web page.');
  const claimed = DECLARED_TO_TYPE[declaredType];
  if (claimed === undefined || !rules.types.includes(claimed)) {
    throw invalid('FILE_TYPE', `${rules.what[0]!.toUpperCase()}${rules.what.slice(1)} can be ${rules.types.map((type) => type.toUpperCase()).join(', ')}. This file says it is ${declaredType || 'something else'}.`);
  }
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) throw invalid('FILE_SIZE', 'This file is empty.');
  if (declaredBytes > rules.maxBytes) throw invalid('FILE_TOO_LARGE', `This file is larger than ${Math.floor(rules.maxBytes / (1024 * 1024))} MB. Please use a smaller scan or picture.`);
  const id = randomUUID();
  const companyId = String(actor.companyId);
  const file: StoredFile = {
    id, companyId, purpose, objectKey: `${companyId}/${purpose}/${id}`, fileName, declaredType, declaredBytes,
    state: 'pending', detectedType: null, sizeBytes: null, quarantineReason: null, quarantineMessage: null, uploadedBy: String(actor.userId),
  };
  await recordsOf(db).insert(file);
  const upload = await objectStore().presignUpload(file.objectKey, { contentType: declaredType, expiresInSeconds: UPLOAD_SECONDS });
  return { file: publicFile(file), upload };
}

export async function completeUpload(db: TransactionalExecutor | null, actor: ActorContext, input: Record<string, unknown>) {
  const file = await recordsOf(db).find(String(actor.companyId), String(input.fileId ?? ''));
  if (file === null) throw notFound('FILE_NOT_FOUND', 'That file was not found.');
  const rules = PURPOSES[file.purpose];
  requirePermission(actor, rules.write, `add ${rules.what}`);
  if (file.state !== 'pending') return { file: publicFile(file) };
  // The whole file as it arrived, never past the limit (#401: what was declared is not trusted).
  const stored = await objectStore().read(file.objectKey, rules.maxBytes);
  if (stored === null) throw invalid('FILE_NOT_UPLOADED', 'The file has not arrived yet. Send it again, then press Done.');
  const verdict = stored.sizeBytes > rules.maxBytes
    ? { ok: false as const, reason: 'FILE_TOO_LARGE', message: `This file is larger than ${Math.floor(rules.maxBytes / (1024 * 1024))} MB, so it has been held.` }
    : await screenAttachment(
      { id: file.id, fileName: file.fileName, declaredMimeType: file.declaredType, sizeBytes: stored.sizeBytes, sha256: createHash('sha256').update(stored.bytes).digest('hex'), storageKey: file.objectKey },
      stored.bytes,
      await malwareScanner().scan(stored.bytes),
    );
  const screened: StoredFile = verdict.ok && rules.types.includes(verdict.detectedType)
    ? { ...file, state: 'available', detectedType: verdict.detectedType, sizeBytes: stored.sizeBytes }
    : {
      ...file, state: 'quarantined', sizeBytes: stored.sizeBytes, detectedType: verdict.ok ? verdict.detectedType : null,
      quarantineReason: verdict.ok ? 'UNSUPPORTED_FILE_TYPE' : verdict.reason,
      quarantineMessage: verdict.ok ? `This file is a ${verdict.detectedType.toUpperCase()}, which cannot be used as ${rules.what}.` : verdict.message,
    };
  await recordsOf(db).screened(screened);
  return { file: publicFile(screened) };
}

export async function downloadLink(db: TransactionalExecutor | null, actor: ActorContext, fileId: string) {
  const file = await recordsOf(db).find(String(actor.companyId), fileId);
  if (file === null) throw notFound('FILE_NOT_FOUND', 'That file was not found.');
  const rules = PURPOSES[file.purpose];
  requirePermission(actor, rules.read, `open ${rules.what}`);
  if (file.state !== 'available') {
    throw forbidden('FILE_NOT_AVAILABLE', file.state === 'quarantined' ? `This file was held and cannot be opened: ${file.quarantineMessage}` : 'This file has not been checked yet.');
  }
  return { file: publicFile(file), download: await objectStore().presignDownload(file.objectKey, { fileName: file.fileName, expiresInSeconds: DOWNLOAD_SECONDS }) };
}

/**
 * Issue #489 — a supplier's bill that was put in storage and passed screening, handed to the
 * purchase inbox. The company is the signed-in one's, so another company's file id is simply not
 * found; a file still waiting, or held, is refused with the reason it was held for.
 */
export async function availableBill(db: TransactionalExecutor | null, actor: ActorContext, fileId: string): Promise<{ readonly file: StoredFile; readonly bytes: Uint8Array }> {
  const file = await recordsOf(db).find(String(actor.companyId), fileId);
  if (file === null || file.purpose !== 'purchase_bill') throw notFound('FILE_NOT_FOUND', 'That file was not found.');
  if (file.state !== 'available') {
    throw forbidden('FILE_NOT_AVAILABLE', file.state === 'quarantined' ? `This file was held and cannot be used: ${file.quarantineMessage}` : 'This file has not been checked yet. Press Done after it has been sent.');
  }
  const stored = await objectStore().read(file.objectKey, PURPOSES.purchase_bill.maxBytes);
  if (stored === null) throw invalid('FILE_NOT_UPLOADED', 'The file is no longer there. Send it again.');
  return { file, bytes: stored.bytes };
}

/**
 * Issue #489 — puts bytes that reached the server (an email or WhatsApp delivery) in the private
 * store, so the reader can fetch them by key like a file the browser put there. The same signed
 * address a browser would use, taken here by the server itself. A key already holding a file is left
 * as it is: the key is made from the file's own hash, so it is the same file.
 */
export async function putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const signed = await objectStore().presignUpload(key, { contentType, expiresInSeconds: UPLOAD_SECONDS });
  const local = localObjectStore();
  if (local !== null) {
    const token = new URL(signed.url, 'http://local.invalid').searchParams.get('token') ?? '';
    const written = await local.accept(token, { method: 'PUT', contentType, body: bytes, maxBytes: MAX_STORED_FILE_BYTES });
    if (written.status === 200) return;
    if (written.status === 403 && await objectStore().read(key, MAX_STORED_FILE_BYTES) !== null) return;
    throw new Error('FILE_STORE_REFUSED');
  }
  const response = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: bytes as BodyInit });
  if (!response.ok) throw new Error('FILE_STORE_REFUSED');
}
