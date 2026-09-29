/**
 * Issue #308 — find an item fast: one box that searches name, other names (Hindi too), short code,
 * HSN and barcode as you type, most-sold first, forgiving of typos ("sop" finds soap), and a
 * keyboard-wedge barcode scanner that adds the item in one step.
 *
 * Loaded by index.html before app.js and published as `globalThis.KarobarItemPicker`, so any screen
 * (the Sale form today, the four-slide sale of #305 next) mounts it the same way:
 *
 *   const picker = KarobarItemPicker.createItemPicker({
 *     input,                         // an <input>; it becomes an ARIA combobox and gets a listbox
 *     items: () => catalogue.items,  // [{ id, name, hsnSac, unit, code, barcodes, aliases, price, ratePercent }]
 *     sold: () => ({ [itemId]: n }), // bills each item went on; more sold ranks first
 *     words: () => ({ newItem: "+ New item", newItemCode: "+ New item with barcode {code}", noMatch: "…" }),
 *     onPick(item) {},               // chosen with a click, tap or Enter
 *     onScan(item) {},               // a barcode typed or scanned that matches one item exactly
 *     onCreate({ name, barcode }) {},// "+ New item", with what was typed filled in
 *   });
 *   picker.show(item | null);       // what the box shows when it is not being typed in
 *
 *   KarobarItemPicker.listenForScanner(document, (code) => …) // a scan with no box focused
 *
 * Nothing here talks to the server or knows about bills: it searches the list it is given.
 */

/** Lower case, one space between words, punctuation gone; Devanagari letters and their marks kept. */
export const normalise = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

const compact = (text) => normalise(text).replaceAll(" ", "");

const prepared = new WeakMap();
/** What one item is searched by, worked out once per item object. */
function fieldsOf(item) {
  let fields = prepared.get(item);
  if (fields) return fields;
  const text = [item.name, ...(item.aliases ?? [])].map(normalise).join(" ");
  fields = {
    text,
    words: text.split(" ").filter(Boolean),
    codes: [item.code, ...(item.barcodes ?? [])].filter(Boolean).map(compact),
    hsn: compact(item.hsnSac),
  };
  prepared.set(item, fields);
  return fields;
}

/** True when `word` holds the letters of `token` in order and starts with its first letter ("sop" → "soap"). */
const inOrder = (token, word) => {
  if (token[0] !== word[0]) return false;
  let at = 0;
  for (const letter of word) if (letter === token[at]) at += 1;
  return at >= token.length;
};

/** True when `a` and `b` differ by at most one letter wrong, missing, extra or swapped. Linear time. */
const withinOne = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return true;
  const rest = (from, to) => a.slice(from) === b.slice(to);
  return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2));
};

/** One slip against the start of `word` ("saop" → "soap"); only for three letters or more. */
const oneSlip = (token, word) => token.length >= 3
  && [token.length - 1, token.length, token.length + 1].some((length) => length <= word.length && withinOne(token, word.slice(0, length)));

/** How well one query word matches the item's words: 3 starts a word, 2 is inside one, 1 is a near miss. */
const tokenScore = (token, words) => {
  let best = 0;
  for (const word of words) {
    if (word.startsWith(token)) return 3;
    if (word.includes(token)) best = Math.max(best, 2);
    else if (best < 1 && (inOrder(token, word) || oneSlip(token, word))) best = 1;
  }
  return best;
};

/** The query worked out once, not once per item. */
const queryOf = (query) => {
  const q = normalise(query);
  return { q, code: q.replaceAll(" ", ""), tokens: q.split(" ") };
};

/** How well an item answers the query; 0 means not at all. */
export function scoreItem(item, query) {
  const { q, code, tokens } = typeof query === "string" ? queryOf(query) : query;
  if (q === "") return 1;
  const fields = fieldsOf(item);
  if (fields.codes.includes(code)) return 100;
  if (code.length >= 3 && fields.codes.some((known) => known.startsWith(code))) return 75;
  if (/^\d{2,}$/.test(code) && fields.hsn.startsWith(code)) return 60;
  if (fields.text.startsWith(q)) return 90;
  let worst = 3;
  for (const token of tokens) {
    worst = Math.min(worst, tokenScore(token, fields.words));
    if (worst === 0) return 0;
  }
  return [0, 40, 65, 80][worst];
}

/**
 * The items that answer `query`, best first; among equals, the one sold on most bills first, then by
 * name. An empty query lists the most-sold items.
 */
export function searchItems(items, query, { sold = {}, limit = 8 } = {}) {
  const found = [];
  const prepared = queryOf(query);
  for (const item of items) {
    const score = scoreItem(item, prepared);
    if (score > 0) found.push({ item, score, sold: sold[item.id] ?? 0 });
  }
  found.sort((a, b) => b.score - a.score || b.sold - a.sold || a.item.name.localeCompare(b.item.name));
  return found.slice(0, limit).map((entry) => entry.item);
}

/** The one item whose barcode or short code is exactly this, or null. */
export function findByCode(items, code) {
  const wanted = compact(code);
  if (wanted === "") return null;
  return items.find((item) => fieldsOf(item).codes.includes(wanted)) ?? null;
}

/** Looks like something a scanner types: letters and digits only, at least six, at least one digit. */
export const looksLikeCode = (text) => /^[A-Za-z0-9-]{6,48}$/.test(String(text).trim()) && /\d/.test(String(text));

let pickers = 0;

/** Turns an input into an accessible combobox over the item list. See the top of this file. */
export function createItemPicker({ input, items, sold = () => ({}), words, onPick, onScan = onPick, onCreate = () => {} }) {
  pickers += 1;
  const list = document.createElement("ul");
  list.id = `item-picker-list-${pickers}`;
  list.className = "item-picker-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  // Beside the box's own label, never inside it: a list is not part of a label.
  (input.closest("label") ?? input).after(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  input.autocomplete = "off";
  input.spellcheck = false;

  let shown = null;
  let options = [];
  let active = -1;

  const label = (item) => [item.name, item.hsnSac, item.unit].filter(Boolean).join(" · ");
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const restore = () => { input.value = shown?.name ?? ""; };
  const highlight = (index) => {
    active = index;
    [...list.children].forEach((row, at) => row.setAttribute("aria-selected", String(at === index)));
    const row = list.children[index];
    if (row) { input.setAttribute("aria-activedescendant", row.id); row.scrollIntoView?.({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const choose = (option) => {
    close();
    if (option.create) { restore(); onCreate(option.create); return; }
    shown = option.item;
    restore();
    onPick(option.item);
  };

  const render = () => {
    const query = input.value;
    const text = words();
    const found = searchItems(items(), query, { sold: sold() });
    options = found.map((item) => ({ item }));
    const typed = query.trim();
    if (typed !== "") {
      options.push({ create: looksLikeCode(typed) ? { name: "", barcode: typed } : { name: typed, barcode: "" } });
    }
    list.replaceChildren(...options.map((option, index) => {
      const row = document.createElement("li");
      row.id = `${list.id}-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      if (option.create) {
        row.className = "item-picker-new";
        row.textContent = option.create.barcode ? text.newItemCode.replace("{code}", option.create.barcode) : text.newItem;
      } else {
        const name = document.createElement("strong");
        name.textContent = option.item.name;
        const detail = document.createElement("small");
        detail.textContent = [option.item.hsnSac, option.item.unit, option.item.ratePercent === null || option.item.ratePercent === undefined ? null : `${option.item.ratePercent}%`].filter(Boolean).join(" · ");
        row.append(name, detail);
      }
      // mousedown, not click: the box must not lose the choice to its own blur.
      row.addEventListener("mousedown", (event) => { event.preventDefault(); choose(option); });
      return row;
    }));
    if (options.length === 0) {
      const empty = document.createElement("li");
      empty.className = "item-picker-empty";
      empty.textContent = text.noMatch;
      list.append(empty);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(options.length > 0 && !options[0].create ? 0 : -1);
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", () => input.select?.());
  input.addEventListener("blur", () => { close(); restore(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) { render(); return; }
      const count = options.length;
      if (count === 0) return;
      highlight(((active < 0 ? (event.key === "ArrowDown" ? -1 : 0) : active) + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (event.key === "Escape") {
      if (!list.hidden) { event.preventDefault(); close(); restore(); }
    } else if (event.key === "Enter") {
      // A scanner types the code and presses Enter: an exact barcode adds the item in one step.
      const scanned = findByCode(items(), input.value);
      if (scanned) { event.preventDefault(); close(); restore(); onScan(scanned); return; }
      if (list.hidden) return;
      event.preventDefault();
      const option = options[active] ?? (options.length === 1 ? options[0] : null);
      if (option) choose(option);
    } else if (event.key === "Tab" && !list.hidden && options[active]?.item) {
      choose(options[active]);
    }
  });

  return {
    input,
    list,
    /** What the box shows when nobody is typing: the chosen item's name, or nothing. */
    show(item) { shown = item ?? null; if (document.activeElement !== input || list.hidden) restore(); },
    close,
  };
}

/**
 * A keyboard-wedge scanner, heard when no text box has the focus: characters arriving faster than a
 * person types, ending in Enter. `onCode` gets what was scanned. Returns a function that stops it.
 */
export function listenForScanner(target, onCode, { gap = 50, minLength = 6 } = {}) {
  let buffer = "";
  let last = 0;
  const typing = (element) => element instanceof HTMLElement && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
  const listener = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    const now = event.timeStamp || Date.now();
    if (now - last > gap) buffer = "";
    last = now;
    if (event.key === "Enter") {
      if (buffer.length >= minLength) { event.preventDefault(); onCode(buffer); }
      buffer = "";
    } else if (event.key.length === 1) buffer += event.key;
  };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}

globalThis.KarobarItemPicker = { normalise, scoreItem, searchItems, findByCode, looksLikeCode, createItemPicker, listenForScanner };
