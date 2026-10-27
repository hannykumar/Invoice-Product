// Issue #489 — the supplier bills inbox: what arrived (by upload, email or WhatsApp), what was read
// from each bill and how sure we are of it, and the way from a read bill to a recorded one.
// Every box is built with textContent only; the server's sentences are shown as they come.
// The bill is recorded through the same two calls as a typed one: checked first, recorded second.
let wired = false;
let context = null;
let seen = null;
let catalogue = null;

const element = (tag, text = "", className = "") => {
  const node = document.createElement(tag);
  if (text !== "") node.textContent = text;
  if (className !== "") node.className = className;
  return node;
};
const $ = (selector) => document.querySelector(selector);
const say = (key, values = {}) => context.text(key, values);
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const when = (iso) => new Intl.DateTimeFormat(context.locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));
const STATE_KEYS = { ready: "inboxStateReady", reading: "inboxStateReading", held: "inboxStateHeld", failed: "inboxStateFailed", duplicate: "inboxStateDuplicate", billed: "inboxStateBilled", rejected: "inboxStateRejected" };
const STATE_CLASS = { ready: "waiting", reading: "", held: "hold", failed: "warn", duplicate: "", billed: "done", rejected: "" };

const pill = (state) => element("span", say(STATE_KEYS[state] ?? "inboxStateReading"), `pill ${STATE_CLASS[state] ?? ""}`.trim());
const announce = (message) => { const out = $("#inbox-add-result"); out.textContent = message; };

// ------------------------------------------------------------------------------------- the list

async function loadList() {
  const list = $("#inbox-list");
  list.setAttribute("aria-busy", "true");
  list.replaceChildren(element("p", say("inboxLoading"), "muted"));
  try {
    const inbox = await context.apiList("/api/purchase-inbox", "items");
    renderList(inbox);
  } catch (error) {
    const box = element("div", "", "safety-note");
    box.append(element("span", "!"), element("span", `${say("inboxLoadFailed")} ${error.message ?? ""}`.trim()));
    const retry = element("button", say("inboxRetryLoad"), "secondary-button");
    retry.type = "button";
    retry.addEventListener("click", loadList);
    list.replaceChildren(box, retry);
  } finally {
    list.setAttribute("aria-busy", "false");
  }
}

function renderList(inbox) {
  const list = $("#inbox-list");
  seen = inbox;
  $("#inbox-counts").textContent = say("inboxCounts", inbox.counts ?? { ready: 0, held: 0, failed: 0 });
  const delivery = $("#inbox-deliver-to");
  delivery.hidden = !inbox.deliverTo;
  if (inbox.deliverTo) delivery.querySelector("[data-inbox-deliver]").textContent = say("inboxDeliverTo", inbox.deliverTo);
  list.replaceChildren();
  if (inbox.items.length === 0) { list.append(element("p", say("inboxEmpty"), "muted")); return; }
  for (const entry of inbox.items) list.append(row(entry));
}

function row(entry) {
  const item = element("div", "", "activity-row");
  const body = element("div");
  body.append(element("strong", entry.fileName));
  body.append(element("p", `${entry.channelWords} · ${when(entry.receivedAt)}${entry.supplier ? ` · ${entry.supplier}` : ""}${entry.billNumber ? ` · ${entry.billNumber}` : ""}${entry.total ? ` · ${entry.total}` : ""}`));
  if (entry.message) body.append(element("p", entry.message));
  body.append(element("p", entry.next));
  if (entry.sameBillAs) body.append(element("p", say("inboxSameBill", { name: entry.sameBillAs.fileName }), "line-warn"));
  if (entry.checks) body.append(element("p", say("inboxChecks", { n: entry.checks })));
  const value = element("div", "", "activity-value");
  value.append(pill(entry.state));
  const open = element("button", say("inboxOpen"), "secondary-button");
  open.type = "button";
  open.setAttribute("aria-label", `${say("inboxOpen")}: ${entry.fileName}`);
  open.addEventListener("click", () => openDetail(entry.id, open));
  item.append(body, value, open);
  return item;
}

// ----------------------------------------------------------------------------------- the detail

const closeDetail = (focus) => {
  const panel = $("#inbox-detail");
  panel.hidden = true;
  panel.replaceChildren();
  focus?.focus?.();
};

async function openDetail(id, opener) {
  const panel = $("#inbox-detail");
  panel.hidden = false;
  panel.replaceChildren(element("p", say("inboxLoading"), "muted"));
  try {
    const shown = await context.api(`/api/purchase-inbox/${encodeURIComponent(id)}`);
    renderDetail(shown, opener);
  } catch (error) {
    panel.replaceChildren(element("p", error.message, "safety-note"));
  }
  panel.focus();
  panel.scrollIntoView({ block: "start" });
}

function reasonForm(titleKey, whyKey, buttonKey, action, opener, done) {
  const form = element("form", "", "form-panel");
  form.append(element("h3", say(titleKey)));
  const label = element("label");
  label.append(element("span", say(whyKey)));
  const input = element("input");
  input.name = "reason"; input.maxLength = 200; input.required = true;
  label.append(input);
  const button = element("button", say(buttonKey), "secondary-button");
  button.type = "submit";
  const result = element("p", "", "");
  result.setAttribute("role", "status");
  form.append(label, button, result);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    result.textContent = say("inboxWorking");
    try {
      const reply = await action(input.value);
      announce(`${reply.title}. ${reply.message}`);
      closeDetail(opener);
      await loadList();
    } catch (error) { result.textContent = error.message; button.disabled = false; }
  });
  return form;
}

function renderDetail({ document: doc, draft }, opener) {
  const panel = $("#inbox-detail");
  panel.replaceChildren();
  const head = element("div", "", "panel-heading");
  const title = element("div");
  const h2 = element("h2", doc.fileName); h2.id = "inbox-detail-title";
  title.append(h2, element("p", `${doc.channelWords} · ${when(doc.receivedAt)}`));
  const back = element("button", say("inboxBack"), "secondary-button");
  back.type = "button";
  back.addEventListener("click", () => closeDetail(opener));
  head.append(title, back);
  panel.append(head, pill(doc.state), element("p", doc.message || ""), element("p", doc.next, "line-warn"));

  if (doc.actions.retry) {
    const retry = element("button", say("inboxRetry"), "secondary-button");
    retry.type = "button";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try { const reply = await context.api(`/api/purchase-inbox/${encodeURIComponent(doc.id)}/retry`, { method: "POST", body: "{}" }); announce(`${reply.title}. ${reply.message}`); closeDetail(opener); await loadList(); }
      catch (error) { announce(error.message); retry.disabled = false; }
    });
    panel.append(retry);
  }
  if (doc.actions.assign) {
    panel.append(reasonForm("inboxAssignTitle", "inboxAssignWhy", "inboxAssign",
      (reason) => context.api(`/api/purchase-inbox/${encodeURIComponent(doc.id)}/assign`, { method: "POST", body: JSON.stringify({ reason }) }), opener));
  }
  if (draft) panel.append(...readSection(draft), recordSection(doc, draft, opener));
  if (doc.actions.reject) {
    panel.append(reasonForm("inboxSetAsideTitle", "inboxSetAsideWhy", "inboxSetAside",
      (reason) => context.api(`/api/purchase-inbox/${encodeURIComponent(doc.id)}/reject`, { method: "POST", body: JSON.stringify({ reason }) }), opener));
  }
}

function readSection(draft) {
  const section = element("section");
  section.append(element("h3", say("inboxWhatWeRead")), element("p", say("inboxWhatWeReadHelp"), "muted"));
  const list = element("div", "", "activity-list");
  for (const field of draft.fields) {
    const line = element("div", "", `activity-row${field.needsCheck ? " check" : ""}`);
    const body = element("div");
    body.append(element("strong", field.label), element("p", field.display));
    body.append(element("p", `${say("inboxReadFrom")} “${field.evidence.text}”${field.evidence.page > 0 ? ` (p. ${field.evidence.page})` : field.evidence.jsonPath ? ` (${field.evidence.jsonPath})` : ""}`, "muted"));
    if (field.warning) body.append(element("p", field.warning, "line-warn"));
    const value = element("div", "", "activity-value");
    value.append(element("span", say("inboxConfidence", { words: field.words, percent: Math.round(field.confidence * 100) }), `pill ${field.level === "clear" ? "done" : field.level === "check" ? "warn" : "hold"}`));
    line.append(body, value);
    list.append(line);
  }
  section.append(list);
  if (draft.notFound.length > 0) section.append(element("p", say("inboxNotFound", { names: draft.notFound.map((missing) => missing.label).join(", ") }), "line-warn"));
  if (draft.lines.length === 0) section.append(element("p", say("inboxNoLinesRead"), "line-warn"));
  if (draft.problems.length > 0) {
    section.append(element("h4", say("inboxProblems")));
    const problems = element("ul");
    for (const problem of draft.problems) problems.append(element("li", problem));
    section.append(problems);
  }
  return [section];
}

// ------------------------------------------------------------------------ check, correct, record

const option = (value, label) => { const node = element("option", label); node.value = value; return node; };

function lineBox(values) {
  const box = element("div", "", "field-grid inbox-line");
  const itemLabel = element("label"); itemLabel.append(element("span", say("inboxItem")));
  const item = element("select"); item.dataset.field = "item";
  item.append(option("", say("inboxChoose")), ...catalogue.items.map((entry) => option(entry.id, entry.name)));
  item.value = values.itemId ?? "";
  itemLabel.append(item);
  const quantityLabel = element("label"); quantityLabel.append(element("span", say("inboxQuantity")));
  const quantity = element("input"); quantity.dataset.field = "quantity"; quantity.inputMode = "decimal"; quantity.value = values.quantity ?? "";
  quantityLabel.append(quantity);
  const rateLabel = element("label"); rateLabel.append(element("span", say("inboxRate")));
  const rate = element("input"); rate.dataset.field = "rate"; rate.inputMode = "decimal"; rate.value = values.rate ?? "";
  rateLabel.append(rate);
  const gstLabel = element("label"); gstLabel.append(element("span", say("inboxGst")));
  const gst = element("select"); gst.dataset.field = "gst";
  gst.append(option("", say("inboxChoose")), ...catalogue.rates.map((entry) => option(String(entry.ratePercentTimes100), entry.label)));
  gst.value = values.gst ?? "";
  gstLabel.append(gst);
  const remove = element("button", say("inboxRemoveLine"), "secondary-button"); remove.type = "button";
  remove.addEventListener("click", () => box.remove());
  box.append(itemLabel, quantityLabel, rateLabel, gstLabel, remove);
  if (values.description) box.append(element("small", values.description, "muted"));
  return box;
}

function recordSection(doc, draft, opener) {
  const section = element("form", "", "form-panel");
  section.noValidate = false;
  section.append(element("h3", say("inboxRecordTitle")), element("p", say("inboxRecordHelp"), "muted"));
  const grid = element("div", "", "field-grid");
  const supplierLabel = element("label"); supplierLabel.append(element("span", say("inboxSupplier")));
  const supplier = element("select"); supplier.name = "supplierId"; supplier.required = true;
  supplier.append(option("", say("inboxChoose")), ...catalogue.suppliers.map((entry) => option(entry.id, entry.name)));
  supplier.value = draft.form.supplierId;
  supplierLabel.append(supplier);
  const referenceLabel = element("label"); referenceLabel.append(element("span", say("inboxBillNumber")));
  const reference = element("input"); reference.name = "reference"; reference.required = true; reference.value = draft.form.reference; reference.maxLength = 40;
  referenceLabel.append(reference);
  const dateLabel = element("label"); dateLabel.append(element("span", say("inboxBillDate")));
  const date = element("input"); date.name = "date"; date.type = "date"; date.required = true; date.value = draft.form.date;
  dateLabel.append(date);
  grid.append(supplierLabel, referenceLabel, dateLabel);
  const lines = element("div", "", "inbox-lines");
  for (const line of draft.form.lines.length > 0 ? draft.form.lines : [{}]) lines.append(lineBox(line));
  const add = element("button", say("inboxAddLine"), "secondary-button"); add.type = "button";
  add.addEventListener("click", () => lines.append(lineBox({})));
  const check = element("button", say("inboxCheck"), "primary-button"); check.type = "submit";
  const outcome = element("div", "", "");
  outcome.setAttribute("role", "status"); outcome.setAttribute("aria-live", "polite");
  section.append(grid, lines, add, check, outcome);

  const body = () => ({
    supplierId: supplier.value, reference: reference.value.trim(), date: date.value,
    lines: [...lines.querySelectorAll(".inbox-line")].map((box) => Object.fromEntries([...box.querySelectorAll("[data-field]")].map((input) => [input.dataset.field === "item" ? "itemId" : input.dataset.field, input.value]))),
  });
  // One request id per bill as it stands: pressing Record twice is one bill (the server also knows the document).
  let requestId = newRequestId();
  section.addEventListener("input", () => { requestId = newRequestId(); outcome.replaceChildren(); });

  section.addEventListener("submit", async (event) => {
    event.preventDefault();
    check.disabled = true;
    outcome.replaceChildren(element("p", say("inboxChecking")));
    const sent = body();
    try {
      const preview = await context.api(`/api/purchase-inbox/${encodeURIComponent(doc.id)}/preview`, { method: "POST", body: JSON.stringify({ ...sent, requestId }) });
      const effects = element("ul");
      for (const effect of preview.effects) effects.append(element("li", effect));
      const record = element("button", say("inboxRecordOnce"), "primary-button"); record.type = "button";
      record.addEventListener("click", async () => {
        record.disabled = true;
        try {
          const saved = await context.api(`/api/purchase-inbox/${encodeURIComponent(doc.id)}/record`, { method: "POST", body: JSON.stringify({ ...sent, requestId }) });
          const done = element("div", "", "line-ok");
          done.append(element("span", "✓"), element("span", `${say("inboxRecorded")}: ${saved.bill.supplier} · ${saved.bill.number}. ${say("inboxAlsoSee")}`));
          outcome.replaceChildren(done);
          if (saved.corrections.length > 0) {
            outcome.append(element("p", say("inboxYouChanged")));
            const changes = element("ul");
            for (const change of saved.corrections) changes.append(element("li", change));
            outcome.append(changes);
          }
          announce(`${say("inboxRecorded")}: ${saved.bill.number}`);
          check.hidden = true; add.hidden = true;
          await loadList();
        } catch (error) { outcome.replaceChildren(element("p", error.message, "safety-note")); record.disabled = false; }
      });
      outcome.replaceChildren(element("p", preview.message), effects, record);
      record.focus();
    } catch (error) {
      outcome.replaceChildren(element("p", error.message, "safety-note"));
    } finally { check.disabled = false; }
  });
  return section;
}

// ------------------------------------------------------------------------------------- adding

const isJson = (file) => /\.json$/i.test(file.name) || file.type === "application/json";

async function addFile() {
  const input = $("#inbox-file");
  const file = input.files?.[0];
  if (!file) { announce(say("inboxNoFile")); input.focus(); return; }
  const button = $("#inbox-add-button");
  button.disabled = true;
  announce(say("inboxAdding"));
  try {
    let reply;
    if (isJson(file)) {
      reply = await context.api("/api/purchase-inbox/upload", { method: "POST", body: JSON.stringify({ einvoiceJson: await file.text(), fileName: file.name }) });
    } else {
      // The same private route as every stored file (#341): an address to put it at, the file, then "done".
      const requested = await context.api("/api/files/uploads", { method: "POST", body: JSON.stringify({ purpose: "purchase_bill", fileName: file.name, contentType: file.type, sizeBytes: file.size }) });
      const put = await fetch(requested.upload.url, { method: requested.upload.method, headers: requested.upload.headers, credentials: "same-origin", body: file });
      if (!put.ok) throw new Error(say("inboxLoadFailed"));
      await context.api(`/api/files/${encodeURIComponent(requested.file.id)}/complete`, { method: "POST", body: "{}" });
      reply = await context.api("/api/purchase-inbox/upload", { method: "POST", body: JSON.stringify({ fileId: requested.file.id, source: file.type.startsWith("image/") ? "camera" : "manual_upload" }) });
    }
    announce(`${reply.title}. ${reply.message}`);
    input.value = "";
    await loadList();
  } catch (error) {
    announce(error.message);
  } finally { button.disabled = false; }
}

export async function openInbox(opened) {
  context = opened;
  catalogue = await context.api("/api/catalogue").catch(() => ({ suppliers: [], items: [], rates: [] }));
  if (!wired) {
    wired = true;
    $("#inbox-add-button").addEventListener("click", addFile);
    $("#inbox-refresh").addEventListener("click", loadList);
  }
  closeDetail();
  await loadList();
}
