/**
 * One `MasterDataService` for the running app, shared by every screen that keeps a record.
 *
 * The business's own bank account (#180), its customers and its items (#181) are all master data,
 * and they all belong in the same store: two services would mean a customer created on the Sale
 * screen was invisible to the challan screen, and a bank account saved on one screen invisible to
 * the bill. It is created lazily and kept for the life of the process, because a service per
 * request would lose every record the moment the request ended.
 *
 * Tenancy is preserved the ordinary way: every write and read carries the signed-in company's own
 * request context, and the store keys each record by company.
 *
 * Issue #340 — with a database, every new version is also written to `master_versions` inside the
 * request's unit of work, and a company's records are read back from there when it is first opened.
 * A bill's customer, items and godown are therefore rows the bill's own row can point to.
 */
import type { CompanyId } from '@invoice/kernel';
import {
  AccessControl,
  AuditLog,
  PlatformCommandService,
  type RequestContext,
} from '../../../packages/platform/src/index.ts';
import { MASTER_APPROVAL_POLICIES, MasterDataService, type MasterStoreKind } from '../../../packages/masters/src/index.ts';
import { VersionedStore } from '../../../packages/masters/src/effective.ts';
import type { Id, IsoDate } from '../../../packages/masters/src/types.ts';
import { PostgresVersionedStore } from '../../../packages/masters/src/postgres-masters.ts';
import { reviveJson } from '../../../packages/platform/src/postgres-audit.ts';
import { requestScope } from './log.ts';
import { durableDatabase, onReload, persist } from './durable.ts';

type Record_ = { readonly id: Id; readonly companyId: Id };

/** Who a master-data write outside anybody's request (the main godown, on first opening) is recorded against. */
let fallbackUser: (companyId: string) => string = (companyId) => companyId;

/**
 * An in-memory store that also appends every new version to PostgreSQL. The in-memory append is the
 * synchronous one the service needs; the PostgreSQL append joins the caller's unit of work, and the
 * request does not commit until it has settled (`durable.ts`).
 *
 * ponytail: memory is the read path, so two API processes would not see each other's new records.
 * One process is the deployment today; the upgrade is an async `MasterDataService` reading the
 * PostgreSQL stores directly (`postgres-masters.ts`), which is the masters lane's (#366).
 */
class MirroredStore<T extends Record_> extends VersionedStore<T> {
  readonly #kind: MasterStoreKind;
  #replaying = false;

  constructor(kind: MasterStoreKind) {
    super();
    this.#kind = kind;
  }

  override append(data: T, effectiveFrom: IsoDate, recordedBy: Id, reason?: string) {
    const version = super.append(data, effectiveFrom, recordedBy, reason);
    const db = durableDatabase();
    if (db === null || this.#replaying) return version;
    const user = requestScope().user_id ?? fallbackUser(data.companyId);
    // The PostgreSQL store writes on whichever unit of work `persist` gives it (the action's, or its own).
    persist(data.companyId, () => new PostgresVersionedStore<T>(db, this.#kind).append(data, effectiveFrom, user, reason));
    return version;
  }

  /** Puts a version read from the database back into memory, without writing it again. */
  replay(data: T, effectiveFrom: IsoDate, recordedBy: Id, reason?: string): void {
    this.#replaying = true;
    try { super.append(data, effectiveFrom, recordedBy, reason); } finally { this.#replaying = false; }
  }
}

let shared: { readonly service: MasterDataService; readonly access: AccessControl; readonly stores: Map<MasterStoreKind, MirroredStore<Record_>> } | null = null;

const masters = () => {
  if (shared === null) {
    const audit = new AuditLog();
    const stores = new Map<MasterStoreKind, MirroredStore<Record_>>();
    const storeFor = <T extends Record_>(kind: MasterStoreKind) => {
      const store = new MirroredStore<T>(kind);
      stores.set(kind, store as unknown as MirroredStore<Record_>);
      return store;
    };
    shared = {
      service: new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit, undefined, storeFor),
      access: new AccessControl(),
      stores,
    };
  }
  return shared;
};

/** The one master-data service this process keeps. */
export const masterData = (): MasterDataService => masters().service;

/** A request context for this company's own master data. Granted once, then reused. */
export const mastersContext = (companyId: CompanyId | string): RequestContext => {
  const { access } = masters();
  const company = String(companyId);
  access.grant({
    companyId: company,
    userId: `${company}:master-data`,
    branchIds: new Set([`${company}:main`]),
    active: true,
    permissions: new Set(['approval.decide', 'access.review']),
  });
  return access.context(company, `${company}:main`, `${company}:master-data`, `${company}:master-data-session`);
};

/** Issue #340 — names who a write made outside any request is recorded against. */
export const recordMasterDataAs = (user: (companyId: string) => string): void => { fallbackUser = user; };

// After a failed request the whole in-memory service is rebuilt and every loaded company read back:
// the service keeps no per-company reset, and a failed write is rare.
onReload(
  () => { shared = null; },
  async (companyId) => {
    const db = durableDatabase();
    if (db === null) return;
    const { stores } = masters();
    const { rows } = await db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT r.kind, v.data, v.effective_from::text AS effective_from, v.recorded_by, v.reason
         FROM master_versions v JOIN master_records r ON r.company_id = v.company_id AND r.id = v.record_id
        WHERE v.company_id = $1 ORDER BY v.recorded_at, v.version`, [companyId]));
    for (const row of rows) {
      stores.get(row.kind as MasterStoreKind)?.replay(reviveJson<Record_>(row.data), String(row.effective_from), String(row.recorded_by), row.reason === null ? undefined : String(row.reason));
    }
  },
);
