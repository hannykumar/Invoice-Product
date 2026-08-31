import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { loadWebAsset } from "../server.ts";

const root = resolve(import.meta.dirname, "..");
const read = (name: string) => readFile(resolve(root, name), "utf8");

async function localeCopy(): Promise<Record<string, Record<string, string>>> {
  const source = await read("app.js");
  const literal = source.slice(source.indexOf("const copy = ") + "const copy = ".length, source.indexOf(";\n\nconst storage"));
  return vm.runInNewContext(`(${literal})`) as Record<string, Record<string, string>>;
}

test("every visible and screen-reader translation key exists in English and Hindi", async () => {
  const [html, locales] = await Promise.all([read("index.html"), localeCopy()]);
  const keys = [...html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(keys.length > 70);
  assert.deepEqual(Object.keys(locales).sort(), ["en-IN", "hi-IN"]);
  for (const key of keys) {
    assert.ok(locales["en-IN"]?.[key], `Missing English translation: ${key}`);
    assert.ok(locales["hi-IN"]?.[key], `Missing Hindi translation: ${key}`);
  }
  assert.deepEqual(Object.keys(locales["en-IN"]!).sort(), Object.keys(locales["hi-IN"]!).sort());
});

test("critical runtime states have distinct English and Hindi wording", async () => {
  const locales = await localeCopy();
  for (const key of ["loginTitle", "signOut", "saleChecked", "purchaseChecked", "paymentChecked", "draftRestored", "nothingSaved", "physicalBalance", "recordOnce"]) {
    assert.notEqual(locales["en-IN"]?.[key], locales["hi-IN"]?.[key], `${key} must not fall back to English`);
  }
  assert.match(locales["en-IN"]!.physicalBalance!, /\{location\}/);
  assert.match(locales["hi-IN"]!.saleCheckedBody!, /\{amount\}/);
});

test("transaction screens are semantic, labelled and safe to review", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  for (const flow of ["sale", "purchase", "payment"]) {
    assert.match(html, new RegExp(`<form[^>]+data-draft="${flow}"`));
    assert.match(html, new RegExp(`id="view-${flow}"[^>]+aria-labelledby=`));
    assert.match(script, new RegExp(`karobar\\.draft\\.\\$\\{form\\.dataset\\.draft\\}`));
  }
  assert.match(html, /role="status"/);
  assert.match(html, /<dialog[^>]+aria-labelledby=/);
  assert.match(script, /Intl\.NumberFormat\(state\.locale/);
  assert.match(script, /Intl\.DateTimeFormat\(state\.locale/);
  assert.match(script, /\/api\/\$\{form\.dataset\.draft\}s\/preview/);
  assert.match(script, /\/api\/\$\{state\.pendingForm\.dataset\.draft\}s\/record/);
  assert.match(script, /Nothing was saved/);
  assert.match(script, /Record once/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="view-returns"[^>]+aria-labelledby=/);
  assert.match(html, /id="return-form"/);
  assert.match(html, /id="return-document"/);
  assert.match(html, /id="return-line"/);
  assert.match(script, /\/api\/returns\/preview/);
  assert.match(script, /\/api\/returns\/record/);
  assert.match(script, /localizeReturnResult/);
  assert.match(script, /authorization: `Bearer \$\{state\.sessionId\}`/);
  assert.match(script, /\/api\/auth\/login/);
  assert.match(script, /karobar\.session/);
  assert.match(script, /text\("physicalBalance", \{ location: data\.company\.location \}\)/);
  assert.match(script, /copy\[state\.locale\]\.demoTitle/);
  assert.match(script, /setFormBusy\(form, true\)/);
  assert.match(script, /draftRestored/);
  assert.match(script, /customerDocumentsOne/);
  assert.match(script, /copy\[state\.locale\]\.loginInvalid/);
  assert.doesNotMatch(script, /subtotal \* \.05/);
  assert.match(script, /data-calculated="tax"\]\'\)\.textContent = "—"/);
  assert.match(script, /localizeResult\(result, form\.dataset\.draft, "preview"\)/);
  assert.match(script, /form\.setAttribute\("aria-busy", String\(busy\)\)/);
  assert.match(script, /cancel\.disabled = mode === "loading"/);
  assert.match(script, /dialog\.setAttribute\("aria-busy", String\(mode === "loading"\)\)/);
  assert.ok(script.indexOf("setFormBusy(form, true)") < script.indexOf("await api(`/api/${form.dataset.draft}s/preview`"));
  assert.match(html, /aria-describedby="login-help"/);
  assert.match(html, /aria-describedby="review-body"/);
  assert.match(html, /id="view-bank-feeds"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/bank-feeds\/consent/);
  assert.match(script, /\/api\/bank-feeds\/sync/);
  assert.match(script, /\/api\/bank-feeds\/disconnect/);
  assert.match(html, /id="view-reminders"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/reminders\/send/);
  assert.match(html, /id="view-operations"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/operations/);
  assert.match(script, /dataReplayJob|replayJob/);
  assert.match(html, /id="view-vehicle"[^>]+aria-labelledby=/);
  assert.match(script, /\/api\/vehicles\/check/);
  assert.match(script, /\/api\/vehicles\/check\/override/);
  // One focusable heading per screen. Issues #28 and #41 add vehicle and operations screens.
  assert.equal((html.match(/<h1[^>]+tabindex="-1"/g) ?? []).length, 16);
});

test("responsive CSS includes phone navigation, reduced motion and visible focus", async () => {
  const css = await read("styles.css");
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.bottom-nav \{ position: fixed; display: grid/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /outline:\s*none/);
  assert.doesNotMatch(css, /\.save-state \{ display: none/);
  assert.match(css, /\.topbar-actions \.user-avatar \{ display: none/);
  assert.match(css, /\.bottom-nav \{[^}]*grid-auto-flow: column; grid-auto-columns: minmax\(68px, 1fr\);[^}]*overflow-x: auto/);
  assert.match(css, /\.bottom-nav button small \{[^}]*text-overflow: ellipsis/);
});

test("the local web preview serves the application shell", async () => {
  const asset = await loadWebAsset("/");
  assert.equal(asset.status, 200);
  assert.match(asset.contentType, /text\/html/);
  assert.match(asset.body.toString("utf8"), /id="view-dashboard"/);
  assert.equal((await loadWebAsset("/../../private-file")).status, 403);
});
