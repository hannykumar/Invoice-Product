/**
 * Issue #353 — the markup rules behind "every screen handles loading, empty, error and success".
 * The behaviour itself (skeletons, Try again, focus, announcements, contrast, keyboard) is driven in a
 * real browser by tests/browser/screen-states.spec.ts and accessibility.spec.ts; this file holds the
 * rules that need no browser, so `npm test` fails at once when a screen is added without them.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { loadWebAsset } from "../server.ts";

const root = resolve(import.meta.dirname, "..");
const read = (name: string) => readFile(resolve(root, name), "utf8");

const sections = (html: string) => [...html.matchAll(/<section class="view[^"]*" id="view-([\w-]+)"([^>]*)>([\s\S]*?)(?=<section class="view|<template|<dialog|<\/main>)/g)]
  .map((match) => ({ id: match[1]!, attributes: match[2]!, body: match[3]! }));

test("every screen says what kind it is, and only a data screen carries a state region (#353)", async () => {
  const views = sections(await read("index.html"));
  assert.ok(views.length > 25, "the check must see every screen");
  for (const view of views) {
    const kind = /data-screen="(data|form|static)"/.exec(view.attributes)?.[1];
    assert.ok(kind, `view-${view.id} needs data-screen="data|form|static": say whether it reads data, takes input, or is fixed`);
    const regions = [...view.body.matchAll(new RegExp(`<div class="screen-state" id="screen-state-${view.id}" data-state-region>`, "g"))].length;
    assert.equal(regions, kind === "data" ? 1 : 0, `view-${view.id} (${kind}): a data screen has one state region with id screen-state-${view.id}; the others have none`);
  }
});

test("the state helper loads before the app, and the page has its two announcement regions (#353)", async () => {
  const html = await read("index.html");
  assert.ok(html.indexOf('src="/states.js"') > 0 && html.indexOf('src="/states.js"') < html.indexOf('src="/app.js"'));
  assert.match(html, /id="announce-polite" role="status" aria-live="polite"/);
  assert.match(html, /id="announce-urgent" role="alert" aria-live="assertive"/);
  assert.match(html, /class="skip-link" href="#main"/);
});

test("every word the four states use exists in English and Hindi (#353)", async () => {
  const source = await read("app.js");
  const literal = source.slice(source.indexOf("const copy = ") + "const copy = ".length, source.indexOf(";\n\nconst storage"));
  const locales = vm.runInNewContext(`(${literal})`) as Record<string, Record<string, string>>;
  const used = new Set([...(await read("states.js")).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/words\.(\w+)/g)].map((match) => match[1]!));
  assert.ok(used.has("stateRetry") && used.has("stateOffline") && used.has("stateServerProblem") && used.has("stateLoading"));
  for (const key of used) for (const locale of ["en-IN", "hi-IN"]) assert.ok(locales[locale]?.[key], `${locale} is missing "${key}"`);
  // A refusal must never read as a developer's note.
  for (const locale of ["en-IN", "hi-IN"]) for (const key of ["stateOffline", "stateServerProblem", "stateGenericProblem"]) assert.doesNotMatch(locales[locale]![key]!, /\b(?:50\d|404|stack|exception|undefined|fetch)\b/i);
});

test("/design opens the same shell, which shows the design screen (#353)", async () => {
  const design = await loadWebAsset("/design");
  const home = await loadWebAsset("/");
  assert.equal(design.status, 200);
  assert.equal(design.contentType, "text/html; charset=utf-8");
  assert.deepEqual(design.body, home.body);
  assert.equal((await loadWebAsset("/design/anything")).status, 404);
});
