/**
 * Issue #350, ADR D6 — rate limits and spending caps, counted in PostgreSQL so they hold across
 * servers and survive a deploy.
 *
 * One fixed-window counter per (bucket, window): one atomic `INSERT … ON CONFLICT … DO UPDATE …
 * RETURNING count` per limited request, so two servers counting the same bucket at once count both.
 * Buckets are hashed: the table never holds a phone number, an email or an IP address.
 *
 * ponytail: fixed windows let up to twice a limit through across a window's edge; switch to a sliding
 * window only if that is ever seen being used.
 */
import { createHash } from "node:crypto";
import type { SqlExecutor } from "./database.ts";

export interface Counted { readonly count: number; readonly resetsAt: number; }

export interface CounterStore {
  /** Counts one more in this bucket's current window and says how many there now are. */
  hit(bucket: string, windowSeconds: number, now: number): Promise<Counted>;
  /** How many there are in the current window, without counting. */
  peek(bucket: string, windowSeconds: number, now: number): Promise<Counted>;
}

const windowOf = (windowSeconds: number, now: number) => {
  const start = Math.floor(now / 1000 / windowSeconds) * windowSeconds * 1000;
  return { start, end: start + windowSeconds * 1000 };
};

/** A developer's machine and tests: one process, so memory is shared enough. */
export class MemoryCounterStore implements CounterStore {
  readonly #counts = new Map<string, number>();
  async hit(bucket: string, windowSeconds: number, now: number): Promise<Counted> {
    const { start, end } = windowOf(windowSeconds, now);
    const key = `${bucket}@${start}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return { count, resetsAt: end };
  }
  async peek(bucket: string, windowSeconds: number, now: number): Promise<Counted> {
    const { start, end } = windowOf(windowSeconds, now);
    return { count: this.#counts.get(`${bucket}@${start}`) ?? 0, resetsAt: end };
  }
}

/** Counted outside any company's unit of work: a refused request must still have been counted. */
export class PostgresCounterStore implements CounterStore {
  readonly #db: SqlExecutor;
  constructor(db: SqlExecutor) { this.#db = db; }
  async hit(bucket: string, windowSeconds: number, now: number): Promise<Counted> {
    const { start, end } = windowOf(windowSeconds, now);
    const { rows } = await this.#db.query(
      `INSERT INTO rate_limit_counters (bucket, window_start, window_end, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1 RETURNING count`,
      [bucket, new Date(start).toISOString(), new Date(end).toISOString()],
    );
    // Old windows are cleared now and then by whoever is counting; nothing else needs them.
    if (Math.random() < 0.005) await this.#db.query("DELETE FROM rate_limit_counters WHERE window_end < now() - interval '2 days'");
    return { count: Number(rows[0]!.count), resetsAt: end };
  }
  async peek(bucket: string, windowSeconds: number, now: number): Promise<Counted> {
    const { start, end } = windowOf(windowSeconds, now);
    const { rows } = await this.#db.query("SELECT count FROM rate_limit_counters WHERE bucket = $1 AND window_start = $2", [bucket, new Date(start).toISOString()]);
    return { count: rows[0] === undefined ? 0 : Number(rows[0].count), resetsAt: end };
  }
}

export interface Limit {
  readonly name: string;
  readonly max: number;
  readonly windowSeconds: number;
  /** What the shopkeeper is told, after "Please wait N minutes and try again." is added. */
  readonly words: string;
}

/** Too many, too fast: answered 429 with `Retry-After`. */
export class RateLimited extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;
  readonly limit: string;
  constructor(limit: Limit, retryAfterSeconds: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    const wait = retryAfterSeconds >= 3600 * 2 ? "Please try again tomorrow." : `Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
    super(`${limit.words} ${wait}`);
    this.retryAfterSeconds = retryAfterSeconds;
    this.limit = limit.name;
  }
}

const hashed = (name: string, key: string): string => `${name}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

export class RateLimiter {
  readonly #store: CounterStore;
  readonly #now: () => number;
  constructor(store: CounterStore, now: () => number = Date.now) { this.#store = store; this.#now = now; }

  /** Counts one, and refuses it once the limit is passed. Returns the count, so a caller can warn early. */
  async take(limit: Limit, key: string): Promise<number> {
    const now = this.#now();
    const { count, resetsAt } = await this.#store.hit(hashed(limit.name, key), limit.windowSeconds, now);
    if (count > limit.max) throw new RateLimited(limit, Math.max(1, Math.ceil((resetsAt - now) / 1000)));
    return count;
  }

  async used(limit: Limit, key: string): Promise<number> {
    return (await this.#store.peek(hashed(limit.name, key), limit.windowSeconds, this.#now())).count;
  }
}

const MINUTE = 60;
const DAY = 24 * 60 * 60;

/**
 * The limits (#350). Sign-in and code limits are per address and per IP; a successful sign-in is
 * not counted, so only guessing and code requests are. Paid services are capped per company per day,
 * and in total per day so a runaway cannot run up the bill; their monthly allowances by plan are
 * the subscription meters (#42, `ai_requests`, `external_api_calls`).
 */
export const LIMITS = {
  codeRequestsPerAddress: { name: "code-address", max: 5, windowSeconds: 15 * MINUTE, words: "Too many codes have been asked for this number or email." },
  codeRequestsPerIp: { name: "code-ip", max: 5, windowSeconds: 15 * MINUTE, words: "Too many codes have been asked for from here." },
  codesPerAddressPerDay: { name: "code-address-day", max: 5, windowSeconds: DAY, words: "No more codes can be sent to this number or email today." },
  wrongCodesPerAddress: { name: "wrong-code-address", max: 5, windowSeconds: 15 * MINUTE, words: "Too many wrong codes for this number or email." },
  wrongCodesPerIp: { name: "wrong-code-ip", max: 5, windowSeconds: 15 * MINUTE, words: "Too many wrong codes from here." },
  signedOutPerIp: { name: "public-ip", max: 60, windowSeconds: MINUTE, words: "Too many requests from here." },
  perUser: { name: "user", max: 300, windowSeconds: MINUTE, words: "That was a lot of requests in a short time." },
} as const satisfies Record<string, Limit>;

/** Expensive work (PDFs, GST returns, e-invoice and e-way calls, reading bills, the assistant), per company per minute, by plan. */
export const EXPENSIVE_PER_MINUTE: Readonly<Record<string, number>> = { free: 20, starter: 60, growth: 200 };
export const expensiveLimit = (planId: string): Limit => ({
  name: `expensive-${planId}`, max: EXPENSIVE_PER_MINUTE[planId] ?? EXPENSIVE_PER_MINUTE.free!, windowSeconds: MINUTE,
  words: "This business has asked for a lot of heavy work (PDFs, GST, government calls) in the last minute.",
});

/** Services that cost money per call. */
export const PAID_SERVICES = ["llm", "ocr", "gsp", "sms"] as const;
export type PaidService = (typeof PAID_SERVICES)[number];
const SERVICE_WORDS: Readonly<Record<PaidService, string>> = {
  llm: "the assistant", ocr: "reading supplier bills", gsp: "government calls (e-invoice, e-way bill, GST)", sms: "sending codes by SMS",
};
/** Per company per day. */
export const DAILY_QUOTA: Readonly<Record<PaidService, number>> = { llm: 200, ocr: 200, gsp: 500, sms: 50 };
/** Estimated cost of one call, in paise. Owner to confirm against the vendors' invoices. */
export const UNIT_COST_PAISE: Readonly<Record<PaidService, bigint>> = { llm: 100n, ocr: 100n, gsp: 50n, sms: 25n };
/** The most we spend on each service in a day across every business: ₹5,000. Past it the feature switches off until tomorrow. */
export const DAILY_SPEND_CAP_PAISE = 500_000n;

export const companyQuota = (service: PaidService): Limit => ({
  name: `paid-${service}-company`, max: DAILY_QUOTA[service], windowSeconds: DAY,
  words: `This business has used today's allowance for ${SERVICE_WORDS[service]}.`,
});
export const globalCap = (service: PaidService): Limit => ({
  name: `paid-${service}-global`, max: Number(DAILY_SPEND_CAP_PAISE / UNIT_COST_PAISE[service]), windowSeconds: DAY,
  words: `${SERVICE_WORDS[service][0]!.toUpperCase()}${SERVICE_WORDS[service].slice(1)} is switched off for today, because Karobar's daily spending limit for it has been reached.`,
});
