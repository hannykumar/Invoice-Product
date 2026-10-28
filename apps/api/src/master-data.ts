/**
 * One `MasterDataService` for the running app, shared by every screen that keeps a record.
 *
 * The business's own bank account (#180), its customers and its items (#181) are all master data,
 * and they all belong in the same service: two services would mean a customer created on the Sale
 * screen was invisible to the challan screen, and a bank account saved on one screen invisible to
 * the bill.
 *
 * Issue #366 — with a database the service keeps nothing of its own. Its repositories read and write
 * `master_versions` directly, its commands and idempotency keys are PostgreSQL's (`command_records`,
 * `master_command_records`), and each write runs in the request's unit of work, so two API processes
 * on one database see each other's customers and items at once, and a restart loses nothing.
 *
 * Tenancy is preserved the ordinary way: every write and read carries the signed-in company's own
 * request context, and the database applies the company's row-level security.
 *
 * Without a database (tests, demos) it is the same service over in-memory stores.
 *
 * Synchronous readers: the GST calculator, the stock module and the bill screens sit behind
 * synchronous ports owned by other lanes. They read `masterView(companyId)` — in memory the service's
 * own stores, on PostgreSQL a copy of what the database holds that `refreshMasterView` brings up to
 * date at the start of every request (and after every write). Master versions are append-only, so the
 * copy can lag but is never wrong; it is thrown away if an action fails (`forgetMasterView`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompanyId } from '@invoice/kernel';
import {
  AccessControl,
  AuditLog,
  PlatformCommandService,
  type RequestContext,
} from '../../../packages/platform/src/index.ts';
import { reviveJson } from '../../../packages/platform/src/postgres-audit.ts';
import { MASTER_APPROVAL_POLICIES, MasterDataService, MasterReadModel, type MasterStoreKind } from '../../../packages/masters/src/index.ts';
import { VersionedStore } from '../../../packages/masters/src/effective.ts';
import type { VersionStore } from '../../../packages/masters/src/effective.ts';
import type { Id, MasterKind } from '../../../packages/masters/src/types.ts';
import {
  postgresMasterData,
  versionsSince,
  type MasterCodec,
} from '../../../packages/masters/src/postgres-masters.ts';
import { durableDatabase, durableEncryption, onActionFailed } from './durable.ts';
import { masterVersionBoundTo, sealMasterData, unsealMasterData } from './field-encryption.ts';

type Record_ = { readonly id: Id; readonly companyId: Id };

/** Who a master-data write outside anybody's request (the main godown, on first opening) is recorded against. */
let fallbackUser: (companyId: string) => string = (companyId) => companyId;
let fallbackBranch: (companyId: string) => string = (companyId) => `${companyId}:main`;

/** #352 — what is stored carries only the ids in the clear; everything else is sealed. */
const codec: MasterCodec = {
  async seal(data, kind) {
    const encryption = durableEncryption();
    return encryption === null ? data : sealMasterData(encryption, data, masterVersionBoundTo(data.companyId, kind));
  },
  async open<T>(stored: unknown, kind: string, companyId: Id): Promise<T> {
    const encryption = durableEncryption();
    return reviveJson<T>(encryption === null ? stored : await unsealMasterData(encryption, stored, masterVersionBoundTo(companyId, kind)));
  },
};

interface Shared {
  readonly service: MasterDataService;
  readonly access: AccessControl;
  /** Memory only: the service's own stores, for the privacy export. */
  readonly memoryStores: Map<MasterStoreKind, VersionStore<Record_>>;
  readonly db: ReturnType<typeof durableDatabase>;
}

let shared: Shared | null = null;

const build = (db: ReturnType<typeof durableDatabase>): Shared => {
  const memoryStores = new Map<MasterStoreKind, VersionStore<Record_>>();
  if (db === null) {
    const audit = new AuditLog();
    const storeFor = <T extends Record_>(kind: MasterStoreKind) => {
      const store = new VersionedStore<T>();
      memoryStores.set(kind, store as unknown as VersionStore<Record_>);
      return store;
    };
    return { service: new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit, undefined, storeFor), access: new AccessControl(), memoryStores, db };
  }
  return { service: postgresMasterData(db, codec), access: new AccessControl(), memoryStores, db };
};

const masters = (): Shared => {
  const db = durableDatabase();
  if (shared !== null && shared.db !== db) views.clear();
  if (shared === null || shared.db !== db) shared = build(db);
  return shared;
};

/** The one master-data service this process keeps. */
export const masterData = (): MasterDataService => masters().service;

// ------------------------------------------------------------------ the copy for synchronous readers

const KINDS: readonly MasterStoreKind[] = ['party', 'party_address', 'item', 'warehouse', 'batch', 'serial', 'opening_stock', 'price_list', 'price_list_entry', 'tax_default', 'transporter', 'vehicle', 'bank_account'];

interface View {
  readonly stores: Map<MasterStoreKind, VersionedStore<Record_>>;
  readonly model: MasterReadModel;
  /** The last version number brought in, or null before the first read. */
  seq: number | null;
}

const views = new Map<string, View>();
/** Per company, the refresh in progress: a second request waits its turn and then reads again. */
const refreshing = new Map<string, Promise<void>>();

const viewOf = (companyId: string): View => {
  let view = views.get(companyId);
  if (view === undefined) {
    const stores = new Map<MasterStoreKind, VersionedStore<Record_>>(KINDS.map((kind) => [kind, new VersionedStore<Record_>()]));
    const of = (kind: MasterStoreKind) => stores.get(kind) as unknown as VersionedStore<never>;
    const model = new MasterReadModel({
      parties: of('party'), addresses: of('party_address'), items: of('item'), warehouses: of('warehouse'), taxDefaults: of('tax_default'),
      transporters: of('transporter'), vehicles: of('vehicle'), bankAccounts: of('bank_account'),
      byKind: (kind: MasterKind) => stores.get(kind) as VersionedStore<Record_>,
    } as never, () => { throw new Error('Units are read from the master-data service, not from the copy.'); });
    view = { stores, model, seq: null };
    views.set(companyId, view);
  }
  return view;
};

/**
 * Brings this process's copy of one company's master data up to what the database holds. One cheap
 * query when nothing changed. Call it at the start of a request, and after a write that later code in
 * the same request will read synchronously. A no-op without a database.
 */
export const refreshMasterView = (companyId: CompanyId | string): Promise<void> => {
  const db = durableDatabase();
  if (db === null) return Promise.resolve();
  const company = String(companyId);
  const run = async (): Promise<void> => {
    const view = viewOf(company);
    for (;;) {
      const batch = await versionsSince(db, company, view.seq ?? 0, codec);
      for (const { kind, version } of batch) view.stores.get(kind)?.restore(version);
      const last = batch[batch.length - 1];
      view.seq = last === undefined ? (view.seq ?? 0) : last.seq;
      if (batch.length < 500) return;
    }
  };
  const next = (refreshing.get(company) ?? Promise.resolve()).catch(() => undefined).then(run);
  refreshing.set(company, next);
  void next.then(() => { if (refreshing.get(company) === next) refreshing.delete(company); }, () => { if (refreshing.get(company) === next) refreshing.delete(company); });
  return next;
};

/** Throws the copy away; the next `refreshMasterView` reads the database again. After a failed action. */
export const forgetMasterView = (companyId: CompanyId | string): void => { views.delete(String(companyId)); };

onActionFailed(forgetMasterView);

/**
 * The synchronous read side for one company: the service's own stores in memory, the refreshed copy on
 * PostgreSQL. Reading before the copy has been loaded is a bug in the caller, not an empty shop.
 */
export const masterView = (companyId: CompanyId | string): MasterReadModel => {
  const { service } = masters();
  if (durableDatabase() === null) return syncViewOf(service);
  const view = viewOf(String(companyId));
  if (view.seq === null) throw new Error('This company\'s master data has not been read yet: await refreshMasterView(companyId) first.');
  return view.model;
};

const syncViews = new WeakMap<MasterDataService, MasterReadModel>();
const syncViewOf = (service: MasterDataService): MasterReadModel => {
  let model = syncViews.get(service);
  if (model === undefined) { model = service.syncView(); syncViews.set(service, model); }
  return model;
};

/** Runs a master-data write, then makes sure later synchronous reads in this request see it. */
export const writingMasters = async <T>(companyId: CompanyId | string, write: () => Promise<T>): Promise<T> => {
  const result = await write();
  await refreshMasterView(companyId);
  return result;
};

/** #352 — every master record one company keeps, by kind: the privacy export's master side (memory only; the database has its own export). */
export const allMasterRecords = (companyId: string): Record<string, unknown[]> => {
  const { memoryStores } = masters();
  const out: Record<string, unknown[]> = {};
  for (const [kind, store] of memoryStores) out[kind] = [...(store.list(companyId, '9999-12-31') as readonly unknown[])];
  return out;
};


/** Issue #391 — the signed-in person a request's master-data writes are made by. */
const caller = new AsyncLocalStorage<RequestContext>();

/**
 * Issue #391 — runs `work` with master-data writes made by the signed-in caller: their own id,
 * session and permissions. The API's dispatcher wraps every signed-in request in this.
 */
export const asMasterDataCaller = <T>(context: RequestContext, work: () => T): T => caller.run(context, work);

/**
 * A request context for this company's own master data.
 *
 * Inside a signed-in request for this company it is the caller's own context, so the version
 * history, the audit trail and any approval are theirs (#391). Outside one (seeding, first opening)
 * it is the company's system identity, which holds no permissions: it can make an ordinary change
 * but can never approve one, so a merge or any other approval-gated change keeps its maker-checker.
 * On PostgreSQL that identity is the company's owner and main branch (`recordMasterDataAs`), because
 * a command and an audit event name a real user and a real branch.
 */
export const mastersContext = (companyId: CompanyId | string): RequestContext => {
  const company = String(companyId);
  const signedIn = caller.getStore();
  if (signedIn !== undefined && signedIn.companyId === company) return signedIn;
  if (durableDatabase() !== null) {
    return { companyId: company, branchId: fallbackBranch(company), actorId: fallbackUser(company), permissions: new Set(), sessionId: `${company}:master-data-session` };
  }
  const { access } = masters();
  access.grant({
    companyId: company,
    userId: `${company}:master-data`,
    branchIds: new Set([`${company}:main`]),
    active: true,
    permissions: new Set(),
  });
  return access.context(company, `${company}:main`, `${company}:master-data`, `${company}:master-data-session`);
};

/** Issue #340 — names who a write made outside any request is recorded against, and in which branch. */
export const recordMasterDataAs = (user: (companyId: string) => string, branch?: (companyId: string) => string): void => {
  fallbackUser = user;
  if (branch !== undefined) fallbackBranch = branch;
};
