/**
 * Issue #4 [E04] — the ports this module talks to.
 *
 * Storage is a port so the domain rules can be tested without a database. The platform ports
 * (permissions, audit, idempotency) belong to GPT 2 under issues #3 and #6; this module consumes
 * the contract in docs/contracts/platform-ports.v1.md and ships mocks for them, exactly as the
 * parallel-work protocol requires. When GPT 2's implementations land, the mocks are replaced and
 * nothing in this module changes.
 */
import type { AccountId, CompanyId, BranchId, IsoDate, UserId, VoucherId } from '@invoice/kernel';
import type { Account } from './domain/account.ts';
import type { FiscalPeriod, PeriodState } from './domain/period.ts';
import type { Voucher, VoucherType } from './domain/voucher.ts';

/** Who is acting, and in which company. Supplied by GPT 2's issue #3 on every request. */
export interface ActorContext {
  readonly companyId: CompanyId;
  readonly branchId: BranchId | null;
  readonly userId: UserId;
  readonly permissions: readonly string[];
}

/** GPT 2, issue #3. Throws a FORBIDDEN DomainError when the permission is not held. */
export interface PermissionPort {
  require(actor: ActorContext, permission: string, what: string): void;
}

/** GPT 2, issue #6. Append-only, never carries secrets. */
export interface AuditEvent {
  readonly companyId: CompanyId;
  readonly actorId: UserId;
  readonly at: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, string>>;
  readonly overrideReason?: string;
}

export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}

/**
 * GPT 2, issue #6. Makes a retry return the first result instead of creating a second record.
 * The store is scoped to a company so two businesses can never collide on a key.
 */
export interface IdempotencyPort {
  /** Returns the id recorded earlier for this key, or null when the key is new. */
  lookup(companyId: CompanyId, key: string): Promise<string | null>;
  /** Records the outcome. Must fail with a CONFLICT DomainError if the key was already taken. */
  remember(companyId: CompanyId, key: string, resultId: string): Promise<void>;
}

export interface AccountRepository {
  findById(companyId: CompanyId, id: AccountId): Promise<Account | null>;
  findManyByIds(companyId: CompanyId, ids: readonly AccountId[]): Promise<Account[]>;
  findByCode(companyId: CompanyId, code: string): Promise<Account | null>;
  findBySystemRole(companyId: CompanyId, role: string): Promise<Account | null>;
  listAll(companyId: CompanyId): Promise<Account[]>;
  insertMany(accounts: readonly Account[]): Promise<void>;
}

export interface VoucherRepository {
  findById(companyId: CompanyId, id: VoucherId): Promise<Voucher | null>;
  insert(voucher: Voucher): Promise<void>;
  /** Replaces the state of an existing voucher. Only ever used to mark one REVERSED. */
  markReversed(companyId: CompanyId, id: VoucherId, reversedBy: VoucherId, reason: string): Promise<void>;
  list(companyId: CompanyId, filter: VoucherFilter): Promise<Voucher[]>;
}

export interface VoucherFilter {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
  readonly types?: readonly VoucherType[];
  readonly accountId?: AccountId;
  readonly partyId?: string;
  readonly includeStates?: readonly Voucher['state'][];
}

export interface PeriodRepository {
  find(companyId: CompanyId, monthKey: string): Promise<FiscalPeriod | null>;
  upsertState(
    companyId: CompanyId,
    monthKey: string,
    financialYear: string,
    state: PeriodState,
    lockedBy: UserId | null,
    lockedAt: string | null,
    reason: string | null,
  ): Promise<FiscalPeriod>;
  list(companyId: CompanyId, financialYear?: string): Promise<FiscalPeriod[]>;
}

/** Allocates the ledger's own sequence numbers. Document numbering belongs to issue #9. */
export interface SequenceRepository {
  next(companyId: CompanyId, scope: string): Promise<number>;
}

export interface LedgerSettings {
  readonly companyId: CompanyId;
  /** Nothing may be posted before the day the business started keeping books here. */
  readonly booksStartDate: IsoDate;
}

export interface SettingsRepository {
  get(companyId: CompanyId): Promise<LedgerSettings | null>;
  put(settings: LedgerSettings): Promise<void>;
}

/**
 * One unit of work. Everything a command writes happens inside it, so a failure leaves nothing
 * half-written: there is no half-saved bill (issue #46, message `state.failed_nothing_saved`).
 */
export interface UnitOfWork {
  readonly accounts: AccountRepository;
  readonly vouchers: VoucherRepository;
  readonly periods: PeriodRepository;
  readonly sequences: SequenceRepository;
  readonly settings: SettingsRepository;
  readonly idempotency: IdempotencyPort;
}

export interface LedgerStore {
  /** Runs `work` inside a serialisable transaction, retrying nothing on its behalf. */
  transaction<T>(companyId: CompanyId, work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
  /** Read-only access outside a transaction, for reports and queries. */
  read(): UnitOfWork;
}
