// Issue #294 — the expenses screen: each form is checked first (/preview) and saved second
// (/record) with the check it got, once per request id. Built with textContent only.
let ready = null;

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const rupees = (value) => `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const element = (tag, text = "", className = "") => {
  const node = document.createElement(tag);
  if (text !== "") node.textContent = text;
  if (className !== "") node.className = className;
  return node;
};
const option = (value, label) => { const node = element("option", label); node.value = value; return node; };
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function bodyOf(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.booksKind !== "journal") return data;
  const lines = [1, 2, 3, 4].map((n) => ({ account: data[`account${n}`], debit: data[`debit${n}`], credit: data[`credit${n}`] }))
    .filter((line) => line.account && (line.debit || line.credit));
  return { date: data.date, narration: data.narration, lines };
}

function panelFor(form) {
  let panel = form.querySelector("[data-books-result]");
  if (!panel) {
    panel = element("div", "", "safety-note");
    panel.dataset.booksResult = "";
    panel.setAttribute("role", "status");
    form.append(panel);
  }
  panel.replaceChildren();
  return panel;
}

function wire(form, api, words) {
  const actions = element("div", "", "sheet-choices");
  const check = element("button", words.booksCheck, "primary-button");
  check.type = "button";
  actions.append(check);
  form.append(actions);
  form.addEventListener("input", () => { delete form.dataset.check; panelFor(form); });
  check.addEventListener("click", async () => {
    const kind = form.dataset.booksKind;
    const panel = panelFor(form);
    try {
      const preview = await api(`/api/books/${kind}/preview`, { method: "POST", body: JSON.stringify(bodyOf(form)) });
      const list = element("ul");
      for (const effect of preview.effects) list.append(element("li", effect));
      const save = element("button", words.booksSave, "primary-button");
      save.type = "button";
      const requestId = newRequestId();
      save.addEventListener("click", async () => {
        try {
          const saved = await api(`/api/books/${kind}/record`, { method: "POST", body: JSON.stringify({ ...bodyOf(form), check: preview.check, requestId }) });
          panel.replaceChildren(element("p", `${saved.entry.number} · ${rupees(saved.entry.total)} · ${saved.narration}`));
          form.reset();
          setDates();
          await refresh(api, words);
        } catch (error) { panel.replaceChildren(element("p", error.message)); }
      });
      panel.append(list, save);
    } catch (error) { panel.append(element("p", error.message)); }
  });
}

function setDates() {
  document.querySelectorAll("#view-books input[type=date]").forEach((input) => { if (!input.value) input.value = today(); });
}

async function showBook(api, words, which) {
  const book = await api(`/api/books/book?book=${which}`);
  document.querySelector("[data-books-book-summary]").textContent = `${book.accounts.join(", ")} · ${words.booksOpening} ${rupees(book.opening)} · ${words.booksClosing} ${rupees(book.closing)}`;
  document.querySelector("[data-books-book-rows]").replaceChildren(...book.rows.map((row) => {
    const tr = element("tr");
    for (const cell of [row.date, row.number, row.against || row.narration, row.moneyIn ? rupees(row.moneyIn) : "", row.moneyOut ? rupees(row.moneyOut) : "", rupees(row.balance)]) tr.append(element("td", cell));
    return tr;
  }));
}

async function refresh(api, words) {
  const { entries } = await api("/api/books/entries?limit=500");
  document.querySelector("[data-books-entries]").replaceChildren(...entries.slice().reverse().map((entry) => {
    const item = element("li", `${entry.date} · ${entry.number} · ${rupees(entry.total)} · ${entry.narration}${entry.state === "REVERSED" ? " ✕" : ""}`);
    if (entry.state === "FINAL") {
      const undo = element("button", words.booksUndo, "text-button");
      undo.type = "button";
      const requestId = newRequestId();
      undo.addEventListener("click", async () => {
        const reason = window.prompt(words.booksUndoReason);
        if (!reason) return;
        try { await api("/api/books/undo", { method: "POST", body: JSON.stringify({ entryId: entry.id, reason, requestId }) }); await refresh(api, words); }
        catch (error) { item.append(element("small", ` ${error.message}`)); }
      });
      item.append(" ", undo);
    }
    return item;
  }));
  await showBook(api, words, document.querySelector("[data-books-book].active")?.dataset.booksBook ?? "cash").catch(() => {});
}

export async function openBooks({ api, words }) {
  setDates();
  ready ??= (async () => {
    const { heads } = await api("/api/books/heads");
    document.querySelector("[data-books-heads]").replaceChildren(...heads.map((head) => option(head.id, `${head.label} · ${head.hindi}`)));
    const journal = await api("/api/books/journal/accounts").catch(() => ({ accounts: [] }));
    document.querySelectorAll("[data-journal-account]").forEach((select) => select.replaceChildren(option("", ""), ...journal.accounts.map((a) => option(a.code, `${a.code} ${a.name}`))));
    document.querySelectorAll("#view-books form[data-books-kind]").forEach((form) => wire(form, api, words));
    document.querySelectorAll("[data-books-book]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-books-book]").forEach((other) => other.classList.toggle("active", other === button));
      showBook(api, words, button.dataset.booksBook).catch((error) => { document.querySelector("[data-books-book-summary]").textContent = error.message; });
    }));
  })();
  await ready;
  await refresh(api, words).catch(() => {});
}
