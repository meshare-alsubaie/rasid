/**
 * Find an organisation's own training and careers pages, by reading its site.
 *
 * Most records point only at a homepage, which is watched because an
 * announcement *might* surface there. That is weak, and the owner said so: an
 * organisation should be watched where it actually publishes — its careers
 * page, its training page, its news page — and on all of them at once, not on
 * whichever link happened to be recorded first.
 *
 * The rule that governs the whole project still holds: no url is invented. This
 * does not guess `example.com/careers`. It opens a page already verified as the
 * organisation's own, reads the links *that organisation put there*, and keeps
 * the ones whose own text says what they are. A link written by the site is
 * evidence from the site. Everything found enters as `reported` with no
 * verification date, exactly like any other lead, and `verify-leads` still has
 * to open it before it counts.
 *
 *   npm run discover                 every watched organisation
 *   npm run discover -- --limit 20   a batch
 *   npm run discover -- --dry-run    report, write nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { closeBrowser, renderPage } from "../src/pipeline/browser";
import { fetchPage, paced } from "../src/pipeline/fetch";
import { checkRobots } from "../src/pipeline/robots";
import type { Organisation, SourceType } from "../src/types";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes("--dry-run");
const LIMIT = Number(flag("--limit") ?? Infinity);
const ONLY = flag("--org");

/**
 * What a link has to say about itself to be worth opening.
 *
 * Ordered by strength. A link that names cooperative training is worth more
 * than one that says "careers", which is worth more than one that says "news" —
 * and the score decides which few are kept when a homepage offers forty.
 */
const SIGNALS: [RegExp, number, SourceType][] = [
  /*
   * "co-op", not "cooperation". The first pass matched `co-?op` anywhere and
   * pulled in "international_cooperation" and "التعاون الدولي" from two
   * ministries — pages about diplomacy, scored as if they were the training
   * portal. Arabic has the same trap: التعاوني is the training, التعاون is not.
   */
  [
    /التدريب التعاوني|تدريب تعاوني|cooperative training|\bco-?op(?!erat)/i,
    100,
    "careers_page",
  ],
  [/التدريب|تدريب|internship|trainee|متدرب/i, 70, "careers_page"],
  [/التوظيف|الوظائف|وظائف|careers?|jobs?|recruit|hiring/i, 60, "careers_page"],
  [/الأخبار|أخبار|البيانات الصحفية|news|announcements?|media-?cent/i, 30, "announcement_page"],
];

/** Never worth watching, whatever the link text says. */
const REJECT =
  /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|mp4)($|\?)|^mailto:|^tel:|^javascript:|#$/i;

/**
 * Social platforms are excluded, and not because they are useless.
 *
 * X and LinkedIn are where several of these bodies really do announce first.
 * Both forbid automated reading in their robots.txt, and this project obeys
 * robots.txt — that rule is not suspended because the data behind it would be
 * convenient. So they are skipped here rather than fetched and skipped later,
 * and the organisation sheet says plainly when a body's only channel is one we
 * are not allowed to read.
 */
const SOCIAL = /(^|\.)(x\.com|twitter\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|t\.me|tiktok\.com)$/i;

/** At most this many new leads per organisation, best first. */
const PER_ORG = 3;

const FILE = "data/organisations.json";
const orgs = JSON.parse(readFileSync(FILE, "utf8").replace(/^﻿/, "")) as Organisation[];

interface Found {
  url: string;
  text: string;
  score: number;
  type: SourceType;
}

function harvest(html: string, pageUrl: string, sameHost: string): Found[] {
  const { document } = parseHTML(html);
  const best = new Map<string, Found>();

  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (REJECT.test(href)) continue;

    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (SOCIAL.test(url.hostname)) continue;

    /*
     * Same registered domain only. A homepage links to a hundred places, and
     * the one thing we can say about a link on an organisation's own site is
     * that the organisation put it there — which is a claim about that
     * organisation, not about whatever third party it points to.
     */
    const registered = url.hostname.split(".").slice(-3).join(".");
    if (!registered.endsWith(sameHost) && !sameHost.endsWith(registered)) continue;

    url.hash = "";
    const label = `${a.textContent ?? ""} ${a.getAttribute("title") ?? ""} ${decodeURI(url.pathname)}`;
    const hit = SIGNALS.find(([re]) => re.test(label));
    if (!hit) continue;

    const found: Found = {
      url: url.href,
      text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      score: hit[1],
      type: hit[2],
    };
    const prior = best.get(found.url);
    if (!prior || prior.score < found.score) best.set(found.url, found);
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}

const targets = orgs
  .filter((o) => (ONLY === undefined ? true : o.id === ONLY))
  .filter((o) => o.sources.some((s) => s.verifiedAtISO !== null))
  .slice(0, LIMIT);

console.log(`reading ${targets.length} organisation(s) for links they publish themselves\n`);

let added = 0;
let scanned = 0;

for (const org of targets) {
  /*
   * Compared without a trailing slash or a fragment, because those do not make
   * a different page — and a source listed twice is a page fetched twice and
   * classified twice, every six hours, for ever.
   */
  const norm = (u: string): string => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  const known = new Set(org.sources.map((s) => norm(s.url)));
  // Read the verified pages this organisation already has, and only those.
  const pages = org.sources.filter((s) => s.verifiedAtISO !== null);

  const candidates = new Map<string, Found>();
  for (const page of pages) {
    const verdict = await checkRobots(page.url);
    if (!verdict.allowed) continue;

    const viaFetch = await fetchPage(page.url, verdict.crawlDelayMs);
    const res =
      viaFetch.ok && viaFetch.html.length > 2000
        ? viaFetch
        : await paced(page.url, verdict.crawlDelayMs, () => renderPage(page.url));
    if (!res.ok) continue;
    scanned++;

    const host = new URL(page.url).hostname.split(".").slice(-3).join(".");
    for (const found of harvest(res.html, res.finalUrl ?? page.url, host)) {
      if (known.has(norm(found.url))) continue;
      const prior = candidates.get(found.url);
      if (!prior || prior.score < found.score) candidates.set(found.url, found);
    }
  }

  const keep = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, PER_ORG);
  if (keep.length === 0) continue;

  console.log(`  ${org.id}`);
  for (const f of keep) {
    console.log(`      ${String(f.score).padStart(3)}  ${f.url}`);
    console.log(`           «${f.text}»`);
    org.sources.push({
      url: f.url,
      provenance: "reported",
      verifiedAtISO: null,
      verifiedNote: `رابط منشور على صفحة الجهة نفسها بنصّ «${f.text}». لم يُفتح بعد.`,
      type: f.type,
      checkFrequencyHours: f.score >= 100 ? 6 : 12,
      renderMode: "static",
    });
    added++;
  }
}

await closeBrowser();

if (!DRY) writeFileSync(FILE, JSON.stringify(orgs, null, 2) + "\n", "utf8");

console.log(
  `\nscanned ${scanned} page(s), added ${added} candidate link(s)${DRY ? " (dry run, nothing written)" : ""}.` +
    `\nnone is verified: run "npm run verify-leads" to open and judge them.`,
);
