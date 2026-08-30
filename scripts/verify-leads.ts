/**
 * Check every candidate link, at the same bar as the hand rounds.
 *
 * Forty-four organisations were checked by opening each page and reading it.
 * That does not scale to the rest, so this does the same job mechanically and,
 * in one way, more strictly: it reads the whole extracted text rather than what
 * an eye lands on, and it will not promote a link unless the page itself says
 * one of the accepted phrases. The phrase it found is stored, so every promoted
 * link still carries a quote anyone can check.
 *
 * What it cannot do is judge. A page that discusses cooperative training in
 * passing will pass this and would have failed a reading. That is why a promoted
 * link says which phrase was matched and where, and why nothing here touches
 * `manualCheckUrl`: the link the user taps still has to be earned by a person.
 *
 *   npm run verify-leads                 every candidate
 *   npm run verify-leads -- --tier A     one tier
 *   npm run verify-leads -- --limit 20   a small batch
 *   npm run verify-leads -- --dry-run    report, write nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { closeBrowser, renderPage } from "../src/pipeline/browser";
import { extract } from "../src/pipeline/extract";
import { fetchPage, paced } from "../src/pipeline/fetch";
import { checkFinalUrl, checkRobots } from "../src/pipeline/robots";
import type { Organisation, VerificationAttempt } from "../src/types";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes("--dry-run");
const TIER = flag("--tier");
const LIMIT = Number(flag("--limit") ?? Infinity);

/**
 * A page has to say one of these about itself. "Careers" is deliberately not
 * on the list: a jobs portal is not a training page, which is the distinction
 * the whole dataset is built on.
 */
/** Below this a page has not really been read, whatever its status code said. */
const THIN_TEXT = 200;

const MARKERS = [
  "التدريب التعاوني",
  "تدريب تعاوني",
  "برنامج المتدربين",
  "cooperative training",
  "co-op program",
  "coop program",
  "coop training",
];

const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];
const orgs = read<Organisation>("data/organisations.json");
const attempts = read<VerificationAttempt>("data/verification.json");
const now = new Date().toISOString();

/**
 * The same address with the `www` label added or removed.
 *
 * Eighteen organisations were unreachable for one reason, and it was not the
 * one assumed: `www.tvtc.gov.sa` does not resolve at all, while `tvtc.gov.sa`
 * answers. The 2021 directory recorded hosts the way they were written then,
 * and many Saudi sites have since dropped the label. This is not inventing a
 * url by pattern — the registered domain is the one already on the record, only
 * a label differs — and whatever answers is still opened, read and quoted
 * before a single field is written.
 */
function hostVariant(url: string): string {
  const u = new URL(url);
  u.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  return u.href;
}

/** Every address worth trying for one recorded source, in order of fidelity. */
function candidatesFor(url: string): string[] {
  const root = `${new URL(url).origin}/`;
  return [...new Set([url, hostVariant(url), root, hostVariant(root)])];
}

/**
 * The type a url has actually earned, now that the address may have moved.
 *
 * When a dead deep path fell back to the site root, the url was rewritten and
 * the type was left alone — so a bank homepage sat in the dataset labelled
 * `announcement_page`, which is precisely the quiet kind of lie types.ts says
 * `site_root` exists to prevent.
 */
const HOME_SEGMENTS = new Set([
  "ar",
  "en",
  "ar-sa",
  "en-sa",
  "ar-us",
  "en-us",
  "web",
  "pages",
  "home",
  "index.php",
  "index.html",
  "index.htm",
  "default.aspx",
  "default.html",
  "home.aspx",
]);

/** A homepage is still a homepage when it is reached through /ar/Pages/default.aspx. */
function isHomePath(u: URL): boolean {
  return u.pathname
    .split("/")
    .filter(Boolean)
    .every((part) => HOME_SEGMENTS.has(part.toLowerCase()) || /^\d+$/.test(part));
}

function typeFor(url: string, current: Organisation["sources"][number]["type"]): typeof current {
  const u = new URL(url);
  if (/career|job|coop|training|recruit|تدريب|وظائف/i.test(decodeURI(url)) && !isHomePath(u)) {
    return "careers_page";
  }
  if (isHomePath(u)) return "site_root";
  return current === "site_root" ? "announcement_page" : current;
}

/** The sentence around the phrase, so a promoted link carries its evidence. */
function quoteAround(text: string, at: number, marker: string): string {
  const from = Math.max(0, at - 90);
  const to = Math.min(text.length, at + marker.length + 130);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

interface Outcome {
  org: string;
  url: string;
  result: "verified" | "watchable" | "rejected" | "unreachable" | "robots";
  note: string;
}

const targets = orgs
  .filter((o) => !o.sources.some((s) => s.verifiedAtISO !== null))
  .filter((o) => o.sources.length > 0)
  .filter((o) => TIER === undefined || o.tier === TIER)
  .sort((a, b) => "SABC".indexOf(a.tier) - "SABC".indexOf(b.tier))
  .slice(0, LIMIT);

console.log(`checking ${targets.length} organisation(s) with a candidate link\n`);

const outcomes: Outcome[] = [];

for (const org of targets) {
  for (const source of org.sources) {
    if (source.verifiedAtISO !== null) continue;

    /*
     * Each candidate is tried in full before the next one: robots.txt first,
     * then a plain fetch, then a real browser.
     *
     * The browser retry is not a way round a refusal. A 403 from a plain client
     * is not a site saying "do not crawl me" — that sentence lives in
     * robots.txt, which is read and obeyed above it — it is a filter that does
     * not recognise a non-browser. And a broken certificate chain or a
     * script-drawn page is not a refusal at all. Nothing here pretends to be a
     * browser; it either is one or it gives up.
     */
    let url = source.url;
    let res: Awaited<ReturnType<typeof fetchPage>> = {
      ok: false,
      status: null,
      error: "not attempted",
    };
    let needsBrowser = false;
    let blockedByRobots: string | null = null;

    for (const candidate of candidatesFor(source.url)) {
      const verdict = await checkRobots(candidate);
      if (!verdict.allowed) {
        // Remember the first refusal, but keep trying the other addresses: a
        // host that cannot be reached is reported as a refusal too, and its
        // sibling may answer perfectly well.
        blockedByRobots ??= verdict.reason;
        continue;
      }

      const viaFetch = await fetchPage(candidate, verdict.crawlDelayMs);
      // Paced like any other request: spec 5.1 asks for a gap between hits on
      // one host, and a browser hit is still a hit. Four candidates on the same
      // domain would otherwise arrive back to back.
      const attempt = viaFetch.ok
        ? viaFetch
        : await paced(candidate, verdict.crawlDelayMs, () => renderPage(candidate));
      if (attempt.ok) {
        // A redirect can land on a host we never asked permission of.
        const afterRedirect = await checkFinalUrl(candidate, attempt.finalUrl);
        if (afterRedirect) {
          blockedByRobots ??= afterRedirect.reason;
          continue;
        }
        res = attempt;
        needsBrowser = !viaFetch.ok;
        // Store where it actually landed, so the next six-hourly fetch asks the
        // same host this one was granted.
        url = attempt.finalUrl ?? candidate;
        break;
      }
      res = attempt;
    }

    if (!res.ok) {
      const robotsOnly = blockedByRobots !== null && res.error === "not attempted";
      outcomes.push({
        org: org.id,
        url: source.url,
        result: robotsOnly ? "robots" : "unreachable",
        note: robotsOnly
          ? `robots.txt: ${blockedByRobots}`
          : `${res.error} · جُرِّب العنوان، ونظيره بـwww أو بدونها، وجذر الموقع، وبمتصفّح حقيقي`,
      });
      continue;
    }

    let { text, title } = extract(res.html, url);

    /*
     * A page can answer 200 and still be empty, because its content is drawn by
     * script after load. Ten organisations were written off as "cannot be read"
     * on exactly this: the fetch succeeded, so the browser retry above never
     * fired, and the extraction found nothing to fail on. Answering with an
     * empty body is as much a reason to render as refusing to answer at all, so
     * a thin result now gets the same second chance a failed one gets.
     */
    if (text.length < THIN_TEXT && !needsBrowser) {
      const rendered = await renderPage(url);
      if (rendered.ok) {
        const second = extract(rendered.html, url);
        if (second.text.length > text.length) {
          text = second.text;
          title = second.title;
          needsBrowser = true;
        }
      }
    }

    const haystack = text.toLowerCase();
    const marker = MARKERS.find((m) => haystack.includes(m.toLowerCase()));

    /*
     * Two different questions, which the first version of this conflated.
     *
     * "Is this a confirmed training page?" decides the link the user taps, and
     * keeps its strict bar: the page has to say so itself.
     *
     * "Is this worth watching?" is a lower bar on purpose. A careers portal
     * carries no coop wording until the day it does, and that day is the whole
     * point. stc proved it: its root was rejected, and the coop page lived
     * underneath. So a real, readable page on the organisation's own site is
     * watched, the classifier judges whatever appears on it, and the note says
     * plainly that no coop wording was there at the time of the check.
     */
    if (marker === undefined) {
      if (text.length < THIN_TEXT) {
        outcomes.push({
          org: org.id,
          url: source.url,
          result: "rejected",
          note: `الصفحة فُتحت لكنها لم تُخرج نصاً يُقرأ (${text.length} حرفاً)، فلا يمكن مراقبتها.`,
        });
        continue;
      }
      const note = `عنوان الصفحة: "${title ?? "بلا عنوان"}". صفحة حقيقية على نطاق الجهة، قُرئ منها ${text.length} حرفاً، ولا يرد فيها ذكر التدريب التعاوني وقت الفحص. تُراقَب لأن الإعلان قد يظهر عليها لاحقاً، وليست صفحة تدريب مؤكّدة. أول ما فيها: "${text.slice(0, 110)}…"`;
      source.url = url;
      source.type = typeFor(url, source.type);
      source.provenance = "official";
      source.coopConfirmed = false;
      source.verifiedAtISO = now;
      source.verifiedNote = note;
      if (needsBrowser) source.renderMode = "browser";
      outcomes.push({ org: org.id, url, result: "watchable", note });
      break;
    }

    const quote = quoteAround(text, haystack.indexOf(marker.toLowerCase()), marker);
    const note = `عنوان الصفحة: "${title ?? "بلا عنوان"}". وردت فيها عبارة «${marker}» بنصّها: "${quote}". فحص آلي بنفس معيار الجولة اليدوية.`;

    source.url = url;
    source.type = typeFor(url, source.type);
    source.provenance = "official";
    source.coopConfirmed = true;
    source.verifiedAtISO = now;
    source.verifiedNote = note;
    if (needsBrowser) source.renderMode = "browser";
    outcomes.push({ org: org.id, url, result: "verified", note });
    break; // one confirmed source per organisation is enough to watch it
  }
}

await closeBrowser();

if (!DRY) {
  writeFileSync("data/organisations.json", JSON.stringify(orgs, null, 2) + "\n", "utf8");
  attempts.push(
    ...outcomes.map((o) => ({
      targetId: o.org,
      checkedAtISO: now,
      urlTried: o.url,
      outcome: (o.result === "robots"
        ? "unreachable"
        : o.result === "watchable"
          ? "verified"
          : o.result) as VerificationAttempt["outcome"],
      note: o.note,
    })),
  );
  writeFileSync("data/verification.json", JSON.stringify(attempts, null, 2) + "\n", "utf8");
}

const tally = outcomes.reduce<Record<string, number>>(
  (m, o) => ({ ...m, [o.result]: (m[o.result] ?? 0) + 1 }),
  {},
);
for (const o of outcomes.filter((x) => x.result === "verified")) console.log(`  COOP  ${o.org}`);
for (const o of outcomes.filter((x) => x.result === "watchable")) console.log(`  WATCH ${o.org}`);
for (const o of outcomes.filter((x) => x.result !== "verified" && x.result !== "watchable")) {
  console.log(`  --   ${o.org.padEnd(16)} ${o.result}: ${o.note.slice(0, 90)}`);
}
console.log(`\n${JSON.stringify(tally)}${DRY ? "  (dry run, nothing written)" : ""}`);
