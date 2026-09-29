/**
 * Issue #307 — the finish of every bill: a tick, the bill number, the amount, one plain line, and
 * the three things a shopkeeper does next — send it on WhatsApp, print it, start the next bill.
 *
 * A module of its own so the four-slide sale (#305) mounts the same screen as its last slide.
 * It works the money out nowhere: the amount still due and the UPI link for it come from the
 * server's sale result (`/api/sales/record`), and this file only puts them into words.
 *
 *   mountDoneScreen(container, sale, options)
 *     container  an element to fill (the #done-screen dialog, or a slide)
 *     sale       the /api/sales/record result: invoice {id, number, amount}, customer {name, phone,
 *                walkIn}, paid {mode, amount} | null, due, upiLink | null, ewayBill, eInvoice
 *     options    { words, money, storage, onPrint(format), onNewBill(), onDownload(), onEway(), onCancel() }
 *                words: the screen's dictionary for the chosen language (the done* keys in app.js)
 *                money: formats rupees for that language
 */

/** Where the chosen printer is remembered on this device. */
export const PRINTER_KEY = "karobar.printer";
export const PRINTERS = [["A4", "doneA4"], ["THERMAL_80MM", "done80"], ["THERMAL_58MM", "done58"]];

const fill = (template, values) => Object.entries(values).reduce((line, [name, value]) => line.replaceAll(`{${name}}`, String(value)), template ?? "");

/** A ten-digit Indian mobile number from what was typed (+91, 0 or spaces allowed), or null. Never guessed. */
export function indianMobile(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

/** The customer as the screen names them: the walk-in customer has no name of their own. */
const nameOf = (sale, words) => (sale.customer?.walkIn ? words.walkInShort : sale.customer?.name ?? "");

/** The message sent to the customer, in the chosen language, with the UPI link only for what is still due. */
export function shareMessage(sale, words, money) {
  const lines = [fill(words.doneMessageBill, {
    name: sale.customer?.walkIn || !sale.customer?.name ? "" : ` ${sale.customer.name}`,
    shop: sale.shop ?? "",
    number: sale.invoice.number,
    amount: money(sale.invoice.amount),
  })];
  if (!(sale.due > 0)) lines.push(words.doneMessagePaid);
  else {
    lines.push(fill(words.doneMessageDue, { due: money(sale.due) }));
    if (sale.upiLink) lines.push(fill(words.doneMessageUpi, { link: sale.upiLink }));
  }
  return lines.join("\n");
}

/** WhatsApp's own "click to chat" link: the customer's chat opens with the message typed in. */
export const whatsappLink = (mobile, message) => `https://wa.me/91${mobile}?text=${encodeURIComponent(message)}`;

/** The one plain line under the amount: what happened to the money and the stock. */
export function doneLine(sale, words, money) {
  const name = nameOf(sale, words);
  // "ABC Traders' khata", "Mehta's khata" — for the languages that write it that way.
  const names = /s$/i.test(name) ? `${name}’` : `${name}’s`;
  const mode = words[`doneMode${sale.paid?.mode ?? ""}`] ?? sale.paid?.mode ?? "";
  if (sale.paid && !(sale.due > 0)) return fill(words.doneLinePaid, { mode, name, names });
  if (sale.paid) return fill(words.doneLinePart, { mode, name, names, paid: money(sale.paid.amount), due: money(sale.due) });
  return fill(words.doneLineKhata, { name, names });
}

const element = (tag, attributes = {}, text = "") => {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  if (text) node.textContent = text;
  return node;
};

function rememberedPrinter(storage) {
  try {
    const saved = storage?.getItem(PRINTER_KEY);
    return PRINTERS.some(([value]) => value === saved) ? saved : "A4";
  } catch { return "A4"; }
}

/** Fills `container` with the done screen for `sale`. Returns the element to focus first. */
export function mountDoneScreen(container, sale, options) {
  const { words, money, storage } = options;
  const title = element("h2", { id: "done-title" }, words.doneTitle);
  const tick = element("div", { class: "done-tick", "aria-hidden": "true" }, "✓");
  const number = element("p", { class: "done-number" }, sale.invoice.number);
  const amount = element("p", { class: "amount amount-big" }, money(sale.invoice.amount));
  const line = element("p", { class: "done-line" }, doneLine(sale, words, money));

  // Send on WhatsApp: the customer's own number, or one typed here. Nothing is sent from the app;
  // WhatsApp opens with the message ready and the shopkeeper presses send.
  const whatsapp = element("a", { class: "action-button wide done-whatsapp", target: "_blank", rel: "noopener" }, words.doneWhatsapp);
  const phoneField = element("label", { class: "done-phone" });
  const phoneInput = element("input", { type: "tel", inputmode: "tel", autocomplete: "off", name: "donePhone" });
  const phoneHelp = element("small", {}, words.donePhoneHelp);
  phoneField.append(element("span", {}, words.donePhoneLabel), phoneInput, phoneHelp);
  const known = indianMobile(sale.customer?.phone);
  phoneField.hidden = known !== null;
  const message = shareMessage(sale, words, money);
  const setPhone = (mobile) => {
    if (mobile === null) {
      whatsapp.removeAttribute("href");
      whatsapp.setAttribute("aria-disabled", "true");
      whatsapp.setAttribute("role", "link");
      return;
    }
    whatsapp.href = whatsappLink(mobile, message);
    whatsapp.removeAttribute("aria-disabled");
  };
  setPhone(known);
  phoneInput.addEventListener("input", () => {
    const mobile = indianMobile(phoneInput.value);
    setPhone(mobile);
    phoneHelp.textContent = mobile === null && phoneInput.value.replace(/\D/g, "").length >= 10 ? words.donePhoneInvalid : words.donePhoneHelp;
  });
  whatsapp.addEventListener("click", (event) => {
    if (whatsapp.hasAttribute("href")) return;
    event.preventDefault();
    phoneHelp.textContent = words.donePhoneInvalid;
    phoneInput.focus();
  });
  const upi = element("p", { class: "done-note" }, sale.due > 0 ? (sale.upiLink ? fill(words.doneUpiIncluded, { due: money(sale.due) }) : words.doneUpiMissing) : "");
  upi.hidden = !(sale.due > 0);

  // Print receipt, on the paper chosen last time on this device.
  const printer = element("select", { name: "donePrinter", "aria-label": words.donePrinter });
  PRINTERS.forEach(([value, key]) => printer.append(element("option", { value }, words[key])));
  printer.value = rememberedPrinter(storage);
  printer.addEventListener("change", () => { try { storage?.setItem(PRINTER_KEY, printer.value); } catch { /* a private window keeps nothing */ } });
  const print = element("button", { type: "button", class: "secondary-button" }, words.donePrint);
  print.addEventListener("click", () => options.onPrint?.(printer.value));
  const printRow = element("div", { class: "done-print" });
  printRow.append(printer, print);

  const newBill = element("button", { type: "button", class: "secondary-button wide" }, words.doneNewBill);
  newBill.addEventListener("click", () => options.onNewBill?.());

  const more = element("div", { class: "done-more" });
  const download = element("button", { type: "button", class: "text-button" }, words.downloadPdf);
  download.addEventListener("click", () => options.onDownload?.());
  more.append(download);
  if (sale.ewayBill?.outcome === "REQUIRED") {
    const eway = element("button", { type: "button", class: "text-button" }, words.ewayFromBill);
    eway.addEventListener("click", () => options.onEway?.());
    more.append(eway);
  }
  const cancel = element("button", { type: "button", class: "text-button" }, words.cancelBill);
  cancel.addEventListener("click", () => options.onCancel?.());
  more.append(cancel);

  const notes = sale.eInvoice?.message ? [element("p", { class: "done-note" }, sale.eInvoice.message)] : [];
  container.replaceChildren(tick, title, number, amount, line, phoneField, whatsapp, upi, printRow, newBill, more, ...notes);
  return known === null ? phoneInput : whatsapp;
}
