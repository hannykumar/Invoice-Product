/**
 * Issue #4 [E04] — an in-memory store and the mocks for GPT 2's platform ports.
 *
 * This exists so the ledger rules can be tested exhaustively without a database, and so other
 * agents can build against a working ledger before infrastructure lands. It is not a production
 * adapter: the Postgres schema in `migrations/0001_ledger.sql` is the shipping store.
 *
 * `transaction` serialises work per company and rolls back on failure, which is what makes the
 * concurrency and duplicate-posting tests meaningful rather than decorative.
 */
import { conflict, forbidden, type CompanyId, type UserId, type VoucherId, type AccountId } from '@invoice/kernel';
import type { Account } from '../domain/account.ts';
import type { FiscalPeriod, PeriodState } from '../domain/period.ts';
import type { Voucher } from '../domain/voucher.ts';
import type {
  AccountRepository,
  ActorContext,
  AuditEvent,
  AuditPort,
  IdempotencyPort,
  LedgerSettings,
  LedgerStore,
  PeriodRepository,
  PermissionPort,
  SequenceRepository,
  SettingsRepository,
  UnitOfWork,
  VoucherFilter,
  VoucherRepository,
} from '../ports.ts';

interface State {
  accounts: Account[];
  vouchers: Voucher[];
  periods: FiscalPeriod[];
  sequences: Map<string, number>;
  settings: Map<string, LedgerSettings>;
  idempotency: Map<string, string>;
}

const emptyState = (): State => ({
  accounts: [],
  vouchers: [],
  periods: [],
  sequences: new Map(),
  settings: new Map(),
  idempotency: new Map(),
});

const snapshot = (s: State): State => ({
  accounts: [...s.accounts],
  vouchers: [...s.vouchers],
  periods: [...s.periods],
  sequences: new Map(s.sequences),
  settings: new Map(s.settings),
  idempotency: new Map(s.idempotency),
});

const restore = (target: State, from: State): void => {
  target.accounts = from.accounts;
  target.vouchers = from.vouchers;
  target.periods = from.periods;
  target.sequences = from.sequences;
  target.settings = from.settings;
  target.idempotency = from.idempotency;
};

const makeUnitOfWork = (state: State): UnitOfWork => {
  const accounts: AccountRepository = {
    async findById(companyId, id) {
      return state.accounts.find((a) => a.companyId === companyId && a.id === id) ?? null;
    },
    async findManyByIds(companyId, ids) {
      const wanted = new Set<string>(ids as readonly string[]);
      return state.accounts.filter((a) => a.companyId === companyId && wanted.has(a.id));
    },
    async findByCode(companyId, code) {
      return state.accounts.find((a) => a.companyId === companyId && a.code === code) ?? null;
    },
    async findBySystemRole(companyId, role) {
      return state.accounts.find((a) => a.companyId === companyId && a.systemRole === role) ?? null;
    },
    async listAll(companyId) {
      return state.accounts.filter((a) => a.companyId === companyId);
    },
    async insertMany(toInsert) {
      state.accounts = [...state.accounts, ...toInsert];
    },
  };

  const vouchers: VoucherRepository = {
    async findById(companyId, id) {
      return state.vouchers.find((v) => v.companyId === companyId && v.id === id) ?? null;
    },
    async insert(voucher) {
      const clash = state.vouchers.find((v) => v.companyId === voucher.companyId && v.number === voucher.number);
      if (clash !== undefined) {
        throw conflict('LEDGER_DUPLICATE_NUMBER', `Entry number ${voucher.number} was already used.`);
      }
      state.vouchers = [...state.vouchers, voucher];
    },
    async markReversed(companyId, id, reversedBy, reason) {
      state.vouchers = state.vouchers.map((v) =>
        v.companyId === companyId && v.id === id
          ? { ...v, state: 'REVERSED' as const, reversedByVoucherId: reversedBy, reason }
          : v,
      );
    },
    async list(companyId, filter: VoucherFilter) {
      return state.vouchers.filter((v) => {
        if (v.companyId !== companyId) return false;
        if (filter.from !== undefined && v.date < filter.from) return false;
        if (filter.to !== undefined && v.date > filter.to) return false;
        if (filter.types !== undefined && !filter.types.includes(v.type)) return false;
        if (filter.includeStates !== undefined && !filter.includeStates.includes(v.state)) return false;
        if (filter.accountId !== undefined && !v.lines.some((l) => l.accountId === filter.accountId)) return false;
        if (filter.partyId !== undefined && !v.lines.some((l) => l.partyId === filter.partyId)) return false;
        return true;
      });
    },
  };

  const periods: PeriodRepository = {
    async find(companyId, monthKey) {
      return state.periods.find((p) => p.companyId === companyId && p.monthKey === monthKey) ?? null;
    },
    async upsertState(companyId, monthKey, financialYear, periodState, lockedBy, lockedAt, reason) {
      const existing = state.periods.find((p) => p.companyId === companyId && p.monthKey === monthKey);
      const next: FiscalPeriod = {
        id: (existing?.id ?? `${companyId}:period:${monthKey}`) as FiscalPeriod['id'],
        companyId,
        monthKey,
        financialYear,
        state: periodState,
        lockedBy: lockedBy as UserId | null,
        lockedAt,
        reason,
      };
      state.periods = existing === undefined
        ? [...state.periods, next]
        : state.periods.map((p) => (p === existing ? next : p));
      return next;
    },
    async list(companyId, financialYear) {
      return state.periods.filter(
        (p) => p.companyId === companyId && (financialYear === undefined || p.financialYear === financialYear),
      );
    },
  };

  const sequences: SequenceRepository = {
    async next(companyId, scope) {
      const key = `${companyId}:${scope}`;
      const value = (state.sequences.get(key) ?? 0) + 1;
      state.sequences.set(key, value);
      return value;
    },
  };

  const settings: SettingsRepository = {
    async get(companyId) {
      return state.settings.get(companyId) ?? null;
    },
    async put(value) {
      state.settings.set(value.companyId, value);
    },
  };

  const idempotency: IdempotencyPort = {
    async lookup(companyId, key) {
      return state.idempotency.get(`${companyId}:${key}`) ?? null;
    },
    async remember(companyId, key, resultId) {
      const composite = `${companyId}:${key}`;
      if (state.idempotency.has(composite)) {
        throw conflict('IDEMPOTENCY_KEY_TAKEN', 'This action was already recorded.');
      }
      state.idempotency.set(composite, resultId);
    },
  };

  return { accounts, vouchers, periods, sequences, settings, idempotency };
};

export class InMemoryLedgerStore implements LedgerStore {
  readonly #state: State = emptyState();
  /** One promise chain per company, so two commands for one business never interleave. */
  readonly #locks = new Map<string, Promise<unknown>>();

  async transaction<T>(companyId: CompanyId, work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const previous = this.#locks.get(companyId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const before = snapshot(this.#state);
      try {
        return await work(makeUnitOfWork(this.#state));
      } catch (error) {
        restore(this.#state, before);
        throw error;
      }
    });
    this.#locks.set(
      companyId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  read(): UnitOfWork {
    return makeUnitOfWork(this.#state);
  }
}

/** GPT 2 issue #3 mock: the caller's permission list is the whole truth. */
export const permissionPortFromActor: PermissionPort = {
  require(actor: ActorContext, permission: string, what: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden('PERMISSION_DENIED', `You cannot ${what} with your current access.`, {
        messageId: 'permission.not_allowed',
        details: { actionLabel: what },
      });
    }
  },
};

/** GPT 2 issue #6 mock: keeps every event so tests can assert what was recorded. */
export class InMemoryAuditPort implements AuditPort {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  forSubject(subjectId: string): AuditEvent[] {
    return this.events.filter((e) => e.subjectId === subjectId);
  }
}

export type { AccountId, VoucherId };
