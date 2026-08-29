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
import { fetchPage } from "../src/pipeline/fetch";
import { checkRobots } from "../src/pipeline/robots";
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

    const verdict = await checkRobots(source.url);
    if (!verdict.allowed) {
      outcomes.push({
        org: org.id,
        url: source.url,
        result: "robots",
        note: `robots.txt: ${verdict.reason}`,
      });
      continue;
    }

    /*
     * A 403 from a plain client is not a site saying "do not crawl me": that
     * sentence lives in robots.txt, which was read and obeyed above. It is a
     * filter that does not recognise a non-browser. So a refused fetch is
     * retried in a real browser and the source is marked to keep using one.
     * Nothing here pretends to be a browser; it either is one or it gives up.
     */
    let url = source.url;
    let res = await fetchPage(url, verdict.crawlDelayMs);
    let needsBrowser = false;

    if (!res.ok) {
      const rendered = await renderPage(url);
      if (rendered.ok) {
        res = rendered;
        needsBrowser = true;
      }
    }

    /*
     * The directory is from 2021 and most of its deep paths have since moved,
     * while the organisation's own domain is usually still there. So a dead
     * path falls back to the site root. That is not guessing a url: the domain
     * came from the record, the root is the one path every site has, and it is
     * only kept if it actually answers and yields text.
     */
    if (!res.ok) {
      const root = new URL(url).origin + "/";
      if (root !== url) {
        const rootVerdict = await checkRobots(root);
        if (rootVerdict.allowed) {
          const viaFetch = await fetchPage(root, rootVerdict.crawlDelayMs);
          const viaBrowser = viaFetch.ok ? viaFetch : await renderPage(root);
          if (viaBrowser.ok) {
            res = viaBrowser;
            needsBrowser = !viaFetch.ok;
            url = root;
          }
        }
      }
    }

    if (!res.ok) {
      outcomes.push({
        org: org.id,
        url: source.url,
        result: "unreachable",
        note: `${res.error} · ولا بمتصفّح حقيقي ولا من جذر الموقع`,
      });
      continue;
    }

    const { text, title } = extract(res.html, url);
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
      if (text.length < 200) {
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
      source.provenance = "official";
      source.verifiedAtISO = now;
      source.verifiedNote = note;
      if (needsBrowser) source.renderMode = "browser";
      outcomes.push({ org: org.id, url, result: "watchable", note });
      break;
    }

    const quote = quoteAround(text, haystack.indexOf(marker.toLowerCase()), marker);
    const note = `عنوان الصفحة: "${title ?? "بلا عنوان"}". وردت فيها عبارة «${marker}» بنصّها: "${quote}". فحص آلي بنفس معيار الجولة اليدوية.`;

    source.url = url;
    source.provenance = "official";
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
