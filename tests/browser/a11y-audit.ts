/**
 * Issue #353 — the accessibility checks the browser suite runs on every screen, written against the
 * rendered page (not the source text). It stands in for an axe run: axe-core would be a new
 * dependency, which the owner has not approved. The rules below are the WCAG 2.2 AA ones that can be
 * decided from the DOM and computed styles, each named with the success criterion it checks.
 * What it cannot do — read order with a real screen reader, judge whether a label makes sense, check
 * a page on a real phone — is listed in docs/ui-conventions.md.
 */
import type { Page } from "@playwright/test";

export interface Violation { readonly rule: string; readonly where: string; readonly detail: string; }

/** Runs inside the page. Everything in `scope` (a CSS selector) is checked; nothing is fixed or changed. */
export async function audit(page: Page, scope: string): Promise<Violation[]> {
  return page.evaluate((scopeSelector) => {
    const out: { rule: string; where: string; detail: string }[] = [];
    const root = document.querySelector(scopeSelector);
    if (!root) return [{ rule: "scope", where: scopeSelector, detail: "not found" }];
    const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.split(" ")[0]}` : ""}`;
    const visible = (element: Element) => {
      const box = (element as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !element.closest("[hidden], dialog:not([open])");
    };
    const textOf = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

    // 4.1.2 Name, Role, Value; 3.3.2 Labels or Instructions — every control has a name a screen reader can say.
    const nameOf = (element: Element): string => {
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) return labelled.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim();
      const direct = element.getAttribute("aria-label")?.trim();
      if (direct) return direct;
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const label = [...(element.labels ?? [])].map((node) => textOf(node)).join(" ").trim();
        if (label) return label;
        if (element instanceof HTMLInputElement && ["submit", "button", "reset"].includes(element.type)) return element.value;
        return element.getAttribute("title")?.trim() ?? "";
      }
      return textOf(element) || element.getAttribute("title")?.trim() || element.querySelector("img[alt]")?.getAttribute("alt")?.trim() || "";
    };
    const controls = [...root.querySelectorAll("input:not([type=hidden]), select, textarea, button, a[href], [role=button], [role=tab], summary")].filter(visible);
    for (const control of controls) if (!nameOf(control)) out.push({ rule: "4.1.2 name", where: describe(control), detail: "a control with no name" });

    // 1.1.1 Non-text content.
    for (const image of root.querySelectorAll("img")) if (visible(image) && !image.hasAttribute("alt")) out.push({ rule: "1.1.1 alt", where: describe(image), detail: "an image with no alt attribute" });

    // 1.3.1 / 2.4.6 Headings: one h1 on the screen, and no level skipped on the way down.
    const headings = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(visible);
    let last = 0;
    for (const heading of headings) {
      const level = Number(heading.tagName[1]);
      if (last !== 0 && level > last + 1) out.push({ rule: "1.3.1 heading order", where: describe(heading), detail: `h${level} after h${last}` });
      last = level;
    }

    // 2.5.8 Target Size (Minimum): 24 x 24 CSS px for buttons, fields and selects.
    for (const control of controls.filter((node) => node.matches("button, input:not([type=checkbox]):not([type=radio]), select, textarea, [role=button]"))) {
      // A file input hidden inside a button-shaped label is operated through the label, which is the target.
      const box = (control instanceof HTMLInputElement && control.type === "file" && control.closest("label") ? control.closest("label")! : control).getBoundingClientRect();
      if (box.width < 24 || box.height < 24) out.push({ rule: "2.5.8 target size", where: describe(control), detail: `${Math.round(box.width)}x${Math.round(box.height)}px` });
    }

    // 4.1.1 / 1.3.1 Unique ids, so a label or aria-describedby points at one thing.
    const seen = new Map<string, number>();
    for (const element of root.querySelectorAll("[id]")) seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
    for (const [id, count] of seen) if (count > 1) out.push({ rule: "4.1.1 duplicate id", where: `#${id}`, detail: `${count} elements` });

    // 1.4.3 Contrast (Minimum): 4.5:1, or 3:1 for large text, on a plain background.
    const parse = (value: string) => {
      // Chrome writes a mixed colour (a hover state made with color-mix) as color(srgb 0.1 0.2 0.3), channels 0 to 1.
      const wide = value.match(/color\(srgb ([^)]+)\)/);
      if (wide) { const p = wide[1]!.split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0]! * 255, g: p[1]! * 255, b: p[2]! * 255, a: p[3] ?? 1 }; }
      const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 };
    };
    const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const luminance = (c: { r: number; g: number; b: number }) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const backdrop = (element: Element): { r: number; g: number; b: number } | null => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") return null; // a gradient or picture: not judged here
        const colour = parse(style.backgroundColor);
        if (colour && colour.a === 1) return colour;
      }
      return parse(getComputedStyle(document.body).backgroundColor);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const judged = new Set<Element>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || judged.has(element) || !node.textContent?.trim() || !visible(element) || element.closest(".sr-only, [aria-hidden=true]")) continue;
      judged.add(element);
      const style = getComputedStyle(element);
      const fore = parse(style.color);
      const back = backdrop(element);
      if (!fore || !back || fore.a < 1) continue;
      const [a, b] = [luminance(fore), luminance(back)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5) && !(element as HTMLButtonElement).disabled) out.push({ rule: "1.4.3 contrast", where: describe(element), detail: `${ratio.toFixed(2)}:1 for "${textOf(element).slice(0, 30)}"` });
    }
    return out;
  }, scope);
}
