# Web development preview — issue #38

Run from the repository root:

```sh
npm run web
```

Open `http://127.0.0.1:4173`. No installation beyond the repository's normal `npm install` is required.

## Manual verification

1. Resize the window below 760 pixels. The left navigation becomes a bottom navigation bar and every transaction form becomes one column.
2. Change **English** to **हिन्दी**. Navigation, headings, controls, help text, status wording and screen-reader labels change together.
3. Open **Sale**, choose a customer, item, quantity and rate. The value before GST updates immediately; GST and the total come from the server when you press **Review sale**, which shows the figures, one green line and at most one warning.
4. Reload the page. The unfinished sale is restored from this device and the live status announces that recovery.
5. Open **Purchase** and **Payment**. Confirm each flow explains what will and will not change before review.
6. Use only the keyboard. Focus remains visible and all fields, navigation items, language selection and review actions are reachable.
7. Run `npm run verify`. The web checks enforce translation completeness, semantic flow structure, draft recovery hooks, responsive behavior, reduced-motion support and safe static asset serving.

## Runtime boundary

This local workspace uses synthetic credentials and in-memory persistence, but it is not a static screen or a no-op form. Sign-in creates a real session; the session supplies tenant and permissions; and sale, purchase and payment previews and recordings call the real sales, purchasing, inventory, ledger and receivables services. Two companies are available so tenant isolation is demonstrable through the browser.

Draft fields stay in browser storage and are never treated as posted work. A preview is read-only, recording is explicitly confirmed, and repeat recording uses the service idempotency guarantees. Restarting the local server clears its synthetic company state and invalidates old sessions; the browser will ask the user to sign in again without discarding unfinished drafts.

## Design system — issue #303

Every screen uses the tokens at the top of `styles.css`. Each colour is defined once for light and
dark with `light-dark()`: the page follows the device, and `data-theme="light"` or `"dark"` on
`<html>` forces one. The owner can see every piece on one page at `#design` (English and Hindi side
by side, with a light/dark switch).

| Token | Light | Use |
|---|---|---|
| `--brand` / `--brand-ink` | `#173f35` | structure, headers, selected state / the brand colour as text |
| `--action` / `--action-ink` | marigold `#e39a2d` / `#2a1a02` | the **one** main action per screen (`.action-button`) |
| `--paid` / `--paid-bg` | `#1d7f55` on `#e2f4ea` | paid, money in, success |
| `--due` / `--due-bg` | `#9a6412` on `#fcf0da` | waiting, due soon |
| `--late` / `--late-bg` | `#ac3a34` on `#fbe7e5` | overdue, blocked |
| `--canvas`, `--surface`, `--surface-2`, `--ink`, `--muted`, `--line`, `--field-line` | | page, cards, text, borders |
| `--info` / `--info-bg` | | a neutral note, never a status |

Paid, due and late mean status and nothing else — never decoration.

- **Type:** Mukta (Latin and Devanagari in one family) for all text, Baloo 2 (`--font-display`) for
  headings and big figures, both from Google Fonts with system fallbacks for both scripts. Every
  number is tabular (`font-variant-numeric: tabular-nums` on `body`); money is formatted with
  `Intl.NumberFormat(locale, { currency: "INR" })`, which groups the Indian way (₹1,18,944.00).
  Small text uses `--fs-xs`/`--fs-sm`/`--fs-md`, which are all 16px on a phone.
- **Sizes:** touch targets `--tap` (48px); cards `--radius` (16px), chips `--radius-chip`; one
  shadow, `--shadow`, only for floating things (bottom bar, dialogs, sheets).
- **Motion:** slides move sideways in `--motion` (250ms, `.slide.entering`); a success tick pops once
  (`.done-tick`); nothing else animates; `prefers-reduced-motion` turns all of it off.
- **Pieces:** `.action-button`, `.chip` (`.paid` `.due` `.late`; a `button.chip` with `aria-pressed`
  is a choice), `.amount` / `.amount-big`, `.money-card`, `.slide` + `.slide-dots` + `.bill-bar`,
  `.tabbar` + `.tab-main`, `.line-ok` (the one green line) and `.line-warn` (the one warning).

### The eight screen rules

Check every redesign pull request against these, in English and Hindi, on a phone and a desktop.

1. **One decision per slide.**
2. **The total never hides** — a sticky bottom bar on every bill step.
3. **Defaults beat questions** — walk-in, today, cash, main godown, last price.
4. **Law runs in the background** — a green line when it is fine, a Home task when the owner must act.
5. **Shop words only** — bill, udhaar, khata, cash in drawer, to collect. Never module, voucher
   posted, live company state. `apps/web/test/shop-words.test.ts` fails on the banned words.
6. **Thumb-sized and bold** — 48px targets, actions within reach at the bottom.
7. **Both scripts properly** — see #298.
8. **Undo over "are you sure"** for drafts; full previews only for issuing, cancelling and
   government actions.

A sale review follows rules 4 and 5 already: the figures, one green line for what the law needs
(it happens by itself), and at most one warning, only when the owner has to act — for example the
e-invoice turnover question until it is answered once in Business details.
