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

/** Just enough of a page for the camera button: elements that record what was done to them. */
const fakePage = () => {
  const made: any[] = [];
  const element = (tag: string) => {
    const listeners: Record<string, Array<() => unknown>> = {};
    const node: any = {
      tag, attributes: {} as Record<string, string>, children: [] as any[], removed: false, opened: false, placedAfter: null,
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(type: string, listener: () => unknown) { (listeners[type] ??= []).push(listener); },
      fire(type: string) { return Promise.all((listeners[type] ?? []).map((listener) => listener())); },
      append(...nodes: any[]) { this.children.push(...nodes); },
      after(other: any) { other.placedAfter = this; },
      showModal() { this.opened = true; }, close() { this.opened = false; }, remove() { this.removed = true; },
      play: async () => undefined,
    };
    made.push(node);
    return node;
  };
  return { made, doc: { createElement: element, body: element("body") } };
};

const WORDS = () => ({ scan: "Scan", scanTitle: "Scan a barcode with the camera", scanHint: "Hold the barcode in front of the camera", scanCancel: "Cancel" });

test("#308: without BarcodeDetector or a camera there is no Scan button, and nothing is added to the page", () => {
  const { cameraScanAvailable, addScanButton } = picker;
  const input = { closest: () => null, after: () => { throw new Error("nothing may be placed"); } };
  const noPage = { createElement: () => { throw new Error("nothing may be made"); } };
  for (const env of [{}, { navigator: { mediaDevices: { getUserMedia() {} } } }, { BarcodeDetector: class {}, navigator: {} }]) {
    assert.equal(cameraScanAvailable(env), false);
    assert.equal(addScanButton(input, { env, doc: noPage, words: WORDS, onCode: () => assert.fail("no scan") }), null);
  }
  assert.equal(cameraScanAvailable({ BarcodeDetector: class {}, navigator: { mediaDevices: { getUserMedia() {} } } }), true);
});

test("#308: the camera's barcode goes down the same path as a typed one, and the camera is switched off", async () => {
  const { addScanButton } = picker;
  const { made, doc } = fakePage();
  let frames = 0;
  const stopped: string[] = [];
  const env = {
    BarcodeDetector: class {
      static async getSupportedFormats() { return ["ean_13", "code_128"]; }
      async detect() { frames += 1; return frames < 3 ? [] : [{ rawValue: "8901030865278" }]; }
    },
    navigator: { mediaDevices: { async getUserMedia(wanted: any) { assert.equal(wanted.video.facingMode, "environment"); return { getTracks: () => [{ stop: () => stopped.push("video") }] }; } } },
  };
  const label = { after(other: any) { other.placedAfter = label; } };
  const codes: string[] = [];
  const button = addScanButton({ closest: () => label }, { env, doc, words: WORDS, onCode: (code: string) => codes.push(code) });
  assert.equal(button.textContent, "Scan");
  assert.equal(button.attributes["aria-label"], "Scan a barcode with the camera");
  assert.equal(button.placedAfter, label, "beside the search box");
  await button.fire("click");
  assert.deepEqual(codes, ["8901030865278"]);
  assert.equal(frames, 3, "frames are read until one carries a barcode");
  assert.deepEqual(stopped, ["video"], "the camera is off again");
  assert.equal(made.find((node) => node.tag === "dialog").removed, true);

  // The person cancels: nothing is scanned, and the camera still goes off.
  const cancelled = fakePage();
  const env2 = { ...env, BarcodeDetector: class { async detect() { return []; } } };
  const second = addScanButton({ closest: () => label }, { env: env2, doc: cancelled.doc, words: WORDS, onCode: () => assert.fail("nothing was scanned") });
  const clicked = second.fire("click");
  await new Promise((done) => setTimeout(done, 20));
  await cancelled.made.find((node) => node.tag === "button" && node.textContent === "Cancel").fire("click");
  await clicked;
  assert.deepEqual(stopped, ["video", "video"]);

  // The camera refused: the screen is told, and nothing is scanned.
  const refused: unknown[] = [];
  const env3 = { ...env, navigator: { mediaDevices: { async getUserMedia() { throw new Error("NotAllowedError"); } } } };
  const third = addScanButton({ closest: () => label }, { env: env3, doc: fakePage().doc, words: WORDS, onCode: () => assert.fail("nothing was scanned"), onError: (error: unknown) => refused.push(error) });
  await third.fire("click");
  assert.equal(refused.length, 1);
});
