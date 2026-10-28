// Issue #296 — the composition scheme screen: choose the scheme (checked first, then confirmed with
// the check it got), see the quarter's CMP-08 and approve it, record that it was filed, and read the
// year's GSTR-4. Built with textContent only; every sentence comes in both languages.
const element = (tag, text = "", className = "") => {
  const node = document.createElement(tag);
  if (text !== "") node.textContent = text;
  if (className !== "") node.className = className;
  return node;
};
const option = (value, label) => { const node = element("option", label); node.value = value; return node; };
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const rupees = (paise) => `₹${(Number(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function openComposition({ api, locale, words }) {
  const say = (en, hi) => (locale() === "hi-IN" ? hi : en);
  const root = document.querySelector("#composition-root");
  if (root === null) return;
  // Issue #353 — the four states: loading bars, a plain error with Try again, then the screen.
  await globalThis.KarobarStates.loadInto(document.querySelector("#screen-state-composition"), {
    words: words(),
    quiet: true,
    content: root,
    load: async () => {
      const [scheme, statements] = await Promise.all([
        api("/api/composition/scheme"),
        api("/api/composition/statements", { method: "POST", body: "{}" }).catch((error) => ({ error })),
      ]);
      return { scheme, statements };
    },
    render: ({ scheme, statements }) => render(root, { api, say, locale, scheme, statements }),
  });
}

function panel(title, help) {
  const article = element("article", "", "panel");
  const heading = element("div", "", "panel-heading");
  const inner = element("div");
  inner.append(element("h2", title));
  if (help) inner.append(element("p", help));
  heading.append(inner);
  article.append(heading);
  return article;
}

const list = (lines, className = "") => {
  const ul = element("ul", "", className);
  for (const line of lines) ul.append(element("li", line));
  return ul;
};

const row = (title, detail) => {
  const box = element("div", "", "activity-row");
  box.append(element("span", "·", "activity-icon blue"));
  const body = element("div");
  body.append(element("strong", title));
  if (detail) body.append(element("p", detail));
  box.append(body);
  return box;
};

function render(root, context) {
  const { say, scheme, statements } = context;
  root.replaceChildren();

  // ---------------------------------------------------------------- the scheme
  const current = panel(
    scheme.scheme === "COMPOSITION"
      ? say("You are on the composition scheme", "आप कम्पोज़िशन स्कीम में हैं")
      : say("You pay GST the regular way", "आप रेगुलर तरीक़े से GST भरते हैं"),
    scheme.scheme === "COMPOSITION"
      ? say(`Since ${scheme.effectiveFrom} you issue Bills of Supply with no GST on them, pay ${scheme.ratePercent}% of your sales every quarter with CMP-08, and file GSTR-4 once a year. You cannot claim GST back on purchases or sell to other states.`,
        `${scheme.effectiveFrom} से आप बिना GST के Bill of Supply देते हैं, हर तिमाही बिक्री का ${scheme.ratePercent}% CMP-08 से भरते हैं, और साल में एक बार GSTR-4 भरते हैं। ख़रीद पर GST वापस नहीं मिलता और दूसरे राज्यों में बिक्री नहीं हो सकती।`)
      : say("Your bills are tax invoices with GST on them, and you file GSTR-1 and GSTR-3B. If your business is on the composition scheme, say so here.",
        "आपके बिल GST वाले टैक्स इनवॉइस हैं, और आप GSTR-1 और GSTR-3B भरते हैं। अगर आपका बिज़नेस कम्पोज़िशन स्कीम में है तो यहाँ बताइए।"),
  );
  if (scheme.scheme === "COMPOSITION") {
    current.append(element("p", say("Printed at the top of every bill:", "हर बिल के ऊपर छपता है:")), element("strong", scheme.legend));
  }
  if (scheme.history.length > 0) {
    const history = element("div", "", "activity-list");
    for (const change of scheme.history) {
      history.append(row(
        `${change.effectiveFrom} · ${change.scheme === "COMPOSITION" ? say("Composition scheme", "कम्पोज़िशन स्कीम") : say("Regular", "रेगुलर")}${change.ratePercent === null ? "" : ` · ${change.ratePercent}%`}`,
        change.effectiveFrom > scheme.today
          ? say(`Coming up: this starts on ${change.effectiveFrom}. Until then your bills stay as they are. Set on ${change.declaredOn}.`, `आने वाला: यह ${change.effectiveFrom} से शुरू होगा। तब तक आपके बिल वैसे ही रहेंगे। ${change.declaredOn} को तय हुआ।`)
          : say(`Set on ${change.declaredOn}`, `${change.declaredOn} को तय हुआ`),
      ));
    }
    current.append(history);
  }
  root.append(current, schemeForm(context));

  // ---------------------------------------------------------------- the limit
  if (statements.error) {
    root.append(element("p", statements.error.message, "safety-note"));
    return;
  }
  if (statements.limit !== null) {
    const limit = panel(say("Your sales this year", "इस साल की आपकी बिक्री"), statements.limit.message);
    limit.append(element("p", say(`${rupees(statements.limit.turnover)} of ${rupees(statements.limit.limit)}`, `${rupees(statements.limit.limit)} में से ${rupees(statements.limit.turnover)}`)));
    root.append(limit);
  }

  // ---------------------------------------------------------------- CMP-08
  if (statements.onComposition) {
    const quarters = panel(say("CMP-08: the tax for each quarter", "CMP-08: हर तिमाही का टैक्स"),
      say("The tax is a percentage of what you sold in the quarter. Look at the figures, approve them, pay on the GST portal, then say it is filed.",
        "टैक्स उस तिमाही की बिक्री का एक प्रतिशत है। आँकड़े देखिए, मंज़ूर कीजिए, GST पोर्टल पर भरिए, फिर बताइए कि भर दिया।"));
    for (const quarter of statements.quarters) quarters.append(quarterRow(context, quarter));
    root.append(quarters);
    root.append(yearlyPanel(context, statements.quarters[0]?.financialYear ?? ""));
  } else {
    root.append(element("p", say("CMP-08 and GSTR-4 appear here once your business is on the composition scheme.", "आपका बिज़नेस कम्पोज़िशन स्कीम में आते ही CMP-08 और GSTR-4 यहाँ दिखेंगे।"), "safety-note"));
  }
}

// ------------------------------------------------------------------------- choosing the scheme

function schemeForm({ api, say, locale, scheme }) {
  const box = panel(say("Change your scheme", "स्कीम बदलिए"),
    say("Nothing changes until you have read what it does and confirmed it. A bill that is already issued is never changed.",
      "जब तक आप पढ़कर पक्का न करें, कुछ नहीं बदलता। बना हुआ बिल कभी नहीं बदलता।"));
  const form = element("form");
  const grid = element("div", "", "field-grid");
  const field = (label, control) => { const l = element("label"); l.append(element("span", label), control); grid.append(l); return control; };

  const schemeSelect = field(say("Pay GST", "GST कैसे भरें"), element("select"));
  schemeSelect.name = "scheme";
  schemeSelect.append(option("COMPOSITION", say("Under the composition scheme", "कम्पोज़िशन स्कीम में")), option("REGULAR", say("The regular way", "रेगुलर तरीक़े से")));
  schemeSelect.value = scheme.scheme === "COMPOSITION" ? "REGULAR" : "COMPOSITION";
  const date = field(say("From which date", "किस तारीख़ से"), element("input"));
  date.type = "date"; date.name = "effectiveFrom"; date.value = today(); date.required = true;
  const category = field(say("What the business does", "बिज़नेस क्या करता है"), element("select"));
  category.name = "category";
  category.append(
    option("MANUFACTURER_OR_TRADER", say("Makes or trades goods (1%)", "सामान बनाता या बेचता है (1%)")),
    option("RESTAURANT", say("Restaurant, no alcohol (5%)", "रेस्तरां, शराब नहीं (5%)")),
    option("SERVICES_ONLY", say("Only provides services (6%)", "सिर्फ़ सेवाएँ देता है (6%)")),
  );
  const rate = field(say("Rate, % of sales (leave empty for the usual one)", "रेट, बिक्री का % (ख़ाली छोड़ें तो सामान्य रेट)"), element("input"));
  rate.name = "ratePercent"; rate.inputMode = "decimal";
  const note = field(say("Note (optional)", "टिप्पणी (वैकल्पिक)"), element("input"));
  note.name = "note";
  form.append(grid);

  const boxes = element("div", "", "composition-promises");
  const tick = (name, label) => { const l = element("label", "", "bill-choice"); const c = element("input"); c.type = "checkbox"; c.name = name; l.append(c, element("strong", label)); boxes.append(l); return c; };
  tick("newlyRegistered", say("My GST registration is new and I chose the scheme when I registered", "मेरा GST रजिस्ट्रेशन नया है और मैंने रजिस्ट्रेशन के समय स्कीम चुनी थी"));
  tick("withinLimit", say("My sales last year were within the limit", "पिछले साल की बिक्री सीमा के अंदर थी"));
  tick("noInterState", say("I do not sell to other states or abroad", "मैं दूसरे राज्यों या विदेश में नहीं बेचता"));
  tick("noEcommerce", say("I do not sell through an e-commerce site that collects tax", "मैं ऐसी ई-कॉमर्स साइट से नहीं बेचता जो टैक्स काटती है"));
  tick("rateConfirmed", say("My accountant has confirmed the rate", "अकाउंटेंट ने रेट पक्का किया है"));
  form.append(boxes);

  const check = element("button", say("Check what this changes", "देखिए इससे क्या बदलेगा"), "primary-button");
  check.type = "button";
  form.append(check);
  const result = element("div", "", "stack");
  result.setAttribute("role", "status");
  form.append(result);
  box.append(form);

  const bodyOf = () => {
    const body = {};
    for (const [key, value] of new FormData(form).entries()) body[key] = value;
    for (const name of ["newlyRegistered", "withinLimit", "noInterState", "noEcommerce", "rateConfirmed"]) body[name] = form.elements[name].checked;
    return body;
  };
  const toggle = () => { const on = schemeSelect.value === "COMPOSITION"; for (const l of [category, rate]) l.closest("label").hidden = !on; boxes.hidden = !on; };
  schemeSelect.addEventListener("change", toggle); toggle();
  form.addEventListener("input", () => result.replaceChildren());

  check.addEventListener("click", async () => {
    result.replaceChildren();
    const requestId = newRequestId();
    try {
      const preview = await api("/api/composition/scheme/preview", { method: "POST", body: JSON.stringify({ ...bodyOf(), requestId }) });
      if (preview.blockers.length > 0) {
        result.append(element("strong", say("This cannot be done yet:", "यह अभी नहीं हो सकता:")), list(preview.blockers, "safety-note"));
      }
      if (preview.whatChanges.length > 0) result.append(element("strong", say("What will change:", "क्या बदलेगा:")), list(preview.whatChanges));
      if (preview.warnings.length > 0) result.append(element("strong", say("Please remember:", "कृपया याद रखिए:")), list(preview.warnings, "safety-note"));
      if (preview.ok) {
        const confirm = element("button", say("Confirm and change the scheme", "पक्का कीजिए और स्कीम बदलिए"), "primary-button");
        confirm.type = "button";
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          try {
            await api("/api/composition/scheme", { method: "POST", body: JSON.stringify({ ...bodyOf(), requestId, token: preview.token }) });
            await openComposition({ api, locale });
          } catch (error) { confirm.disabled = false; result.append(element("p", error.message, "safety-note")); }
        });
        result.append(confirm);
      }
    } catch (error) { result.append(element("p", error.message, "safety-note")); }
  });
  return box;
}

// ------------------------------------------------------------------------------ one quarter

function quarterRow(context, quarter) {
  const { api, say } = context;
  const wrap = element("div", "", "activity-row");
  wrap.append(element("span", "·", "activity-icon blue"));
  const body = element("div");
  body.append(element("strong", `${quarter.label} · ${rupees(quarter.totalPayable)}`), element("p", quarter.sentence));
  const detail = element("div");
  detail.hidden = true;
  const open = element("button", say("Open", "खोलिए"), "secondary-button");
  open.type = "button";
  open.addEventListener("click", async () => {
    detail.hidden = !detail.hidden;
    if (detail.hidden) return;
    detail.replaceChildren();
    try { renderQuarter(context, detail, await api("/api/composition/statement", { method: "POST", body: JSON.stringify({ quarter: quarter.quarterKey }) })); }
    catch (error) { detail.append(element("p", error.message, "safety-note")); }
  });
  body.append(open, detail);
  wrap.append(body);
  return wrap;
}

function renderQuarter(context, target, statement) {
  const { api, say, locale } = context;
  const lines = [
    [say("Everything you sold (all bills)", "आपकी कुल बिक्री (सारे बिल)"), rupees(statement.outwardValue)],
    [say("Sales the tax is worked out on", "जिस बिक्री पर टैक्स बना"), rupees(statement.taxableTurnover)],
    [say(`Central tax (${statement.ratePercent / 2}%)`, `सेंट्रल टैक्स (${statement.ratePercent / 2}%)`), rupees(statement.centralTax)],
    [say(`State tax (${statement.ratePercent / 2}%)`, `राज्य टैक्स (${statement.ratePercent / 2}%)`), rupees(statement.stateTax)],
    [say("Total to pay", "कुल भरना"), rupees(statement.totalPayable)],
    [say("Due by", "आख़िरी तारीख़"), statement.dueDate],
    [say("Already written into your books", "खातों में पहले से दर्ज"), rupees(statement.alreadyBooked)],
  ];
  const table = element("div", "", "activity-list");
  for (const [label, value] of lines) table.append(row(label, value));
  target.append(table, list(statement.notes));
  if (statement.documents.length > 0) {
    target.append(element("strong", say("Bills behind these figures", "इन आँकड़ों के पीछे के बिल")),
      list(statement.documents.map((bill) => `${bill.number} · ${bill.date} · ${bill.kind === "CREDIT_NOTE" ? "−" : ""}${rupees(bill.value)}${bill.taxable ? "" : say(" (no tax)", " (टैक्स नहीं)")}`)));
  }
  const result = element("p", "", "safety-note");
  result.setAttribute("role", "status");
  const refresh = () => openComposition({ api, locale });
  if (statement.state === "NOT_BOOKED" || statement.state === "CHANGED_AFTER_BOOKING") {
    const approve = element("button", say("Approve and write it into my books", "मंज़ूर कीजिए और खातों में दर्ज कीजिए"), "primary-button");
    approve.type = "button";
    approve.disabled = BigInt(statement.stillToBook) === 0n;
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      try { await api("/api/composition/approve", { method: "POST", body: JSON.stringify({ quarter: statement.quarterKey, token: statement.fingerprint }) }); await refresh(); }
      catch (error) { approve.disabled = false; result.textContent = error.message; }
    });
    target.append(approve);
  }
  if (statement.state === "BOOKED") {
    const form = element("form");
    const label = element("label");
    const reference = element("input"); reference.name = "reference"; reference.required = true;
    label.append(element("span", say("Reference the GST portal gave when you filed", "भरते समय GST पोर्टल ने जो रेफ़रेंस दिया")), reference);
    const filedOn = element("input"); filedOn.type = "date"; filedOn.name = "filedOn"; filedOn.value = today();
    const dateLabel = element("label"); dateLabel.append(element("span", say("Filed on", "भरने की तारीख़")), filedOn);
    const done = element("button", say("I have filed it", "मैंने भर दिया"), "secondary-button"); done.type = "submit";
    form.append(label, dateLabel, done);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try { await api("/api/composition/filed", { method: "POST", body: JSON.stringify({ quarter: statement.quarterKey, reference: reference.value, filedOn: filedOn.value }) }); await refresh(); }
      catch (error) { result.textContent = error.message; }
    });
    target.append(form);
  }
  target.append(result);
}

// --------------------------------------------------------------------------------- GSTR-4

function yearlyPanel({ api, say }, financialYear) {
  const box = panel(say("GSTR-4: the year", "GSTR-4: पूरा साल"),
    say("The four quarters added up, set against the tax written into your books. Use it as the paper to file GSTR-4 from on the GST portal.",
      "चारों तिमाही का जोड़, आपके खातों में दर्ज टैक्स के साथ मिलाकर। GST पोर्टल पर GSTR-4 भरते समय इसे काग़ज़ की तरह इस्तेमाल कीजिए।"));
  const open = element("button", say("Show the year", "साल दिखाइए"), "secondary-button");
  open.type = "button";
  const out = element("div");
  open.addEventListener("click", async () => {
    out.replaceChildren();
    try {
      const year = await api("/api/composition/yearly", { method: "POST", body: JSON.stringify({ financialYear }) });
      const table = element("div", "", "activity-list");
      for (const quarter of year.quarters) table.append(row(`${quarter.label} · ${rupees(quarter.totalPayable)}`, say(`Sales ${rupees(quarter.taxableTurnover)} at ${quarter.ratePercent}%`, `बिक्री ${rupees(quarter.taxableTurnover)}, ${quarter.ratePercent}% पर`)));
      table.append(
        row(say(`Tax for ${year.financialYear}`, `${year.financialYear} का टैक्स`), rupees(year.taxPayable)),
        row(say("Written into your books", "खातों में दर्ज"), rupees(year.taxBooked)),
        row(say("Purchases from registered businesses", "रजिस्टर्ड बिज़नेस से ख़रीद"), rupees(year.inward.fromRegistered)),
        row(say("Purchases from businesses not registered", "बिना रजिस्ट्रेशन वालों से ख़रीद"), rupees(year.inward.fromUnregistered)),
        row(say("Due by", "आख़िरी तारीख़"), year.dueDate),
      );
      out.append(table, list(year.findings, "safety-note"), list(year.notes));
    } catch (error) { out.append(element("p", error.message, "safety-note")); }
  });
  box.append(open, out);
  return box;
}
