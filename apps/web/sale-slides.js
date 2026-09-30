/**
 * Issue #305 — the slides of a bill: which one shows, the dots above them, and moving between them
 * by Next / Back, a swipe, or ← →. One decision per slide; the bill bar under them never moves.
 *
 * The sale screen decides what each slide holds and which optional slides a bill needs (transport,
 * export, ship to); this file only moves between the slides that are wanted, in page order.
 *
 *   mountSlides(frame, { wanted(id), onShow(id), words() })
 *     frame   the .slide-frame holding .slide-dots, [data-slide] sections and the step status line
 *     wanted  whether an optional slide is part of this bill right now (the four main ones always are)
 *     onShow  called after a slide is shown, with its id
 *     words   the dictionary: stepOf ("Step {step} of {count}: {title}")
 *   returns { show(id), next(), back(), current(), order(), isLast() }
 *
 * ← → move only between the slides before Done: arriving at Done means the bill was made, and a
 * bill is made by pressing Make bill, never by an arrow key or a swipe.
 */

const MAIN = new Set(["items", "customer", "payment", "done"]);

export function mountSlides(frame, { wanted = () => false, onShow = () => {}, words = () => ({}) } = {}) {
  const slides = () => [...frame.querySelectorAll("[data-slide]")];
  const order = () => slides().map((slide) => slide.dataset.slide).filter((id) => MAIN.has(id) || wanted(id));
  let now = slides()[0]?.dataset.slide ?? "items";

  /** The slides a person can walk between: everything but Done. */
  const walkable = () => order().filter((id) => id !== "done");

  function show(id, { focus = true } = {}) {
    const list = order();
    if (!list.includes(id)) return;
    const moved = id !== now;
    now = id;
    for (const slide of slides()) {
      const current = slide.dataset.slide === id;
      slide.hidden = !current;
      if (current && moved) {
        slide.classList.remove("entering");
        void slide.offsetWidth;
        slide.classList.add("entering");
      }
    }
    const dots = frame.querySelector(".slide-dots");
    if (dots) {
      dots.replaceChildren(...list.map((slideId) => {
        const dot = document.createElement("span");
        if (slideId === id) dot.setAttribute("data-current", "");
        return dot;
      }));
    }
    const heading = frame.querySelector(`[data-slide="${id}"] .slide-title, [data-slide="${id}"] h2`);
    const status = frame.querySelector("#sale-step");
    const template = words().stepOf;
    if (status && template) {
      status.textContent = template
        .replace("{step}", String(list.indexOf(id) + 1))
        .replace("{count}", String(list.length))
        .replace("{title}", heading?.textContent ?? "");
    }
    onShow(id);
    if (focus) heading?.focus?.({ preventScroll: false });
  }

  const step = (by) => {
    const list = walkable();
    const at = list.indexOf(now);
    const to = list[at + by];
    if (at >= 0 && to !== undefined) show(to);
    return to;
  };

  // ← → between slides, unless the key is editing a field (moving the caret in a number is not moving the bill).
  frame.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    if (event.target.closest?.("input, select, textarea, [contenteditable], .item-picker-list")) return;
    if (now === "done") return;
    event.preventDefault();
    step(event.key === "ArrowRight" ? 1 : -1);
  });

  // A sideways swipe on a phone: more across than down, and far enough to be meant.
  let start = null;
  frame.addEventListener("pointerdown", (event) => {
    start = event.pointerType === "touch" && !event.target.closest?.("input, select, textarea") ? { x: event.clientX, y: event.clientY } : null;
  });
  frame.addEventListener("pointerup", (event) => {
    if (start === null || now === "done") return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  });

  return {
    show,
    next: () => step(1),
    back: () => step(-1),
    current: () => now,
    order,
    /** True on the last slide before Done: its button makes the bill. */
    isLast: () => walkable().at(-1) === now,
  };
}

// Loaded as its own module before app.js, which is a plain script to its tests.
globalThis.KarobarSlides = { mountSlides };
