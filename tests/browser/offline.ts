/**
 * Issue #496 — nothing leaves this machine. The browser specs that ported the old Puppeteer tests
 * refuse any request to a host other than the local server (the web fonts have system fallbacks),
 * so a test never depends on, or leaks to, the internet.
 */
import type { Page } from "@playwright/test";

export async function keepOffline(page: Page, origin: string) {
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    return route.abort();
  });
}
