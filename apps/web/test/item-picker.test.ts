/**
 * Issue #308 — the item picker's search: name, other names in Hindi, short code, HSN and barcode,
 * typo-tolerant, most-sold first, and fast enough for a thousand items on a phone.
 */
import assert from "node:assert/strict";
import test from "node:test";

const picker = await import(new URL("../item-picker.js", import.meta.url).href) as Record<string, any>;
const { searchItems, findByCode, looksLikeCode } = picker;

const item = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, hsnSac: "34011190", unit: "PCS", ratePercent: 18, code: null, barcodes: [], aliases: [], price: null, ...extra });
const ITEMS = [
  item("soap", "Herbal Bath Soap 100g", { barcodes: ["8901030865278"], aliases: ["हर्बल साबुन"], code: "HBS100" }),
  item("soap-2", "Neem Soap 75g", { barcodes: ["8901030000011"] }),
  item("tmt", "TMT Steel Bar 12mm", { hsnSac: "72142090", unit: "KGS" }),
  item("rice", "Sona Masoori Rice", { hsnSac: "10063020", unit: "KGS", aliases: ["चावल"] }),
  item("soup", "Tomato Soup Mix", { hsnSac: "21041010" }),
];
const names = (found: Array<{ id: string }>) => found.map((row) => row.id);

test("#308: search by name, short code, HSN, barcode and Hindi name", () => {
  assert.equal(searchItems(ITEMS, "herbal")[0].id, "soap");
  assert.equal(searchItems(ITEMS, "HBS100")[0].id, "soap", "short code");
  assert.equal(searchItems(ITEMS, "7214")[0].id, "tmt", "HSN");
  assert.equal(searchItems(ITEMS, "8901030865278")[0].id, "soap", "barcode");
  assert.equal(searchItems(ITEMS, "साबुन")[0].id, "soap", "Hindi name");
  assert.equal(searchItems(ITEMS, "चावल")[0].id, "rice");
  assert.equal(searchItems(ITEMS, "steel bar")[0].id, "tmt", "two words");
});

test("#308: forgiving of typos — 'sop' finds soap, 'saop' too, 'stel' finds steel", () => {
  assert.ok(names(searchItems(ITEMS, "sop")).includes("soap"));
  assert.ok(names(searchItems(ITEMS, "saop")).includes("soap"));
  assert.ok(names(searchItems(ITEMS, "stel")).includes("tmt"));
  assert.deepEqual(searchItems(ITEMS, "zzzz"), []);
});

test("#308: most-sold first among equal matches, and an empty box lists the most-sold", () => {
  assert.deepEqual(names(searchItems(ITEMS, "soap")), ["soap", "soap-2", "soup"], "alphabetical when nothing is sold yet; the near miss last");
  assert.deepEqual(names(searchItems(ITEMS, "soap", { sold: { "soap-2": 9, soap: 2, soup: 50 } })), ["soap-2", "soap", "soup"], "a near miss never outranks a real match, however well it sells");
  assert.equal(searchItems(ITEMS, "", { sold: { rice: 5 } })[0].id, "rice");
  assert.equal(searchItems(ITEMS, "", { limit: 3 }).length, 3);
});

test("#308: a barcode finds exactly one item; an unknown one is offered as a new item", () => {
  assert.equal(findByCode(ITEMS, " 8901030000011 ").id, "soap-2");
  assert.equal(findByCode(ITEMS, "hbs100").id, "soap");
  assert.equal(findByCode(ITEMS, "8900000000000"), null);
  assert.equal(looksLikeCode("8900000000000"), true);
  assert.equal(looksLikeCode("soap"), false);
});

test("#308: 1,000 items answer in under 100 ms", () => {
  const words = ["Herbal", "Neem", "Rose", "Steel", "Rice", "Dal", "Atta", "Oil", "Soap", "Shampoo", "Biscuit", "Tea", "Sugar", "Salt", "Cement"];
  const many = Array.from({ length: 1000 }, (_, index) => item(`i${index}`, `${words[index % 15]} ${words[(index * 7) % 15]} ${index}g`, {
    hsnSac: String(10000000 + index * 97), barcodes: [String(8901000000000 + index)], aliases: index % 3 === 0 ? ["साबुन"] : [],
  }));
  const sold = Object.fromEntries(many.map((row, index) => [row.id, index % 17]));
  searchItems(many, "warm up", { sold });
  // Every keystroke of a few searches, typos included, the way a person types them.
  for (const query of ["s", "so", "soa", "soap", "sop", "nem oil", "8901000000999", "1000", "साबुन", "rise"]) {
    const started = performance.now();
    const found = searchItems(many, query, { sold });
    const took = performance.now() - started;
    assert.ok(took < 100, `"${query}" took ${took.toFixed(1)} ms`);
    assert.ok(found.length > 0, `"${query}" found something`);
  }
  assert.equal(searchItems(many, "8901000000999", { sold })[0].id, "i999");
});
