/**
 * Issue #399 — every frame that shows a printed bill is sandboxed. A bill is drawn through
 * `srcdoc`, which would otherwise run on the app's own origin next to the sign-in. Without
 * `allow-scripts` nothing inside the frame can run, so one missed `escapeHtml` in a template
 * cannot act as the shopkeeper even if the content policy were ever loosened. `allow-same-origin`
 * stays only so the page can call `contentWindow.print()`, and `allow-modals` so that print runs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (name: string) => readFile(resolve(root, name), "utf8");
const BILL_FRAME_SANDBOX = ["allow-modals", "allow-same-origin"];

function frameTags(html: string): string[] {
  return [...html.matchAll(/<iframe\b[^>]*>/g)].map((match) => match[0]);
}

function sandboxTokens(tag: string): string[] | undefined {
  const value = /\ssandbox="([^"]*)"/.exec(tag)?.[1];
  return value === undefined ? undefined : value.split(/\s+/).filter(Boolean).sort();
}

/** The frame tag a selector in app.js picks out: `#id` or `[data-attribute]`. */
function frameFor(tags: string[], selector: string): string | undefined {
  const id = /^#([\w-]+)$/.exec(selector)?.[1];
  if (id) return tags.find((tag) => new RegExp(`\\sid="${id}"`).test(tag));
  const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
  if (attribute) return tags.find((tag) => new RegExp(`\\s${attribute}(?=[\\s>=])`).test(tag));
  return undefined;
}

/** Every selector whose frame app.js fills with `srcdoc` or prints through `contentWindow`. */
function framesUsedByScript(script: string): string[] {
  const lines = script.split("\n");
  const selectors = new Set<string>();
  lines.forEach((line, index) => {
    if (!/\.srcdoc\s*=|\.contentWindow\b/.test(line)) return;
    for (const match of line.matchAll(/querySelector\("([^"]+)"\)\??\.(?:srcdoc|contentWindow)/g)) selectors.add(match[1]!);
    for (const match of line.matchAll(/\b(\w+)\??\.(?:srcdoc|contentWindow)\b/g)) {
      const name = match[1]!;
      const declaration = lines.slice(Math.max(0, index - 40), index + 1).reverse()
        .map((earlier) => new RegExp(`const ${name} = document\\.querySelector\\("([^"]+)"\\)`).exec(earlier)?.[1])
        .find(Boolean);
      if (declaration) selectors.add(declaration);
      else if (!line.includes(`querySelector`)) assert.fail(`app.js line ${index + 1} uses a frame whose selector this test cannot find: ${line.trim()}`);
    }
  });
  return [...selectors];
}

test("every printed-bill frame carries the sandbox, and none can run script", async () => {
  const tags = frameTags(await read("index.html"));
  assert.ok(tags.length >= 10, `expected every bill frame, found ${tags.length}`);
  for (const tag of tags) {
    assert.deepEqual(sandboxTokens(tag), BILL_FRAME_SANDBOX, `frame without the bill sandbox: ${tag}`);
    assert.doesNotMatch(tag, /allow-scripts|allow-popups|allow-forms|allow-top-navigation/, tag);
  }
});

test("every frame app.js fills or prints is one of the sandboxed frames in the page", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  const tags = frameTags(html);
  const selectors = framesUsedByScript(script);
  for (const expected of ["#sale-bill-frame", "#sale-bill-copies", "[data-voucher-frame]", "[data-self-invoice-frame]", "#note-frame", "#presale-frame", "#challan-frame", "#eway-print-frame", "#branding-preview"]) {
    assert.ok(selectors.includes(expected), `app.js no longer uses ${expected}; update this test`);
  }
  for (const selector of selectors) {
    const tag = frameFor(tags, selector);
    assert.ok(tag, `${selector} is filled or printed by app.js but is not a frame in index.html`);
    assert.deepEqual(sandboxTokens(tag), BILL_FRAME_SANDBOX, `${selector} is not sandboxed`);
  }
});

test("app.js never makes its own frame or loosens a frame's sandbox", async () => {
  const script = await read("app.js");
  assert.doesNotMatch(script, /createElement\(\s*["'`]iframe/i);
  assert.doesNotMatch(script, /\.sandbox\b|["'`]sandbox["'`]/);
});
