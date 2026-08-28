import assert from "node:assert/strict";
import test from "node:test";
import { checkForDuplicates, findMatches, nameScore, normaliseName, resolveByName } from "../src/index.ts";

const parties = [
  { name: "ABC Traders", gstins: ["29AABCA1234C1ZP"], phones: ["9845012345"], code: "ABC" },
  { name: "Shree Ram Steels Private Limited", aliases: ["Shree Ram Steels"], phones: ["9822011122"], code: "SRS" },
  { name: "Ravi Traders", phones: ["9886000000"], code: "RVT" },
  { name: "Nandini Provision Stores", phones: ["9880098800"], code: "NPT" },
];

test("legal-form words and punctuation do not change a name's identity", () => {
  assert.equal(normaliseName("Shree Ram Steels Pvt. Ltd."), normaliseName("Shree Ram Steels"));
  assert.equal(normaliseName("M/s ABC Traders & Co."), normaliseName("ABC Traders"));
  assert.equal(nameScore("ABC Traders Pvt Ltd", "ABC Traders"), 1);
});

test("a repeat GSTIN blocks a second record even when the name is different", () => {
  const verdict = checkForDuplicates(parties, { name: "A B C Trading Company", gstins: ["29AABCA1234C1ZP"] });
  assert.equal(verdict.decision, "block");
  assert.equal(verdict.decision === "block" && verdict.candidates[0]?.reasons[0]?.code, "SAME_GSTIN");
});

test("the same phone number blocks a duplicate party", () => {
  const verdict = checkForDuplicates(parties, { name: "Nandini Stores Mysore", phones: ["+91 98800 98800"] });
  assert.equal(verdict.decision, "block");
});

test("a genuinely new business is clear", () => {
  assert.equal(checkForDuplicates(parties, { name: "Kaveri Hardware Mart", phones: ["9000011111"] }).decision, "clear");
});

test("a near-identical name warns instead of silently creating a twin", () => {
  const verdict = checkForDuplicates(parties, { name: "ABC Trader" });
  assert.notEqual(verdict.decision, "clear");
  assert.equal(verdict.decision !== "clear" && verdict.candidates[0]?.record.name, "ABC Traders");
});

test("similar names never silently resolve to the wrong party", () => {
  // "Traders" alone is shared by two records, so the product must ask.
  const ambiguous = resolveByName(parties, "Traders");
  assert.notEqual(ambiguous.status, "resolved");
  const resolved = resolveByName(parties, "ABC Traders");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.status === "resolved" && resolved.record.code, "ABC");
});

test("an alias resolves to its owning record", () => {
  const outcome = resolveByName(parties, "Shree Ram Steels");
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.status === "resolved" && outcome.record.code, "SRS");
});

test("an unknown name is reported as not found rather than mapped to the closest row", () => {
  assert.equal(resolveByName(parties, "Zenith Polymers").status, "not_found");
});

test("matches are returned strongest first with readable reasons", () => {
  const matches = findMatches(parties, { name: "ABC Traders", phones: ["9845012345"] });
  assert.equal(matches[0]?.record.code, "ABC");
  assert.ok(matches[0]?.reasons.some((reason) => reason.detail.includes("9845012345")));
});
