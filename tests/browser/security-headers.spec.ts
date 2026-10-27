/**
 * Issue #349 (ported from Puppeteer by #496) — the page under its content policy, in a real
 * browser: the app signs in and draws a bill with no policy violation, a name typed as
 * `<script>alert(1)</script>` shows as text and runs nothing, and a script slipped into a bill
 * frame is blocked by the policy itself. Issue #399 — the bill frame's sandbox blocks that script
 * too with the policy switched off, and the page can still print the frame.
 *
 * The header check that needs no browser (every file carries the security headers) stays a unit
 * test, apps/web/test/security-headers.test.ts. Nothing here leaves this machine: requests to
 * anywhere but the local server are refused (the web fonts have system fallbacks).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { addCustomer, apiSignIn, baseURL, signIn } from "./helpers.ts";
import { keepOffline } from "./offline.ts";

const HOSTILE = "<script>alert(1)</script><img src=x onerror=alert(2)>";

type Watched = { dialogs: string[]; violations: string[] };

/** A page that refuses the internet and records every dialog and every policy violation it sees. */
async function watch(page: Page): Promise<Watched> {
  const watched: Watched = { dialogs: [], violations: [] };
  await keepOffline(page, baseURL());
  page.on("dialog", (dialog) => { watched.dialogs.push(dialog.message()); void dialog.dismiss(); });
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) watched.violations.push(message.text()); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return watched;
}

/** Waits until the frame has drawn the `srcdoc` that carries this marker. */
const framed = (page: Page, frame: string, marker: string) =>
  expect(page.frameLocator(frame).locator(`#${marker}`)).toBeAttached();

test("the app signs in and draws a bill under the policy, and a hostile name stays text", async ({ page, request }) => {
  const watched = await watch(page);
  const cookie = await apiSignIn(request);
  // Different enough every run: the app refuses a second customer whose name is the same or very close.
  const hostile = `${randomUUID()} ${HOSTILE}`;
  await addCustomer(request, cookie, hostile);

  await page.goto("/");
  await signIn(page);
  await page.goto("/#sale");
  // The customer list now holds the hostile name: it must be an option's text, not markup.
  await expect.poll(() => page.evaluate((name) => [...document.querySelectorAll("option")].some((option) => option.textContent === name), hostile)).toBe(true);

  // The bill design screen draws a whole printed bill in an `srcdoc` frame, inline styles and all.
  await page.evaluate(() => { location.hash = "branding"; });
  await expect.poll(() => page.evaluate(() => ((document.querySelector("#branding-preview") as HTMLIFrameElement | null)?.srcdoc ?? "").length)).toBeGreaterThan(1000);
  await expect(page.frameLocator("#branding-preview").locator("body")).not.toBeEmpty();

  expect(watched.dialogs, "nothing typed into a field ran as script").toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])).toEqual([]);
  expect(watched.violations).toEqual([]);
});

test("a script slipped into a bill frame is stopped by the policy, not just by escaping", async ({ page }) => {
  const watched = await watch(page);
  await page.goto("/");
  await signIn(page);
  await page.evaluate(() => { location.hash = "branding"; });
  await expect.poll(() => page.evaluate(() => ((document.querySelector("#branding-preview") as HTMLIFrameElement | null)?.srcdoc ?? "").length)).toBeGreaterThan(1000);

  await page.evaluate(() => {
    const frame = document.querySelector("#branding-preview") as HTMLIFrameElement;
    // Take the #399 sandbox off so this proves the policy on its own.
    frame.removeAttribute("sandbox");
    frame.srcdoc = '<p id="slipped">bill</p><script>parent.__ran = true</script><img src=x onerror="parent.__ran = true">';
  });
  await framed(page, "#branding-preview", "slipped");
  await expect.poll(() => watched.violations.some((text) => /script-src/.test(text)), { message: `a policy violation was reported: ${watched.violations.join(" | ")}` }).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();
});

test("with the policy switched off, the bill frame sandbox still stops a script and the page can still print it", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: baseURL(), bypassCSP: true });
  try {
    const loose = await context.newPage();
    await keepOffline(loose, baseURL());
    loose.on("dialog", (dialog) => { void dialog.dismiss(); });
    await loose.goto("/");
    await loose.evaluate(() => { localStorage.setItem("karobar.session", "stand-in-session"); });

    const hostile = (marker: string) => `<p id="${marker}">bill</p><script>parent.__ran = localStorage.getItem("karobar.session") ?? "ran"</script><img src=x onerror="parent.__ran = 'img'">`;
    let round = 0;
    /** Puts the hostile bill in the frame, waits for it to be drawn, and says what ran. */
    const ran = async (keepSandbox: boolean) => {
      const marker = `bill${round += 1}`;
      await loose.evaluate(([html, keep]) => {
        delete (window as unknown as { __ran?: string }).__ran;
        const frame = document.querySelector("#branding-preview") as HTMLIFrameElement;
        if (!keep) frame.removeAttribute("sandbox");
        frame.srcdoc = html as string;
      }, [hostile(marker), keepSandbox] as const);
      await framed(loose, "#branding-preview", marker);
    };
    const result = () => loose.evaluate(() => (window as unknown as { __ran?: string }).__ran);

    expect(await loose.evaluate(() => document.querySelector("#branding-preview")?.getAttribute("sandbox"))).toBe("allow-same-origin allow-modals");
    await ran(true);
    expect(await result(), "a script inside the sandboxed bill frame ran").toBeUndefined();

    await loose.evaluate(() => {
      (document.querySelector("#note-frame") as HTMLIFrameElement).srcdoc = "<p>Printed note</p>";
    });
    await expect.poll(() => loose.evaluate(() => (document.querySelector("#note-frame") as HTMLIFrameElement).contentDocument?.body?.textContent)).toBe("Printed note");
    // Printing is `contentWindow.print()` from the page: it must reach the frame and not be refused.
    const refused: string[] = [];
    loose.on("console", (message) => { if (/print\(\)/.test(message.text())) refused.push(message.text()); });
    expect(await loose.evaluate(() => {
      try { (document.querySelector("#note-frame") as HTMLIFrameElement).contentWindow!.print(); return "printed"; } catch (error) { return String(error); }
    }), "the page could not reach the bill frame to print it").toBe("printed");
    // A round trip to the page: any console message the print raised has been delivered before it returns.
    await loose.evaluate(() => 0);
    expect(refused, "the browser refused to print the sandboxed bill frame").toEqual([]);

    // The same page with the sandbox taken off does run it, so the check above is not vacuous.
    await ran(false);
    await expect.poll(result, { message: "without a sandbox and with the policy off the script should have run" }).toBeTruthy();
  } finally {
    await context.close();
  }
});
