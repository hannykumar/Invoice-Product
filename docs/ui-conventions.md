# UI conventions for `apps/web` (issue #353)

Every screen is built from the same few pieces, so a shopkeeper meets the same behaviour everywhere
and a screen added next week does not have to invent its own. The living reference is the **design
page**: open `/design` (or `#design`) as the owner. It draws every piece below in every state, from
the same code the screens use.

## The four states

A screen that reads from the books is one of three kinds, declared on its `<section class="view">`:

| `data-screen=` | Meaning | Must have |
| --- | --- | --- |
| `data` | Reads something from the server to show | one `<div class="screen-state" id="screen-state-<view>" data-state-region>` right after the page heading |
| `form` | Takes input and sends it | pending buttons and a plain-words failure (see below) |
| `static` | Fixed content (the More menu, the design page) | nothing |

For a `data` screen, `readScreen(view, { load, render, isEmpty, empty, content, quiet })` in `app.js`
(a thin wrapper over `KarobarStates.loadInto` in `states.js`) runs the read through:

1. **Loading** — grey bars where the content will be, a polite "Loading…" for a screen reader,
   `aria-busy="true"` on the region. `quiet: true` keeps what is on screen on a refresh.
2. **Empty** — what is missing, in one sentence, and one button for the next step
   (`empty: { message, action: { label, run } }`).
3. **Error** — what happened in words, what to do, and **Try again**. A network failure, a server
   fault and a refusal the server worded itself each get the right sentence; a status code, an id or a
   stack trace is never shown. The failure is also announced at once (`role="alert"`).
4. **Ready** — `render(data)` draws. A drawing fault is reported as an error, not a blank page.

The region carries `data-state="loading|empty|error|ready"`. Browser tests read it, so use the helper
rather than writing your own. A late answer never overwrites a newer one, and Try again keeps focus.

Where several functions read into one screen (a list and a dropdown), use
`screenFailed(view, error, retry)` and `screenOk(view)` to put the same error block in the region.

## Actions and forms

* `api()` turns "no network" into the plain sentence (`stateOffline`) and a non-JSON/5xx reply into
  `stateServerProblem`.
* A form that has just been submitted has its submit buttons switched off, with `aria-busy`, until
  the write answers, so it cannot be sent twice. (`api()` does this for every non-GET call made within
  a second of a `submit` event.)
* For a button that is not a form, `KarobarStates.runAction(button, { words, run, success, status })`
  does the same and announces success (polite) or failure (urgent).
* A field with a problem gets `aria-invalid="true"`, the explanation beside it linked with
  `aria-describedby`, and focus. Colour is never the only signal: error blocks start with `!`, success
  lines with `✓`.
* Announcements go through `KarobarStates.announce(text, { urgent })`.

## Keyboard

Everything works with a keyboard alone: Tab / Shift+Tab move, Enter or Space press, Esc closes a
box and hands focus back to the button that opened it (every box is a native `<dialog>` opened with
`showModal()`, which traps focus and makes the page behind inert). F2 or Alt+N starts a new bill. The
first Tab stop of a page is **Skip to main content**, which moves focus to the main part and stays on
the current screen. Moving to a screen focuses its heading. The list is on the design page.

## Accessibility target and checks

Target: **WCAG 2.2 level AA**. `tests/browser/a11y-audit.ts` checks every screen, light and dark,
at 375 px and 1100 px, from the rendered page: names on every control (4.1.2), alt text (1.1.1),
heading order (1.3.1), target size ≥ 24 px (2.5.8), unique ids, contrast 4.5:1 / 3:1 (1.4.3), no
sideways scrolling at 375 px (1.4.10). `accessibility.spec.ts` adds keyboard reach and visible focus on
the busiest screens, dialog trapping and Esc, the skip link, F2, reduced motion (2.3.3 / `prefers-reduced-motion`)
and inline field errors. `screen-states.spec.ts` drives loading, empty, error (offline, 503) and
ready, and reads the list of screens from the page, so a screen without a state region fails.

**Not verified** — say so in every PR that touches this:

* No real screen reader (NVDA, VoiceOver, TalkBack) was used. Live-region behaviour and reading order
  are checked by their markup, not by listening.
* No real phone. 375 px is emulated in Chromium.
* No axe-core run: it would be a new dependency and needs the owner's approval. `a11y-audit.ts` is
  the stand-in and is shaped so axe can be added beside it.
* Contrast is judged where the background is a plain colour; text on gradients or pictures is skipped.
* Criteria that need a person (meaningful link text, consistent help, cognitive load) are not tested.
* Screens that only read dropdown lists for a form (Setup, Supplier check, Sale…) show a plain failure
  when the form is used, not a state region of their own.
