/**
 * Issue #366 — one contract suite for the master-data stores, run against the in-memory classes
 * (masters-store-contract.test.ts) and against PostgreSQL (masters-store-contract.integration.test.ts).
 *
 * The in-memory classes answer directly and the PostgreSQL ones answer with promises; every call
 * here is awaited, so the same assertions hold for both. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRecordStore, Maybe, Version, VersionStore } from "../src/effective.ts";
import { syntheticGstin } from "../src/fixtures.ts";
import type { Id } from "../src/types.ts";
import { quantity, type UnitStore } from "../src/units.ts";

/** A record with every shape of value the real masters hold: paise, a quantity, lists, a missing field, a null. */
export interface Sample {
  readonly id: Id; readonly companyId: Id; readonly name: string; readonly gstin?: string; readonly creditLimitPaise?: bigint;
  readonly opening?: { readonly scaled: bigint; readonly unit: string }; readonly phones?: readonly string[]; readonly expiresOn?: string;
  readonly active?: boolean; readonly note?: string | null; readonly ratedCapacityKg?: number;
}
export type SampleKind = "party" | "item" | "vehicle";

export interface MastersHarness {
  store(kind: SampleKind): VersionStore<Sample>;
  commandIndex: CommandRecordStore;
  units(companyId: Id): UnitStore;
  /** Rows that exist wherever the implementation keeps them. */
  company(): Promise<Id>;
  user(): Promise<Id>;
  command(companyId: Id, userId: Id): Promise<Id>;
  /** One business action: on PostgreSQL the unit of work every write must run in. */
  write<T>(companyId: Id, work: () => Maybe<T>): Promise<T>;
}

const attempt = async <T>(work: () => Maybe<T>): Promise<T> => work();
const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");
/** Another company's record is either refused or simply not there; it is never handed over. */
const hidden = async (work: () => Maybe<unknown>): Promise<void> => {
  let answer: unknown;
  try { answer = await work(); } catch (error) { assert.ok(code("TENANT_ISOLATION")(error), `unexpected error: ${String(error)}`); return; }
  assert.ok(answer === null || answer === undefined || (Array.isArray(answer) && answer.length === 0), "another company's record was returned");
};

export function mastersStoreContract(label: string, harness: () => MastersHarness, skip: false | string = false): void {
  const shop = async () => {
    const h = harness();
    const companyId = await h.company();
    const userId = await h.user();
    const add = (kind: SampleKind, data: Omit<Sample, "id" | "companyId"> & { id?: Id }, effectiveFrom = "2026-04-01", reason?: string): Promise<Version<Sample>> =>
      h.write(companyId, () => h.store(kind).append({ id: crypto.randomUUID(), ...data, companyId }, effectiveFrom, userId, reason));
    return { h, companyId, userId, add };
  };

  test(`${label}: every version is kept, and a date picks the one in force then`, { skip }, async () => {
    const { h, companyId, userId, add } = await shop();
    const parties = h.store("party");
    const first = await add("party", { name: "Synthetic Traders" }, "2026-04-01");
    const id = first.recordId;
    const moved = await add("party", { id, name: "Synthetic Traders and Sons" }, "2026-07-01", "new signboard");
    const backdated = await add("party", { id, name: "Synthetic Traders (corrected)" }, "2026-05-01");
    const sameDay = await add("party", { id, name: "Synthetic Traders (corrected twice)" }, "2026-05-01");

    assert.deepEqual([first, moved, backdated, sameDay].map((version) => version.version), [1, 2, 3, 4], "numbered in the order recorded");
    assert.deepEqual({ recordId: first.recordId, companyId: first.companyId, effectiveFrom: first.effectiveFrom, recordedBy: first.recordedBy }, { recordId: id, companyId, effectiveFrom: "2026-04-01", recordedBy: userId });
    assert.equal("reason" in first, false, "no reason given, none stored");
    assert.equal(moved.reason, "new signboard");
    assert.equal(new Date(first.recordedAt).toISOString(), first.recordedAt);
    assert.deepEqual(await parties.history(companyId, id), [first, moved, backdated, sameDay]);

    assert.equal(await parties.asOf(companyId, id, "2026-03-31"), null, "it did not exist yet");
    assert.equal(await parties.current(companyId, id, "2026-03-31"), null);
    assert.deepEqual(await parties.asOf(companyId, id, "2026-04-01"), first);
    assert.deepEqual(await parties.asOf(companyId, id, "2026-06-30"), sameDay, "a later correction wins on the same date");
    assert.deepEqual(await parties.asOf(companyId, id, "2026-07-01"), moved);
    assert.deepEqual(await parties.latest(companyId, id), sameDay, "latest is the last one recorded, whatever its date");
    assert.equal((await parties.current(companyId, id, "9999-12-31"))?.name, "Synthetic Traders and Sons");
    assert.equal((await parties.current(companyId, id))?.name, "Synthetic Traders and Sons", "no date means today");
  });

  test(`${label}: what was saved comes back exactly: paise, quantities, dates, lists, missing and empty values`, { skip }, async () => {
    const { h, companyId, add } = await shop();
    const data = {
      name: "Synthetic Wholesale", gstin: syntheticGstin("27", "AAAPS1234K"), creditLimitPaise: 9_007_199_254_740_993_123n,
      opening: { scaled: -1_500_000n, unit: "KGS" }, phones: ["+919800000001", "+919800000002"], expiresOn: "2027-03-31", active: false, note: null, ratedCapacityKg: 0,
    };
    const saved = await add("party", data, "2026-04-01");
    const expected = { id: saved.recordId, ...data, companyId };
    assert.deepEqual(saved.data, expected);
    assert.deepEqual((await h.store("party").history(companyId, saved.recordId))[0]?.data, expected);
    assert.deepEqual(await h.store("party").current(companyId, saved.recordId, "2026-04-01"), expected);
    assert.deepEqual(await h.store("party").list(companyId, "2026-04-01"), [expected]);
    const bare = await add("party", { name: "Synthetic Bare" });
    assert.deepEqual(Object.keys(bare.data).sort(), ["companyId", "id", "name"], "a field that was not given is not invented");
    assert.throws(() => { (saved.data as { name: string }).name = "tampered"; }, TypeError, "a stored version cannot be edited through what was read");
  });

  test(`${label}: a date that is not a date is refused`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const data = { id: crypto.randomUUID(), companyId, name: "Synthetic Traders" };
    for (const wrong of ["2026-4-1", "01/04/2026", ""]) {
      await assert.rejects(attempt(() => h.write(companyId, () => h.store("party").append(data, wrong, userId))), code("INVALID_TRANSITION"));
    }
    assert.deepEqual(await h.store("party").history(companyId, data.id), []);
  });

  test(`${label}: a list holds each record once as it stood on the date, in the order created, one kind at a time`, { skip }, async () => {
    const { h, companyId, add } = await shop();
    const soap = await add("item", { name: "Soap" }, "2026-04-01");
    const rice = await add("item", { name: "Rice" }, "2026-06-01");
    await add("item", { id: soap.recordId, name: "Soap 100g" }, "2026-05-01");
    await add("party", { name: "Synthetic Traders" }, "2026-04-01");
    const names = async (asOf?: string) => (await h.store("item").list(companyId, asOf)).map((item) => item.name);
    assert.deepEqual(await names("2026-03-31"), []);
    assert.deepEqual(await names("2026-04-15"), ["Soap"]);
    assert.deepEqual(await names("2026-06-01"), ["Soap 100g", "Rice"]);
    assert.deepEqual(await names(), ["Soap 100g", "Rice"]);
    assert.equal(await h.store("item").size(companyId), 2);
    assert.equal(await h.store("party").size(companyId), 1);
    assert.equal(await h.store("vehicle").size(companyId), 0);
    assert.deepEqual(await h.store("party").history(companyId, rice.recordId), [], "an item's id is not a party");
    assert.equal(await h.store("party").current(companyId, rice.recordId), null);
  });

  test(`${label}: pages return every row exactly once`, { skip }, async () => {
    const { h, companyId, add } = await shop();
    const ids: Id[] = [];
    for (let n = 0; n < 7; n += 1) ids.push((await add("item", { name: `Item ${n}` })).recordId);
    await add("item", { name: "Not yet" }, "2027-01-01");
    const seen: Id[] = [];
    for (let after: string | undefined, pages = 0; pages < 10; pages += 1) {
      const page = await h.store("item").list(companyId, "2026-12-31", { limit: 3, ...(after === undefined ? {} : { after }) });
      assert.ok(page.length <= 3);
      seen.push(...page.map((item) => item.id));
      if (page.length < 3) break;
      after = page.at(-1)?.id;
    }
    assert.deepEqual(seen, [...ids].sort(), "each record once, in id order");
    assert.equal((await h.store("item").list(companyId, "2026-12-31", { limit: 100 })).length, 7);

    const id = ids[0] as Id;
    for (let n = 2; n <= 5; n += 1) await add("item", { id, name: `Item 0 v${n}` });
    const versions: number[] = [];
    for (let after: string | undefined, pages = 0; pages < 10; pages += 1) {
      const page = await h.store("item").history(companyId, id, { limit: 2, ...(after === undefined ? {} : { after }) });
      versions.push(...page.map((version) => version.version));
      if (page.length < 2) break;
      after = String(page.at(-1)?.version);
    }
    assert.deepEqual(versions, [1, 2, 3, 4, 5]);
  });

  test(`${label}: changes arriving together are each recorded once`, { skip }, async () => {
    const { h, companyId, add } = await shop();
    const id = (await add("party", { name: "Synthetic Traders" })).recordId;
    const versions = await Promise.all([1, 2, 3, 4, 5].map((n) => add("party", { id, name: `Synthetic Traders ${n}` })));
    assert.deepEqual(versions.map((version) => version.version).sort(), [2, 3, 4, 5, 6]);
    assert.equal((await h.store("party").history(companyId, id)).length, 6);
  });

  test(`${label}: a record that does not exist is simply not there`, { skip }, async () => {
    const { h, companyId } = await shop();
    for (const id of [crypto.randomUUID(), "no-such-record"]) {
      assert.deepEqual(await h.store("party").history(companyId, id), []);
      assert.equal(await h.store("party").asOf(companyId, id, "9999-12-31"), null);
      assert.equal(await h.store("party").latest(companyId, id), null);
      assert.equal(await h.store("party").current(companyId, id), null);
    }
    assert.deepEqual(await h.store("party").list(companyId), []);
    assert.equal(await h.store("party").size(companyId), 0);
  });

  test(`${label}: one company cannot read or change another company's records`, { skip }, async () => {
    const a = await shop();
    const b = await shop();
    const parties = a.h.store("party");
    const mine = await a.add("party", { name: "Company A's supplier", creditLimitPaise: 500_000n });
    const id = mine.recordId;
    await hidden(() => parties.history(b.companyId, id));
    await hidden(() => parties.asOf(b.companyId, id, "9999-12-31"));
    await hidden(() => parties.latest(b.companyId, id));
    await hidden(() => parties.current(b.companyId, id));
    assert.deepEqual(await parties.list(b.companyId, "9999-12-31"), []);
    assert.equal(await parties.size(b.companyId), 0);
    await assert.rejects(attempt(() => b.add("party", { id, name: "Taken over" })), code("TENANT_ISOLATION"));
    assert.deepEqual(await parties.history(a.companyId, id), [mine], "nothing was added to company A's record");
    assert.deepEqual((await parties.list(a.companyId, "9999-12-31")).map((party) => party.name), ["Company A's supplier"]);
  });

  test(`${label}: a finished command remembers the record it wrote, per company`, { skip }, async () => {
    const a = await shop();
    const b = await shop();
    const index = a.h.commandIndex;
    const record = (await a.add("party", { name: "Synthetic Traders" })).recordId;
    const command = await a.h.command(a.companyId, a.userId);
    assert.equal(await index.get(a.companyId, command), undefined);
    await a.h.write(a.companyId, () => index.set(a.companyId, command, record));
    await a.h.write(a.companyId, () => index.set(a.companyId, command, record)); // the same thing said again is not an error
    assert.equal(await index.get(a.companyId, command), record);
    assert.equal(await index.get(b.companyId, command), undefined, "another company's command is not found");
    assert.equal(await index.get(a.companyId, crypto.randomUUID()), undefined);
    assert.equal(await index.get(a.companyId, "no-such-command"), undefined);
  });

  test(`${label}: units and exact conversions, per company and per item`, { skip }, async () => {
    const a = await shop();
    const b = await shop();
    const units = a.h.units(a.companyId);
    const write = <T>(work: () => Maybe<T>) => a.h.write(a.companyId, work);
    const soap = (await a.add("item", { name: "Soap" })).recordId;
    const tile = (await a.add("item", { name: "Tile" })).recordId;

    assert.equal((await units.unit("kgs")).name, "Kilograms", "the day-one units are there");
    assert.deepEqual(await units.convertExact(quantity("2", "QTL"), "KGS"), quantity("200", "KGS"));
    await assert.rejects(attempt(() => units.unit("CRATE")), code("UNKNOWN_UNIT"));
    await write(() => units.registerUnit({ code: "crate", name: "Crate", displayDecimals: 0 }));
    assert.deepEqual(await units.unit("Crate"), { code: "CRATE", name: "Crate", displayDecimals: 0 });
    await write(() => units.registerUnit({ code: "CRATE", name: "Plastic crate", displayDecimals: 1, uqc: "OTH" }));
    assert.deepEqual(await units.unit("CRATE"), { code: "CRATE", name: "Plastic crate", displayDecimals: 1, uqc: "OTH" }, "registering a unit again replaces it");
    assert.equal((await units.units()).filter((unit) => unit.code === "CRATE").length, 1);
    await assert.rejects(attempt(() => a.h.units(b.companyId).unit("CRATE")), code("UNKNOWN_UNIT"), "another company never set this unit up");

    await write(() => units.registerConversion({ fromUnit: "box", toUnit: "pcs", numerator: 24n, denominator: 1n, itemId: soap }));
    assert.deepEqual(await units.convertExact(quantity("10", "BOX"), "PCS", soap), quantity("240", "PCS"));
    assert.deepEqual(await units.factor("PCS", "BOX", soap), { numerator: 1n, denominator: 24n }, "and the other way round");
    assert.equal(await units.factor("BOX", "PCS", tile), null, "one item's box size never leaks to another item");
    assert.equal(await units.factor("BOX", "PCS"), null);
    assert.equal(await a.h.units(b.companyId).factor("BOX", "PCS", soap), null, "nor to another company");
    await assert.rejects(attempt(() => units.convert(quantity("1", "BOX"), "PCS", tile)), code("NO_CONVERSION_PATH"));

    // Said again the other way round, it replaces the first: one box is now 12 pieces.
    await write(() => units.registerConversion({ fromUnit: "PCS", toUnit: "BOX", numerator: 1n, denominator: 12n, itemId: soap }));
    assert.deepEqual(await units.factor("BOX", "PCS", soap), { numerator: 12n, denominator: 1n });
    await write(() => units.registerConversion({ fromUnit: "BOX", toUnit: "PCS", numerator: 36n, denominator: 1n, itemId: soap }));
    assert.deepEqual(await units.factor("BOX", "PCS", soap), { numerator: 36n, denominator: 1n });

    // A universal conversion, an item's own one winning over it, and a ratio too big for a float.
    await write(() => units.registerConversion({ fromUnit: "CRATE", toUnit: "PCS", numerator: 9_007_199_254_740_993n, denominator: 7n }));
    assert.deepEqual(await units.factor("CRATE", "PCS", tile), { numerator: 9_007_199_254_740_993n, denominator: 7n });
    await write(() => units.registerConversion({ fromUnit: "CRATE", toUnit: "PCS", numerator: 3n, denominator: 1n, itemId: tile }));
    assert.deepEqual(await units.factor("CRATE", "PCS", tile), { numerator: 3n, denominator: 1n });
    assert.deepEqual(await units.convert(quantity("1", "PCS"), "CRATE", tile), { quantity: { scaled: 333_333n, unit: "CRATE" }, exact: false });
    await assert.rejects(attempt(() => units.convertExact(quantity("1", "PCS"), "CRATE", tile)), code("INEXACT_CONVERSION"));

    await assert.rejects(attempt(() => write(() => units.registerConversion({ fromUnit: "BOX", toUnit: "PALLET", numerator: 1n, denominator: 1n }))), code("UNKNOWN_UNIT"));
    await assert.rejects(attempt(() => write(() => units.registerConversion({ fromUnit: "BOX", toUnit: "BAG", numerator: 0n, denominator: 1n }))), code("INEXACT_CONVERSION"));
    assert.equal(await units.factor("BOX", "BAG"), null, "a refused conversion was not saved");

    const all = (await units.units()).map((unit) => unit.code);
    const seen: string[] = [];
    for (let after: string | undefined, pages = 0; pages < 20; pages += 1) {
      const page = await units.units({ limit: 4, ...(after === undefined ? {} : { after }) });
      seen.push(...page.map((unit) => unit.code));
      if (page.length < 4) break;
      after = page.at(-1)?.code;
    }
    assert.deepEqual(seen, [...all].sort(), "pages of units return every unit once, in code order");
  });
}
