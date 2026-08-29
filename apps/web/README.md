# Web development preview — issue #38

Run from the repository root:

```sh
npm run web
```

Open `http://127.0.0.1:4173`. No installation beyond the repository's normal `npm install` is required.

## Manual verification

1. Resize the window below 760 pixels. The left navigation becomes a bottom navigation bar and every transaction form becomes one column.
2. Change **English** to **हिन्दी**. Navigation, headings, controls, help text, status wording and screen-reader labels change together.
3. Open **Sale**, enter a customer, item, quantity and rate. The pre-GST item value updates immediately; GST and the final total stay blank until the deterministic server preview checks the item and sale date.
4. Reload the page. The unfinished sale is restored from this device and the live status announces that recovery.
5. Open **Purchase** and **Payment**. Confirm each flow explains what will and will not change before review.
6. Use only the keyboard. Focus remains visible and all fields, navigation items, language selection and review actions are reachable.
7. Run `npm run verify`. The web checks enforce translation completeness, semantic flow structure, draft recovery hooks, responsive behavior, reduced-motion support and safe static asset serving.

## Runtime boundary

This local workspace uses synthetic credentials and in-memory persistence, but it is not a static screen or a no-op form. Sign-in creates a real session; the session supplies tenant and permissions; and sale, purchase and payment previews and recordings call the real sales, purchasing, inventory, ledger and receivables services. Two companies are available so tenant isolation is demonstrable through the browser.

Draft fields stay in browser storage and are never treated as posted work. A preview is read-only, recording is explicitly confirmed, and repeat recording uses the service idempotency guarantees. Restarting the local server clears its synthetic company state and invalidates old sessions; the browser will ask the user to sign in again without discarding unfinished drafts.
