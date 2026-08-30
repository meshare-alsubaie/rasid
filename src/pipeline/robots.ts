/**
 * The robots.txt gate.
 *
 * Spec section 5.1: respect robots.txt, skip disallowed paths, and record the
 * skip in health.json rather than hiding it.
 *
 * Failure handling follows RFC 9309, and the asymmetry is deliberate:
 *   4xx            -> no robots file exists, crawling is unrestricted
 *   5xx / network  -> treat as fully disallowed for this run
 * A server that is briefly broken must never be read as a server that granted
 * permission. Skipping a source for a run is cheap; crawling a host that told
 * us not to is not.
 */
import robotsParser from "robots-parser";
import { fetch } from "undici";
import { MAX_RETRIES, PER_HOST_GAP_MS, TIMEOUT_MS, USER_AGENT } from "./agent.js";
import { renderPage } from "./browser.js";
import { paced } from "./fetch.js";

export interface RobotsVerdict {
  allowed: boolean;
  /** Why it was blocked. null when allowed. Goes straight into health.json. */
  reason: string | null;
  /** Crawl-delay the host asked for, in ms. Never below our own floor. */
  crawlDelayMs: number;
}

type Entry =
  | { kind: "rules"; robots: ReturnType<typeof robotsParser> }
  | { kind: "allow_all" }
  | { kind: "deny_all"; reason: string };

const cache = new Map<string, Promise<Entry>>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retried like any other fetch, and for a reason worth stating: a robots.txt
 * that cannot be reached denies the whole host, so one flaky moment on our own
 * connection would silently mute every source on that domain and mark them all
 * degraded. The policy stays strict; it just stops firing on a hiccup. Note
 * the two failure messages differ - a 5xx is the site's, a connection error is
 * ours - so health.json never blames a site for our network.
 */
async function load(origin: string): Promise<Entry> {
  const url = `${origin}/robots.txt`;
  let lastError = "not attempted";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, then 2s
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "text/plain,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();

      if (res.status >= 400 && res.status < 500) return { kind: "allow_all" };
      if (res.status >= 500) {
        lastError = `robots.txt returned ${res.status}; RFC 9309 treats a server error as disallow`;
        continue; // a 5xx is worth another try before muting the host
      }
      return { kind: "rules", robots: robotsParser(url, body) };
    } catch (err) {
      lastError = `could not reach robots.txt after ${attempt + 1} attempt(s) (${
        err instanceof Error ? err.message : String(err)
      }); this is our connection, not the site, and we do not crawl without reading it`;
    }
  }

  /*
   * Last resort: fetch robots.txt with a real browser.
   *
   * A plain HTTP client and a browser are not equally welcome. Several hosts
   * that answer Chromium refuse undici outright, and the result was that we
   * denied ourselves twenty-two sources on the strength of a transport
   * failure rather than anything the site had said.
   *
   * This is not a way around robots.txt. It is a way to *read* it: the file is
   * still fetched, still parsed, and still obeyed. Only the client changed,
   * and to a real browser rather than a plain client wearing a browser's name.
   */
  const rendered = await paced(url, PER_HOST_GAP_MS, () => renderPage(url));
  if (rendered.ok) {
    const text = rendered.html.replace(/<[^>]+>/g, "").trim();
    /*
     * It has to look like a robots file before it is treated as one.
     *
     * Without this check the fallback could turn a refusal into permission: a
     * host answering 200 with a block page or a Cloudflare interstitial parses
     * to zero rules, and zero rules means everything is allowed. That is the
     * one direction this gate must never fail in, so an unrecognisable body is
     * a denial, exactly like no answer at all.
     */
    if (/^\s*(user-agent|allow|disallow|sitemap|crawl-delay)\s*:/im.test(text)) {
      return { kind: "rules", robots: robotsParser(url, text) };
    }
    return {
      kind: "deny_all",
      reason: `${lastError}; a browser reached it but the body was not a robots.txt, so it is treated as a refusal`,
    };
  }

  return { kind: "deny_all", reason: `${lastError}; a browser could not reach it either` };
}

/** Cached per origin, so one robots.txt fetch covers every source on that host. */
export async function checkRobots(target: string): Promise<RobotsVerdict> {
  const { origin } = new URL(target);
  let entry = cache.get(origin);
  if (!entry) {
    entry = load(origin);
    cache.set(origin, entry);
  }
  const resolved = await entry;

  if (resolved.kind === "allow_all") {
    return { allowed: true, reason: null, crawlDelayMs: PER_HOST_GAP_MS };
  }
  if (resolved.kind === "deny_all") {
    return { allowed: false, reason: resolved.reason, crawlDelayMs: PER_HOST_GAP_MS };
  }

  const allowed = resolved.robots.isAllowed(target, USER_AGENT);
  // `undefined` means the parser could not decide. Undecided is not consent.
  if (allowed === undefined) {
    return {
      allowed: false,
      reason: "robots.txt could not be interpreted for this path; treated as disallow",
      crawlDelayMs: PER_HOST_GAP_MS,
    };
  }

  const delaySec = resolved.robots.getCrawlDelay(USER_AGENT);
  return {
    allowed,
    reason: allowed ? null : "disallowed by robots.txt",
    // Honour a longer crawl-delay, never a shorter one than our own floor.
    crawlDelayMs: Math.max(PER_HOST_GAP_MS, (delaySec ?? 0) * 1000),
  };
}

/**
 * Re-check robots.txt when a fetch lands on a different host than it asked for.
 *
 * Redirects are followed, but permission was only ever asked of the origin we
 * started from. `bankalbilad.com` redirecting to `bankalbilad.com.sa` is a real
 * case in this dataset: the page that was read, stored and re-fetched every six
 * hours belonged to a host whose robots.txt had never been consulted. Same
 * origin needs no second question, so this costs nothing in the normal case.
 */
export async function checkFinalUrl(
  requested: string,
  finalUrl: string | undefined,
): Promise<RobotsVerdict | null> {
  if (!finalUrl) return null;
  try {
    if (new URL(finalUrl).origin === new URL(requested).origin) return null;
  } catch {
    return null;
  }
  const verdict = await checkRobots(finalUrl);
  return verdict.allowed
    ? null
    : {
        ...verdict,
        reason: `redirected to ${new URL(finalUrl).origin}, whose robots.txt refuses it: ${verdict.reason}`,
      };
}

/** Test seam: forget cached robots.txt files. */
export function resetRobotsCache(): void {
  cache.clear();
}
