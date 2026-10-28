/**
 * Issue #353 — one way for every screen to say "loading", "nothing here yet", "that did not work"
 * and "done". A screen hands a region of the page (a list, a table, a card) to `loadInto` and the
 * four states are drawn the same way everywhere, in the shopkeeper's words:
 *
 *   KarobarStates.loadInto(region, {
 *     words,                      // copy[locale]: needs the `state…` keys
 *     load: () => api("/api/team"),            // the read; anything it throws becomes the error state
 *     isEmpty: (data) => data.members.length === 0,
 *     render: (data, region) => { … },         // success: draw into the region
 *     empty: { message: words.teamNone, action: { label: words.teamInvite, run: () => … } },
 *   });
 *
 * Loaded by index.html before app.js and published as `globalThis.KarobarStates` (the same way as
 * the item picker), so every screen — including the ones other people are adding — mounts the same
 * pieces. Nothing here reads the books or changes who may see what: it only draws what `load` returns.
 *
 * What a region carries, for people and for tests: `data-state` is loading | empty | error | ready,
 * and `aria-busy` is true only while loading. The error state is a `role="alert"` and the loading
 * state a polite status, so a screen reader hears both without moving focus.
 */
(() => {
  const STATES = ["loading", "empty", "error", "ready"];
  /** Regions that have been handed to this module, in the order they were first used. */
  const known = new Set();
  /** The newest request per region: an answer that arrives late must not overwrite a newer one. */
  const newest = new WeakMap();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- announcements
  // Two always-present live regions (index.html): polite for "saved", assertive for "that failed".
  // Clearing and then setting the text in the next frame makes a screen reader repeat a message that
  // is identical to the last one.
  function announce(message, { urgent = false } = {}) {
    const target = document.getElementById(urgent ? "announce-urgent" : "announce-polite");
    if (!target) return;
    target.textContent = "";
    requestAnimationFrame(() => { target.textContent = message; });
  }

  // ---------------------------------------------------------------- what to tell the shopkeeper
  /**
   * A failure in the shopkeeper's words, and never a stack trace, an id or a status code. A refusal
   * the server worded itself (a 4xx) is already a sentence for a shopkeeper and is kept; a network
   * failure or a server fault gets one of two fixed sentences.
   */
  function friendlyError(error, words) {
    const offline = (error && error.offline === true) || (typeof navigator !== "undefined" && navigator.onLine === false) || (error && error.status === undefined);
    if (offline) return { message: words.stateOffline, reason: "offline" };
    if (error.status >= 500) return { message: words.stateServerProblem, reason: "server" };
    return { message: typeof error.message === "string" && error.message.trim() ? error.message : words.stateGenericProblem, reason: "refused" };
  }

  // ---------------------------------------------------------------- the four states
  function skeleton(rows = 3) {
    const list = el("div", "skeleton-list");
    list.setAttribute("aria-hidden", "true");
    for (let row = 0; row < rows; row += 1) list.append(el("span", "skeleton-bar"));
    return list;
  }

  /** Existing markup that a screen draws into by id is hidden while the region says anything but "ready". */
  function showContent(content, visible) {
    for (const node of [content].flat()) if (node) node.hidden = !visible;
  }

  function setState(region, kind) {
    if (!STATES.includes(kind)) throw new Error(`Unknown screen state: ${kind}`);
    known.add(region);
    region.tabIndex = -1;
    region.dataset.state = kind;
    region.setAttribute("aria-busy", String(kind === "loading"));
  }

  /** Loading: grey bars where the content will be, and a polite status for a screen reader. */
  function showLoading(region, words, rows) {
    setState(region, "loading");
    const status = el("p", "sr-only", words.stateLoading);
    status.setAttribute("role", "status");
    region.replaceChildren(status, skeleton(rows));
  }

  /** Empty: what this place is for, and the one next step. The action is optional. */
  function showEmpty(region, { message, title, action }) {
    setState(region, "empty");
    const block = el("div", "state-block state-empty");
    if (title) block.append(el("h3", "state-title", title));
    block.append(el("p", "state-message", message));
    if (action) {
      const button = el("button", "secondary-button", action.label);
      button.type = "button";
      button.addEventListener("click", action.run);
      block.append(button);
    }
    region.replaceChildren(block);
  }

  /** Error: what happened, what to do next, and a button that tries again. */
  function showError(region, error, words, retry) {
    const { message, reason } = friendlyError(error, words);
    setState(region, "error");
    region.dataset.errorReason = reason;
    const block = el("div", "state-block state-error");
    block.setAttribute("role", "alert");
    block.append(el("p", "state-message", message));
    if (retry) {
      const button = el("button", "secondary-button", words.stateRetry);
      button.type = "button";
      button.addEventListener("click", retry);
      block.append(button);
    }
    region.replaceChildren(block);
    return message;
  }

  /**
   * Runs one read into one region through all four states. Returns the data, or undefined when it
   * failed or a newer call took over. Calling it again (the Retry button does) starts from loading.
   */
  async function loadInto(region, { words, load, render, isEmpty, empty, rows, quiet = false, content }) {
    const mine = Symbol("request");
    newest.set(region, mine);
    // Pressing Try again replaces the button: focus would fall to the top of the page, so it is put back on the region.
    const keepFocus = region.contains(document.activeElement);
    // A screen that is only refreshing keeps what it shows; only the first read blanks it.
    const options = { words, load, render, isEmpty, empty, rows, quiet, content };
    if (!(quiet && region.dataset.state === "ready")) { showLoading(region, words, rows); showContent(content, false); }
    const again = () => loadInto(region, options);
    let data;
    try {
      data = await load();
    } catch (error) {
      if (newest.get(region) !== mine) return undefined;
      showContent(content, false);
      announce(showError(region, error, words, again), { urgent: true });
      if (keepFocus) region.querySelector("button")?.focus();
      return undefined;
    }
    if (newest.get(region) !== mine) return undefined;
    if (keepFocus) queueMicrotask(() => { if (!region.contains(document.activeElement)) region.focus(); });
    if (isEmpty?.(data) && empty) {
      showContent(content, false);
      showEmpty(region, empty);
      return data;
    }
    showContent(content, true);
    region.replaceChildren();
    setState(region, "ready");
    try {
      render(data, region);
    } catch (error) {
      // A drawing fault is ours, not the shopkeeper's: say the page could not be shown, keep the details in the console.
      console.error("A screen could not be drawn.", error);
      showContent(content, false);
      announce(showError(region, new Error(), words, again), { urgent: true });
      return undefined;
    }
    return data;
  }

  // ---------------------------------------------------------------- actions (forms and buttons)
  /**
   * A write: the button is disabled and `aria-busy` while it runs (so it cannot be pressed twice),
   * success is announced politely and shown in `status`, a failure is announced at once and shown
   * beside the button, in words, with the form left as it was so nothing has to be typed again.
   */
  async function runAction(button, { words, run, success, status }) {
    if (button.disabled) return undefined;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (status) { status.removeAttribute("data-kind"); status.textContent = ""; }
    try {
      const result = await run();
      const text = typeof success === "function" ? success(result) : success;
      if (text) { announce(text); if (status) { status.dataset.kind = "success"; status.textContent = text; } }
      return result;
    } catch (error) {
      const { message } = friendlyError(error, words);
      announce(message, { urgent: true });
      if (status) { status.dataset.kind = "error"; status.textContent = message; }
      return undefined;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  const regions = () => [...known].filter((region) => region.isConnected).map((region) => ({ id: region.id, state: region.dataset.state }));

  globalThis.KarobarStates = { STATES, announce, friendlyError, showLoading, showEmpty, showError, loadInto, runAction, regions };
})();
