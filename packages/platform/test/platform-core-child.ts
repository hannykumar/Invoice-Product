/**
 * Issue #364 — one server process, started by platform-core.integration.test.ts. Each run is a
 * fresh process with nothing in memory, which is what a restart or a second server is.
 *
 *   sell           a shop's first day: a held exception, and a sale recorded under a command
 *   after-restart  the next morning: read the trail, retry yesterday's sale, look at what is held
 *   race           wait for the starting gun, then create a command under a shared idempotency key
 */
import { createDatabase } from "../src/database.ts";
import { PostgresAuditLog } from "../src/postgres-audit.ts";
import { PostgresAccessControl, PostgresAuthenticationService, PostgresCommandService, PostgresExceptionQueue } from "../src/postgres-platform.ts";
import { makePilot, persisted } from "../../sales/test/record-sale-pilot.ts";

const [phase, raw] = process.argv.slice(2) as [string, string];
const args = JSON.parse(raw) as { companyId: string; branchId: string; userId: string; partyId: string; sessionId: string; startAt: number };
const db = createDatabase(process.env.DATABASE_URL);
const audit = new PostgresAuditLog(db);
const commands = new PostgresCommandService(db, audit);
const exceptions = new PostgresExceptionQueue(db, audit);
const access = new PostgresAccessControl(db);
const auth = new PostgresAuthenticationService(db, access);

const recordSale = async () => {
  const context = await auth.authenticate(args.sessionId);
  const shop = makePilot(db, args);
  // One business action: the command record, its idempotency key, its audit event and the bill.
  return db.unitOfWork(args.companyId, async () => {
    const command = await commands.create(context, { action: "sale.record", risk: "low", idempotencyKey: "counter-sale-1", payload: { requestId: "r1" } });
    const sale = await shop.recordSale("r1");
    return { commandId: command.id, billId: sale.invoice.id, billNumber: sale.invoice.number, deduplicated: sale.deduplicated };
  });
};

let result: unknown;
if (phase === "sell") {
  await makePilot(db, args).setUp();
  await db.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [args.branchId, args.companyId]);
  await access.grant({ companyId: args.companyId, userId: args.userId, branchIds: new Set([args.branchId]), active: true, permissions: new Set(["sale.draft.create"]) });
  const session = await auth.createSession(args.companyId, args.branchId, args.userId);
  args.sessionId = session.id;
  const context = await auth.authenticate(session.id);
  const held = await exceptions.create(context, "The supplier's GST number on this bill does not match our records", ["bill-photo-1"]);
  result = { sessionId: session.id, exceptionId: held.id, sale: await recordSale(), rows: await persisted(db, args.companyId) };
} else if (phase === "after-restart") {
  const context = await auth.authenticate(args.sessionId);
  const trailBefore = (await audit.forCompany(context)).map((event) => event.action);
  const sale = await recordSale();
  result = {
    trailBefore, sale,
    trailAfter: (await audit.forCompany(context)).map((event) => event.action),
    open: (await exceptions.open(context)).map((item) => ({ id: item.id, status: item.status, summary: item.summary, evidence: item.evidence })),
    rows: await persisted(db, args.companyId),
  };
} else {
  const context = await access.context(args.companyId, args.branchId, args.userId, crypto.randomUUID());
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, args.startAt - Date.now())));
  result = { commandId: (await commands.create(context, { action: "sale.record", risk: "low", idempotencyKey: "double-press", payload: { totalPaise: 118000n } })).id };
}
await db.close();
console.log(JSON.stringify(result));
