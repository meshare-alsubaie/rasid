/**
 * The headless-browser escape hatch, kept deliberately small.
 *
 * A handful of the best sources in this dataset paint themselves with
 * JavaScript and hand a plain fetcher an empty shell. Losing them is not
 * acceptable, but neither is turning every request into a browser launch. So
 * this path is opt-in per source (`renderMode: "browser"`), capped at
 * MAX_BROWSER_SOURCES, and bound by the same rules as the static fetcher:
 * robots.txt is still consulted by the caller, the User-Agent is the same, and
 * requests are still paced per host.
 *
 * Chromium only, one page at a time, `networkidle` with a 15s ceiling. If the
 * browser cannot even launch, which is what happens in CI when the download
 * step failed, every call fails cheaply and the static half of the run carries
 * on. A missing browser must degrade the run, never end it.
 */
import { chromium, type Browser } from "playwright";
import { USER_AGENT } from "./agent";
import type { FetchResult } from "./fetch";

const NAV_TIMEOUT_MS = 15_000;
/** How long to keep waiting for a page to paint after the DOM is in place. */
const SETTLE_TIMEOUT_MS = 9_000;

let browser: Browser | null = null;
let launchError: string | null = null;

async function getBrowser(): Promise<Browser | null> {
  if (browser) return browser;
  if (launchError) return null; // already tried and failed; do not retry per source
  try {
    browser = await chromium.launch({
      headless: true,
      // /dev/shm is tiny in containers and a cramped renderer is what produces
      // the "Page crashed" failures these heavy portals trigger.
      args: ["--disable-dev-shm-usage"],
    });
    return browser;
  } catch (err) {
    launchError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/** We want text. Images, fonts and video cost memory and buy nothing. */
const HEAVY = new Set(["image", "font", "media"]);

/**
 * Chromium's own identity, with ours appended.
 *
 * Replacing the browser's User-Agent with the bare crawler string made a real
 * browser announce itself as a bot, and at least one government WAF answered
 * that with a block page: GACA returned "This page can't be displayed" to the
 * same request that returns five thousand characters otherwise.
 *
 * Deleting our name to get in would be spoofing, and this project does not do
 * that. Adding it does the opposite — the string is now true twice over: this
 * *is* Chromium, and it says who is driving it and how to reach them. Nothing
 * is hidden; something that was missing was restored.
 */
async function agentFor(b: Browser): Promise<string> {
  if (chromiumAgent === null) {
    const probe = await b.newContext();
    const page = await probe.newPage();
    chromiumAgent = (await page.evaluate("navigator.userAgent")) as string;
    await probe.close();
  }
  return `${chromiumAgent} ${USER_AGENT}`;
}

let chromiumAgent: string | null = null;

async function once(b: Browser, url: string): Promise<FetchResult> {
  const context = await b.newContext({ userAgent: await agentFor(b), locale: "ar-SA" });
  await context.route("**/*", (route) =>
    HEAVY.has(route.request().resourceType()) ? route.abort() : route.continue(),
  );
  const page = await context.newPage();
  try {
    /*
     * Wait for the document, then for the text — not for "network idle".
     *
     * Idle was the wrong signal and it cost real sources. These portals keep
     * polling analytics and chat sockets, so the network never goes quiet, and
     * `goto` simply timed out; whatever half-painted shell existed at that
     * moment was what got extracted. GACA came back with 149 characters and was
     * written off as unreadable, and the same page yields 5,127 when asked this
     * way. Three of the four "cannot be read" sources were this bug.
     *
     * So: wait for the DOM, then poll until the body carries a paragraph's
     * worth of text, and give up quickly if it never does. A page that really
     * is empty should not cost ten seconds.
     */
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    await page
      .waitForFunction("(document.body?.innerText || '').trim().length > 400", null, {
        timeout: SETTLE_TIMEOUT_MS,
        polling: 250,
      })
      .catch(() => {
        /* Some pages really are this thin; take what is there. */
      });

    // Serialising the whole DOM is what kills the renderer on the heaviest
    // portals. If page.content() dies, ask the page for its rendered text
    // instead and wrap it: extraction then reports body_fallback, which is
    // exactly what it is. Losing Readability's cleanup beats losing the source.
    let html: string;
    try {
      html = await page.content();
    } catch {
      // Passed as a string: this project does not load the DOM lib, and a
      // typed callback would drag it in for one expression.
      const text = (await page.evaluate(
        "document.body ? document.body.innerText : ''",
      )) as string;
      html = `<!doctype html><html><body>${text.replace(/[<>&]/g, " ")}</body></html>`;
    }

    const status = res?.status() ?? null;
    if (status !== null && status >= 400) {
      return { ok: false, status, error: `HTTP ${status}` };
    }
    return {
      ok: true,
      status: status ?? 200,
      html,
      finalUrl: page.url(),
      bytes: Buffer.byteLength(html),
    };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await context.close();
  }
}

export async function renderPage(url: string): Promise<FetchResult> {
  const b = await getBrowser();
  if (!b) {
    return {
      ok: false,
      status: null,
      error: `headless chromium unavailable (${launchError}); run "npx playwright install chromium"`,
    };
  }

  const first = await once(b, url);
  // A crashed renderer is worth exactly one more try; a 404 is not.
  if (first.ok || !/crash/i.test(first.error)) return first;
  return once(b, url);
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** True once a launch has been attempted and failed. */
export const browserUnavailable = (): boolean => launchError !== null;
