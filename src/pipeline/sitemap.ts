/**
 * Reading an organisation's sitemap, so a new page cannot hide from us.
 *
 * The blind spot this closes is the largest one in the product. Until now the
 * collector only ever fetched urls a person had already written down, and Saudi
 * bodies overwhelmingly announce at a *new* address — `/ar/news/news-0022`,
 * `/media-center/2093` — rather than by editing a standing careers page. An
 * announcement published at an address nobody had added was invisible, however
 * many times the watched pages were re-read.
 *
 * A sitemap fixes that at a better price than crawling. One request returns
 * every url the site is willing to declare, with the date each last changed:
 * Aramco declares 2,648, the National Cybersecurity Authority 1,842. So the
 * whole site becomes watchable for the cost of a single fetch, and only the
 * handful of urls that are both new and plausibly about training are ever
 * opened.
 *
 * It is also the polite way to do it. A sitemap is published *for* crawlers,
 * `robots.txt` names it, and reading it replaces requests rather than adding
 * them.
 */
import { XMLParser } from "fast-xml-parser";
import { fetchPage } from "./fetch.js";
import { checkRobots } from "./robots.js";

export interface SitemapEntry {
  url: string;
  /** When the site says it last changed. Absent on many sitemaps. */
  lastmod: string | null;
}

/** Sitemaps of sitemaps are common; this is how deep we will follow them. */
const MAX_INDEX_DEPTH = 2;

/** One organisation cannot be allowed to flood a run. */
export const MAX_URLS_PER_SITEMAP = 5_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  isArray: (name) => name === "url" || name === "sitemap",
});

/**
 * Where a site might declare its sitemap.
 *
 * `robots.txt` first, always, because that is the site telling us itself. The
 * two conventional paths are tried only when it does not, and they are not
 * guesses in the sense this project forbids: `/sitemap.xml` is a published
 * convention with a registered meaning, not a url invented by analogy with
 * another site. Whatever comes back still has to parse as a sitemap.
 */
export async function sitemapCandidates(origin: string): Promise<string[]> {
  // Guarded because it was not, and a single bad value took the whole pass with
  // it: `${undefined}/sitemap.xml` reached `new URL` and threw, after eleven
  // organisations had been read and before any of them had been written.
  if (typeof origin !== "string" || !/^https?:\/\//i.test(origin)) return [];

  const found: string[] = [];
  const verdict = await checkRobots(`${origin}/robots.txt`);
  if (!verdict.allowed) return [];

  const res = await fetchPage(`${origin}/robots.txt`, verdict.crawlDelayMs);
  if (res.ok) {
    for (const line of res.html.split("\n")) {
      const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
      if (m?.[1]) found.push(m[1]);
    }
  }
  if (found.length === 0) found.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
  return [...new Set(found)];
}

function entriesFrom(xml: string): { urls: SitemapEntry[]; indexes: string[] } {
  const doc = parser.parse(xml) as {
    urlset?: { url?: { loc?: string; lastmod?: string }[] };
    sitemapindex?: { sitemap?: { loc?: string }[] };
  };

  const urls: SitemapEntry[] = (doc.urlset?.url ?? [])
    .filter((u) => typeof u.loc === "string")
    .map((u) => ({ url: String(u.loc), lastmod: u.lastmod ? String(u.lastmod) : null }));

  const indexes: string[] = (doc.sitemapindex?.sitemap ?? [])
    .filter((s) => typeof s.loc === "string")
    .map((s) => String(s.loc));

  return { urls, indexes };
}

/**
 * Every url an origin declares, following sitemap indexes to a fixed depth.
 *
 * robots.txt is consulted for each sitemap fetched, not only for the first: an
 * index can point at a path on the same host that the site would rather we left
 * alone, and permission for one path is not permission for another.
 */
export async function readSitemap(
  origin: string,
  depth = 0,
  seen = new Set<string>(),
): Promise<SitemapEntry[]> {
  if (depth > MAX_INDEX_DEPTH) return [];
  if (typeof origin !== "string" || !/^https?:\/\//i.test(origin)) return [];

  const candidates = depth === 0 ? await sitemapCandidates(origin) : [origin];
  const out: SitemapEntry[] = [];

  for (const candidate of candidates) {
    // A `Sitemap:` line in robots.txt is whatever the site wrote there, and an
    // index can name anything at all. Neither is a url until it parses as one.
    if (typeof candidate !== "string" || !/^https?:\/\//i.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const verdict = await checkRobots(candidate);
    if (!verdict.allowed) continue;

    const res = await fetchPage(candidate, verdict.crawlDelayMs);
    if (!res.ok) continue;
    // A site with no sitemap usually answers the conventional path with its
    // homepage rather than a 404, so the body decides, not the status code.
    if (!/<(urlset|sitemapindex)/i.test(res.html)) continue;

    let parsed: ReturnType<typeof entriesFrom>;
    try {
      parsed = entriesFrom(res.html);
    } catch {
      continue; // malformed xml is not a reason to fail a run
    }

    out.push(...parsed.urls);
    for (const index of parsed.indexes) {
      if (out.length >= MAX_URLS_PER_SITEMAP) break;
      out.push(...(await readSitemap(index, depth + 1, seen)));
    }
    if (out.length >= MAX_URLS_PER_SITEMAP) break;
  }

  return out.slice(0, MAX_URLS_PER_SITEMAP);
}

/**
 * What a url has to look like before it is worth opening.
 *
 * Deliberately the same vocabulary the link discovery uses, and deliberately
 * narrow: "co-op" but not "cooperation", which once dragged two ministries'
 * international-partnership pages into the dataset. Matching here decides only
 * that a page is worth *reading*; whether it is an announcement is still the
 * classifier's judgement, and whether it becomes a permanent source still
 * depends on that verdict.
 */
export const TRAINING_PATH =
  /تدريب|تعاون[يى]|متدرب|طلاب|طالبات|وظائف|توظيف|\bco-?op(?!erat)|internship|trainee|training|career|job|recruit/i;

export function looksLikeTraining(url: string): boolean {
  try {
    return TRAINING_PATH.test(decodeURI(new URL(url).pathname));
  } catch {
    return TRAINING_PATH.test(url);
  }
}
