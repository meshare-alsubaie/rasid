/**
 * Find pages an organisation published that nobody added by hand.
 *
 * This closes the biggest hole in the product. The collector only ever fetched
 * urls someone had already written into `organisations.json`, and Saudi bodies
 * announce at fresh addresses — a new `/ar/news/news-0022`, not an edit to the
 * careers page. So an announcement could be published, sit there for its whole
 * window, and never be seen, no matter how faithfully the watched pages were
 * re-read.
 *
 * A sitemap answers the question in one request. This reads it, remembers the
 * url set, and on the next run reports what is new. A new url whose path talks
 * about training becomes a candidate source — `reported`, unverified, exactly
 * like any other lead — and `verify-leads` still has to open it before it
 * counts. Nothing here promotes anything on its own.
 *
 * Feeds are noted in the same pass: where an organisation publishes RSS or
 * Atom, that is a better thing to watch than scraped HTML, and it is published
 * for exactly this purpose.
 *
 *   npm run sitemaps                  every watched organisation
 *   npm run sitemaps -- --limit 20    a batch
 *   npm run sitemaps -- --dry-run     report, write nothing
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { closeBrowser } from "../src/pipeline/browser";
import { fetchPage } from "../src/pipeline/fetch";
import { checkRobots } from "../src/pipeline/robots";
import { looksLikeTraining, readSitemap } from "../src/pipeline/sitemap";
import type { Organisation } from "../src/types";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes("--dry-run");
const LIMIT = Number(flag("--limit") ?? Infinity);
const ONLY = flag("--org");

/** One organisation cannot flood a round with new candidates. */
const MAX_NEW_PER_ORG = 20;

const ORGS = "data/organisations.json";
const STATE = "data/sitemaps.json";

interface SitemapState {
  orgId: string;
  origin: string;
  /** null once we have established the site publishes none. */
  lastReadISO: string | null;
  urlCount: number;
  /** Every url seen so far, so "new" means new to us, not new to the site. */
  seen: string[];
  /** A feed the site declares. Cheaper and steadier than scraping. */
  feedUrl?: string;
  note?: string;
}

const read = <T>(p: string, fallback: T[]): T[] =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[]) : fallback;

const orgs = read<Organisation>(ORGS, []);
const state = read<SitemapState>(STATE, []);
const byOrg = new Map(state.map((s) => [`${s.orgId}|${s.origin}`, s]));

/** A feed the page declares in its own head. Not guessed. */
async function findFeed(origin: string): Promise<string | null> {
  const verdict = await checkRobots(origin);
  if (!verdict.allowed) return null;
  const res = await fetchPage(origin, verdict.crawlDelayMs);
  if (!res.ok) return null;
  try {
    const { document } = parseHTML(res.html);
    for (const link of document.querySelectorAll('link[rel~="alternate"]')) {
      const type = link.getAttribute("type") ?? "";
      const href = link.getAttribute("href");
      if (!href) continue;
      if (/application\/(rss|atom)\+xml/i.test(type)) return new URL(href, origin).href;
    }
  } catch {
    /* a page we cannot parse simply declares no feed */
  }
  return null;
}

const targets = orgs
  .filter((o) => (ONLY === undefined ? true : o.id === ONLY))
  .filter((o) => o.sources.some((s) => s.verifiedAtISO !== null))
  .slice(0, LIMIT);

console.log(`checking ${targets.length} organisation(s) for a sitemap they publish\n`);

const now = new Date().toISOString();
let withSitemap = 0;
let withFeed = 0;
let newCandidates = 0;
let firstRun = 0;

/**
 * Write what has been learned so far.
 *
 * Called after every organisation rather than once at the end, because once at
 * the end is what it was: a crash eleven organisations in threw away all
 * eleven, including one site that had declared 1,971 urls. A pass over a
 * hundred sites is long enough that losing it to a single bad value is not an
 * acceptable failure mode.
 */
function checkpoint(): void {
  if (DRY) return;
  writeFileSync(ORGS, JSON.stringify(orgs, null, 2) + "\n", "utf8");
  writeFileSync(
    STATE,
    JSON.stringify([...byOrg.values()].sort((a, b) => a.orgId.localeCompare(b.orgId)), null, 2) +
      "\n",
    "utf8",
  );
}

for (const org of targets) {
  // The origin of a verified source, because that is a host we know answers.
  const origins = [
    ...new Set(
      org.sources
        .filter((s) => s.verifiedAtISO !== null && typeof s.url === "string")
        .flatMap((s) => {
          try {
            return [new URL(s.url).origin];
          } catch {
            return [];
          }
        })
        .filter((o) => /^https?:\/\//i.test(o)),
    ),
  ];

  for (const origin of origins.slice(0, 2)) {
    try {
    const key = `${org.id}|${origin}`;
    const prior = byOrg.get(key);

    const entries = await readSitemap(origin);
    if (entries.length === 0) {
      byOrg.set(key, {
        orgId: org.id,
        origin,
        lastReadISO: now,
        urlCount: 0,
        seen: prior?.seen ?? [],
        feedUrl: prior?.feedUrl,
        note: "لا يعلن هذا الموقع خريطة روابط تُقرأ",
      });
      // No sitemap is exactly when a feed is worth having.
      if (prior?.feedUrl === undefined) {
        const feed = await findFeed(origin);
        if (feed) {
          withFeed++;
          byOrg.get(key)!.feedUrl = feed;
          console.log(`  ${org.id}: يعلن تغذية ${feed}`);
        }
      }
      continue;
    }

    withSitemap++;
    const known = new Set(prior?.seen ?? []);
    const all = entries.map((e) => e.url);

    /*
     * The first read of a site is not a discovery. Everything on it is "new" to
     * us and none of it is new to the world, so it is recorded as the baseline
     * and nothing is proposed. Only what appears afterwards is a change.
     */
    if (!prior) {
      firstRun++;
      byOrg.set(key, { orgId: org.id, origin, lastReadISO: now, urlCount: all.length, seen: all });
      console.log(`  ${org.id}: ${all.length} رابطاً، أوّل قراءة — تُتخذ أساساً للمقارنة`);
      continue;
    }

    const appeared = all.filter((u) => !known.has(u));
    const interesting = appeared.filter(looksLikeTraining).slice(0, MAX_NEW_PER_ORG);

    byOrg.set(key, {
      orgId: org.id,
      origin,
      lastReadISO: now,
      urlCount: all.length,
      seen: all,
      feedUrl: prior.feedUrl,
    });

    if (appeared.length > 0) {
      console.log(
        `  ${org.id}: ${all.length} رابطاً، ${appeared.length} جديد، ${interesting.length} منها يخصّ التدريب`,
      );
    }

    const existing = new Set(org.sources.map((s) => s.url.replace(/\/+$/, "").toLowerCase()));
    for (const url of interesting) {
      if (existing.has(url.replace(/\/+$/, "").toLowerCase())) continue;
      console.log(`      + ${url}`);
      org.sources.push({
        url,
        provenance: "reported",
        verifiedAtISO: null,
        verifiedNote: `ظهر في خريطة روابط الجهة بعد ${prior.lastReadISO ?? "القراءة السابقة"}، ومساره يخصّ التدريب أو التوظيف. لم يُفتح بعد.`,
        type: "announcement_page",
        checkFrequencyHours: 6,
        renderMode: "static",
      });
      newCandidates++;
    }
    } catch (err) {
      // One site's malformed anything must not cost the whole pass.
      console.log(`  ${org.id}: تعذّرت قراءة ${origin} — ${(err as Error).message.slice(0, 70)}`);
    }
  }
  checkpoint();
}

await closeBrowser();
checkpoint();

console.log(
  `\n${withSitemap} organisation(s) publish a readable sitemap, ${withFeed} declare a feed.` +
    `\n${firstRun} were read for the first time and recorded as a baseline.` +
    `\n${newCandidates} new candidate link(s) added${DRY ? " (dry run, nothing written)" : ""}.` +
    `\nnone is verified: run "npm run verify-leads" to open and judge them.`,
);
