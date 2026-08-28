# Web development preview — issue #38

Run from the repository root:

```sh
npm run web
```

Open `http://127.0.0.1:4173`. No installation beyond the repository's normal `npm install` is required.

## Manual verification

1. Resize the window below 760 pixels. The left navigation becomes a bottom navigation bar and every transaction form becomes one column.
2. Change **English** to **हिन्दी**. Navigation, headings, controls, help text, status wording and screen-reader labels change together.
3. Open **Sale**, enter a customer, item, quantity and rate. The Indian-formatted total updates immediately.
4. Reload the page. The unfinished sale is restored from this device and remains clearly described as a draft.
5. Open **Purchase** and **Payment**. Confirm each flow explains what will and will not change before review.
6. Use only the keyboard. Focus remains visible and all fields, navigation items, language selection and review actions are reachable.
7. Run `npm run verify`. The web checks enforce translation completeness, semantic flow structure, draft recovery hooks, responsive behavior, reduced-motion support and safe static asset serving.

## Current boundary

This milestone is a development preview backed by realistic synthetic data. It deliberately stops before posting a sale, purchase or payment. Those actions must be connected to their owning platform and business-module contracts with authenticated tenant context, permissions, approval and idempotency. Until that integration lands, the yellow preview banner and review dialog make the boundary explicit.
