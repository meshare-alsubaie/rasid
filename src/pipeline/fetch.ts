/**
 * The polite fetcher.
 *
 * Spec section 5.1: at most 2 requests in flight overall, at least 1.5s between
 * requests to the same host, 20s timeout, 2 retries with exponential backoff,
 * and a persistent failure marks the source without failing the whole run.
 *
 * Two separate limits are enforced, because they answer different questions.
 * `p-limit` caps how much work we do at once. The per-host chain caps how hard
 * we lean on any single server: requests to one host are serialised and spaced,
 * so ten sources on stats.gov.sa never arrive as a burst.
 */
import pLimit from "p-limit";
import { fetch } from "undici";
import { MAX_CONCURRENT, MAX_RETRIES, TIMEOUT_MS, USER_AGENT } from "./agent.js";

export type FetchResult =
  | { ok: true; status: number; html: string; finalUrl: string; bytes: number }
  | { ok: false; status: number | null; error: string };

const globalLimit = pLimit(MAX_CONCURRENT);

/** host -> promise that resolves once that host is free to be hit again. */
const hostChain = new Map<string, Promise<void>>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serialise on the host and space the requests. Returns once it is this
 * caller's turn; the returned function must be called to release the host.
 */
async function takeHostSlot(host: string, gapMs: number): Promise<() => void> {
  const previous = hostChain.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The next caller waits for this one to finish AND for the gap to elapse.
  hostChain.set(
    host,
    previous.then(() => mine).then(() => sleep(gapMs)),
  );
  await previous;
  return release;
}

/** 5xx and 429 are worth retrying. A 404 is an answer, not a hiccup. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

async function attempt(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ar,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();

    if (res.status >= 400) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
      return {
        ok: false,
        status: res.status,
        error: `unexpected content-type "${contentType.split(";")[0] ?? contentType}"`,
      };
    }
    return {
      ok: true,
      status: res.status,
      html: body,
      // res.url is the url after redirects, which is what actually answered.
      finalUrl: res.url,
      bytes: Buffer.byteLength(body),
    };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run `fn` under this host's pacing rules. Exported so the headless-browser
 * path leans on exactly the same courtesy the plain fetcher does, rather than
 * quietly becoming a second crawler with its own manners.
 */
export async function paced<T>(url: string, gapMs: number, fn: () => Promise<T>): Promise<T> {
  const { host } = new URL(url);
  const release = await takeHostSlot(host, gapMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function fetchPage(url: string, gapMs: number): Promise<FetchResult> {
  return globalLimit(() =>
    paced(url, gapMs, async () => {
      let last: FetchResult = { ok: false, status: null, error: "not attempted" };
      for (let tryNo = 0; tryNo <= MAX_RETRIES; tryNo++) {
        if (tryNo > 0) await sleep(1000 * 2 ** (tryNo - 1)); // 1s, then 2s
        last = await attempt(url);
        if (last.ok) return last;
        if (last.status !== null && !isRetryableStatus(last.status)) return last;
      }
      return last;
    }),
  );
}

/** Test seam: forget per-host pacing state. */
export function resetHostPacing(): void {
  hostChain.clear();
}
