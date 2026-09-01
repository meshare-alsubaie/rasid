/**
 * Phase 2 collector: fetch every verified source, extract its readable text,
 * work out whether it changed, and record what happened to every one of them.
 *
 * The rule that shapes this file is spec section 0.3, fail loudly not silently.
 * A source that could not be fetched, or that robots.txt put out of reach, is
 * written into health.json as degraded or broken. It is never quietly dropped
 * to keep the dashboard green, because a stale green light is worse than a red
 * one for someone whose semester depends on catching a 7-day window.
 *
 * Only sources carrying `verifiedAtISO` are fetched. An unopened lead has not
 * been confirmed to be the page it claims to be, and the pipeline must not
 * spend requests, or the user's trust, on a guess.
 *
 * Usage:
 *   npm run collect                  every verified source
 *   npm run collect -- --limit 5     the acceptance run for this phase
 *   npm run collect -- --dry-run     fetch and report, write nothing
 *   npm run collect -- --verbose     one line per source
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import pLimit from "p-limit";
import { HAS_CONTACT, USER_AGENT } from "../src/pipeline/agent";
import { browserUnavailable, closeBrowser, renderPage } from "../src/pipeline/browser";
import {
  CLASSIFIER_MODEL,
  classify,
  costOf,
  triage,
  type Classification,
  type Usage,
} from "../src/pipeline/classify";
import { asManualReview, fromClassification } from "../src/pipeline/opportunity";
import { extract, isSoft404, sha256 } from "../src/pipeline/extract";
import { fetchPage, paced } from "../src/pipeline/fetch";
import { checkFinalUrl, checkRobots } from "../src/pipeline/robots";
import { MAX_BROWSER_SOURCES, SILENT_THIN_RUNS, THIN_CHARS, statusFor } from "../src/types";
import type {
  AggregatorSource,
  HealthState,
  Opportunity,
  Organisation,
  RenderMode,
  SourceHealth,
  SourceSnapshot,
} from "../src/types";

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const DRY_RUN = has("--dry-run");
const VERBOSE = has("--verbose");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const onlyArg = args.indexOf("--only");
/** Debug one source without hitting every host again. */
const ONLY = onlyArg >= 0 ? args[onlyArg + 1] : null;

// A BOM is stripped because Windows editors and PowerShell add one silently,
// and JSON.parse rejects it with an error that points at nothing useful.
const read = <T>(p: string): T[] =>
  JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];
const orgs = read<Organisation>("data/organisations.json");
const aggregators = read<AggregatorSource>("data/aggregators.json");
const priorHealth = read<SourceHealth>("data/health.json");
const priorSnapshots = read<SourceSnapshot>("data/snapshots.json");
const priorOpportunities = read<Opportunity>("data/opportunities.json");

/** Skip the model entirely, for a network-only run. */
const NO_CLASSIFY = has("--no-classify");
/**
 * Classify everything fetched, not just what moved. For the first run after
 * the classifier lands, and for any run after the system prompt changes -
 * old verdicts were produced by a prompt that no longer exists.
 */
const RECLASSIFY = has("--reclassify");

interface Target {
  ownerId: string;
  url: string;
  label: string;
  renderMode: RenderMode;
  browserRetryInCI: boolean;
}

/** GitHub Actions sets CI=true. A runner has more memory than a laptop. */
const IS_CI = Boolean(process.env.CI);

/* Verified sources only. `verifiedAtISO === null` means nobody opened it. */
const targets: Target[] = [
  ...orgs.flatMap((o) =>
    o.sources
      .filter((s) => s.verifiedAtISO !== null)
      .map((s) => ({
        ownerId: o.id,
        url: s.url,
        label: o.nameAr,
        renderMode: s.renderMode,
        browserRetryInCI: s.browserRetryInCI === true,
      })),
  ),
  ...aggregators.flatMap((a) =>
    a.link !== null && a.link.verifiedAtISO !== null
      ? [
          {
            ownerId: a.id,
            url: a.link.url,
            label: a.nameAr,
            renderMode: "static" as const,
            browserRetryInCI: false,
          },
        ]
      : [],
  ),
]
  .filter((t) => ONLY === null || t.ownerId === ONLY)
  .slice(0, LIMIT);

const staticTargets = targets.filter((t) => t.renderMode === "static");
const allBrowserTargets = targets.filter((t) => t.renderMode === "browser");

/*
 * Over the cap is a degradation, not a death.
 *
 * This used to exit(1), which killed the entire run: no collection, no
 * notification, no deploy, because too many pages had turned out to be
 * javascript-only. That is a whole day of blindness as the punishment for the
 * source list growing, and growth is the goal. The cap still means something —
 * it is what keeps the browser a decision rather than a default — but the
 * sources beyond it are simply not read this run and say so in health.json,
 * where the app shows them as unwatched. Loud and partial beats silent and
 * total.
 */
const browserTargets = allBrowserTargets.slice(0, MAX_BROWSER_SOURCES);
const overflow = allBrowserTargets.slice(MAX_BROWSER_SOURCES);

if (overflow.length > 0) {
  console.log(
    `\n${allBrowserTargets.length} sources ask for the browser and the cap is ${MAX_BROWSER_SOURCES}.\n` +
      `Reading ${browserTargets.length}; ${overflow.length} are left unread this run and marked as such.`,
  );
}

const now = new Date().toISOString();

/*
 * Records for sources that no longer exist are dropped.
 *
 * A source can leave the dataset — a duplicate merged away, a link that turned
 * out to be the wrong page. Its snapshot and its health record used to stay
 * behind for ever, and a health record is what the interface counts as "a
 * source being watched": the app would keep reporting a page nobody fetches any
 * more. The validator caught one and called it what it is, unwatchable.
 *
 * Only run when the whole set is being collected: with --org or --limit the
 * targets are a slice, and pruning against a slice would delete the rest.
 */
const wholeRun = ONLY === null && !Number.isFinite(LIMIT);
const live = new Set(targets.map((t) => t.url));
const keep = <T extends { sourceUrl: string }>(rows: T[]): T[] =>
  wholeRun ? rows.filter((r) => live.has(r.sourceUrl)) : rows;

const droppedRecords = wholeRun
  ? priorSnapshots.length - keep(priorSnapshots).length + (priorHealth.length - keep(priorHealth).length)
  : 0;
if (droppedRecords > 0) {
  console.log(`forgetting ${droppedRecords} record(s) for sources no longer in the dataset`);
}

const healthByUrl = new Map(keep(priorHealth).map((h) => [h.sourceUrl, h]));
const snapshotByUrl = new Map(keep(priorSnapshots).map((s) => [s.sourceUrl, s]));

/** Any failure is degraded. See the note on SourceHealth.state for why. */
const stateFor = (failures: number): HealthState =>
  failures > 5 ? "broken" : failures >= 1 ? "degraded" : "healthy";

type Outcome = "changed" | "unchanged" | "robots_skip" | "unreadable" | "failed";
const tally: Record<Outcome, number> = {
  changed: 0,
  unchanged: 0,
  robots_skip: 0,
  unreadable: 0,
  failed: 0,
};
const lines: string[] = [];

/**
 * Below this, the fetch technically succeeded but produced nothing to watch.
 * Several Saudi portals ship an empty shell and paint the page with
 * JavaScript, which this crawler does not run. Recording such a source as
 * healthy would be the stale green light spec section 0.3 forbids: the
 * pipeline would sit on it for months and never see the announcement.
 */
const MIN_USABLE_CHARS = 50;

/** Sources that failed this run, so the CI retry knows what to attempt. */
const failedUrls = new Set<string>();

/** Extracted text of everything fetched successfully, for the classifier. */
const textByUrl = new Map<string, string>();

function recordFailure(t: Target, error: string, outcome: Outcome): void {
  const prev = healthByUrl.get(t.url);
  const failures = (prev?.consecutiveFailures ?? 0) + 1;
  healthByUrl.set(t.url, {
    sourceUrl: t.url,
    orgId: t.ownerId,
    lastAttemptISO: now,
    lastSuccessISO: prev?.lastSuccessISO ?? null,
    consecutiveFailures: failures,
    lastError: error,
    state: stateFor(failures),
  });
  failedUrls.add(t.url);
  tally[outcome]++;
  const tag = outcome === "robots_skip" ? "SKIP" : outcome === "unreadable" ? "BLNK" : "FAIL";
  lines.push(`  ${tag}  ${t.ownerId.padEnd(14)} ${error}`);
}

async function collect(t: Target): Promise<void> {
  const verdict = await checkRobots(t.url);
  if (!verdict.allowed) {
    // A robots skip is not an error on our side, but it does mean this source
    // is unwatched, and the user must see that in the header status line.
    recordFailure(t, `robots.txt: ${verdict.reason}`, "robots_skip");
    return;
  }

  // The browser path is paced by the same per-host rules as the plain fetcher.
  const res =
    t.renderMode === "browser"
      ? await paced(t.url, verdict.crawlDelayMs, () => renderPage(t.url))
      : await fetchPage(t.url, verdict.crawlDelayMs);
  if (!res.ok) {
    recordFailure(t, res.error, "failed");
    return;
  }

  // Permission was asked of the host we requested. A redirect can hand us a
  // different one, and that host has not agreed to anything.
  const afterRedirect = await checkFinalUrl(t.url, res.finalUrl);
  if (afterRedirect) {
    recordFailure(t, `robots.txt: ${afterRedirect.reason}`, "robots_skip");
    return;
  }

  const extracted = extract(res.html, t.url);
  const { hash, chars, method } = extracted;

  // A page that answers 200 while saying it is missing is a failure, whatever
  // the transport thought. Recorded as one, so it cannot sit green for ever.
  if (isSoft404(extracted.title)) {
    recordFailure(t, `الصفحة تردّ 200 لكن عنوانها "${extracted.title}" — صفحة غير موجودة`, "failed");
    return;
  }
  if (chars < MIN_USABLE_CHARS) {
    /*
     * Keep the record, clear the hash.
     *
     * Deleting it took `firstSeenISO` and `lastChangedISO` with it — the two
     * dates types.ts calls the honest basis for predicting a window — and the
     * next successful run then wrote `lastChangedISO: now`, asserting a change
     * that never happened. One maintenance banner or one geo-blocked fetch was
     * enough, and the two collectors disagree about these hosts every six
     * hours, so it happened routinely. A null hash says "we cannot see this
     * page right now" without also erasing what we saw before.
     */
    const kept = snapshotByUrl.get(t.url);
    if (kept) snapshotByUrl.set(t.url, { ...kept, contentHash: null });
    recordFailure(
      t,
      `fetched ${res.bytes} bytes but extracted only ${chars} chars of text; the page is probably rendered by javascript and cannot be watched this way`,
      "unreadable",
    );
    return;
  }

  const prevSnapshot = snapshotByUrl.get(t.url);
  const changed = prevSnapshot?.contentHash !== hash;

  /*
   * Spec 5.3: send the classifier the block that changed, not the top of the
   * page. On a long portal the announcement is rarely in the first 6000
   * characters, so slicing the head meant the model was asked about the
   * navigation and answered, correctly, that it saw no announcement.
   *
   * On first sight there is nothing to diff against and the whole text is the
   * change. The page title and its opening line ride along with the changed
   * blocks, because a bare paragraph with no idea whose page it is on is a
   * worse question than a slightly longer one.
   */
  const priorBlocks = new Set(prevSnapshot?.blockHashes ?? []);
  const blockHashes = extracted.blocks.map((b) => sha256(b).slice(0, 16));
  const newBlocks =
    priorBlocks.size === 0
      ? extracted.blocks
      : extracted.blocks.filter((_, i) => !priorBlocks.has(blockHashes[i]!));

  const payload =
    priorBlocks.size === 0 || newBlocks.length === 0
      ? extracted.text
      : [extracted.title ?? "", extracted.blocks[0] ?? "", ...newBlocks]
          .filter(Boolean)
          .join("\n\n");

  // A thin page that also stops moving is the signature of a page we are not
  // really reading. Counted here, escalated by the validator at ten.
  const thinAndSilent = chars < THIN_CHARS && !changed;

  // Kept so the classification pass can read what was fetched without a
  // second request. Only successful, usable extractions land here.
  textByUrl.set(t.url, payload);

  snapshotByUrl.set(t.url, {
    sourceUrl: t.url,
    orgId: t.ownerId,
    contentHash: hash,
    blockHashes,
    extractedChars: chars,
    extractionMethod: method,
    firstSeenISO: prevSnapshot?.firstSeenISO ?? now,
    lastChangedISO: changed ? now : (prevSnapshot?.lastChangedISO ?? null),
    thinRuns: thinAndSilent ? (prevSnapshot?.thinRuns ?? 0) + 1 : 0,
    // New text owes a verdict. Unchanged text keeps whatever it was owed, so
    // a source whose classification failed last run is retried, not buried.
    pendingClassification: changed ? true : (prevSnapshot?.pendingClassification ?? false),
  });
  healthByUrl.set(t.url, {
    sourceUrl: t.url,
    orgId: t.ownerId,
    lastAttemptISO: now,
    lastSuccessISO: now,
    consecutiveFailures: 0,
    lastError: null,
    state: "healthy",
  });

  tally[changed ? "changed" : "unchanged"]++;
  lines.push(
    `  ${changed ? "NEW " : "same"}  ${t.ownerId.padEnd(14)} ${String(chars).padStart(6)} chars  ${method === "readability" ? "readability" : "body-fallback"}`,
  );
}

console.log(`RASID collector${DRY_RUN ? " (dry run, nothing will be written)" : ""}`);
console.log(
  `${targets.length} verified source(s), ${browserTargets.length} of them rendered\n${USER_AGENT}\n`,
);
if (!HAS_CONTACT) {
  console.log("note: RASID_CONTACT is unset, so requests carry no contact address.\n");
}

/*
 * robots.txt first, one fetch per origin — but not one at a time.
 *
 * This was a plain sequential loop, written when there were eighteen sources on
 * a handful of hosts. At 141 origins it became the reason the whole run died: a
 * host that does not answer costs three attempts at twenty seconds, plus
 * backoff, plus a headless-browser attempt, and a dozen such hosts exhaust a
 * twenty-five minute budget before a single page has been fetched. A scheduled
 * run timed out having collected nothing, and reported success.
 *
 * They are still one request per origin, still cached, and still paced per host
 * by `fetchPage` — only the waiting is shared now. Six at a time is well under
 * what any single host sees, because these are all different hosts.
 */
const origins = [...new Set(targets.map((t) => new URL(t.url).origin))];
const robotsAtOnce = pLimit(6);
console.log(`reading robots.txt for ${origins.length} host(s)…`);
await Promise.all(origins.map((origin) => robotsAtOnce(() => checkRobots(origin))));

// Every source is awaited, and a rejection here would be a bug in this file
// rather than a bad page: collect() converts page failures into health records.
await Promise.all(staticTargets.map((t) => collect(t)));

// Rendered sources run strictly one at a time, after the cheap work is done.
for (const t of browserTargets) await collect(t);

// What the cap left out is recorded as unread, with the reason, so the app can
// show it. A source nobody looked at must never sit in the dataset as healthy.
for (const t of overflow) {
  recordFailure(
    t,
    `not read this run: ${allBrowserTargets.length} sources need a real browser and the cap is ${MAX_BROWSER_SOURCES}`,
    "failed",
  );
}

/*
 * The CI-only second chance.
 *
 * A source marked browserRetryInCI failed to render on the machine that set
 * the flag, for want of memory rather than for anything the site did. A runner
 * container is roomier, so try once more there. A success is not a one-off: it
 * promotes the source to "browser" for good, and writes down why, so the next
 * reader of organisations.json can see it was earned rather than assumed.
 */
const promotions: string[] = [];
if (IS_CI) {
  const retryable = staticTargets.filter((t) => t.browserRetryInCI && failedUrls.has(t.url));
  let seatsLeft = MAX_BROWSER_SOURCES - browserTargets.length;

  for (const t of retryable) {
    if (seatsLeft <= 0) {
      lines.push(`  CAP   ${t.ownerId.padEnd(14)} browser seats are full, retry skipped`);
      continue;
    }
    const verdict = await checkRobots(t.url);
    if (!verdict.allowed) continue; // already recorded by the static pass

    const res = await paced(t.url, verdict.crawlDelayMs, () => renderPage(t.url));
    if (!res.ok) continue; // the static failure already stands in health.json

    const { hash, chars, method, text } = extract(res.html, t.url);
    if (chars < MIN_USABLE_CHARS) continue;

    textByUrl.set(t.url, text);
    snapshotByUrl.set(t.url, {
      sourceUrl: t.url,
      orgId: t.ownerId,
      contentHash: hash,
      extractedChars: chars,
      extractionMethod: method,
      firstSeenISO: snapshotByUrl.get(t.url)?.firstSeenISO ?? now,
      lastChangedISO: now,
      thinRuns: 0,
      pendingClassification: true,
    });
    healthByUrl.set(t.url, {
      sourceUrl: t.url,
      orgId: t.ownerId,
      lastAttemptISO: now,
      lastSuccessISO: now,
      consecutiveFailures: 0,
      lastError: null,
      state: "healthy",
    });

    const source = orgs.find((o) => o.id === t.ownerId)?.sources.find((s) => s.url === t.url);
    if (source) {
      source.renderMode = "browser";
      delete source.browserRetryInCI;
      source.renderModeNote = `promoted to browser on ${now}: static extraction failed on this page, rendering in CI returned ${chars} chars`;
    }
    seatsLeft--;
    tally.changed++;
    promotions.push(`  ${t.ownerId.padEnd(14)} static -> browser, ${chars} chars`);
  }
}

await closeBrowser();

/*
 * Classification.
 *
 * Only text that is owed a verdict is sent: what changed this run, plus what a
 * previous run failed to judge. Everything else costs nothing, which is the
 * whole reason the hashes exist.
 */
const opportunityById = new Map(priorOpportunities.map((o) => [o.id, o]));
const orgsWithHistory = new Set(priorOpportunities.map((o) => o.orgId));
const spend: Usage = { inputTokens: 0, outputTokens: 0 };
const reviewQueue: string[] = [];
/** Records whose page stopped showing them this run. Never silent. */
const vanished: string[] = [];
let classified = 0;
let notAnnouncements = 0;
/** Pages whose changed text did not mention training at all. Never silent. */
let skippedByFilter = 0;
/** Pages answered from a verdict already paid for. */
let fromMemory = 0;
/** Pages the one-word question ruled out before the expensive one. */
let triagedOut = 0;

/**
 * Verdicts already paid for, keyed by the text that produced them.
 *
 * `null` means "asked, and it is not an announcement" — worth remembering
 * precisely because that is the answer nineteen pages in twenty give, and the
 * one there is no point buying twice.
 */
const VERDICTS_FILE = "data/verdicts.json";
type RememberedVerdict = Record<string, Classification | null>;
const verdicts = new Map<string, Classification | null>(
  Object.entries(
    existsSync(VERDICTS_FILE)
      ? (JSON.parse(readFileSync(VERDICTS_FILE, "utf8")) as RememberedVerdict)
      : {},
  ),
);

/**
 * Does this text say anything about training, in either language?
 *
 * Deliberately generous, and deliberately not clever. It is only ever used to
 * decide whether a page is worth *paying* to have judged, and the cost of a
 * false positive is one cent while the cost of a false negative is a semester.
 * So every spelling that appears on a Saudi page is here, including the ones a
 * tighter pattern would miss — تدريب without تعاوني, المتدربين, تمهير, and the
 * bare English words.
 *
 * Note it does not exclude "cooperation": that trap matters when *classifying*
 * a url, and here an extra classification costs a cent and loses nothing.
 */
const MENTIONS_TRAINING =
  /تدريب|تدريبي|متدرب|المتدربين|تعاون|تمهير|طلاب|طالبات|خريج|فرص|توظيف|وظائف|تأهيل|co-?op|intern|trainee|training|career|graduate|student/i;

/**
 * Whether a page must be judged whatever its text says.
 *
 * A page that has told us it is about cooperative training, or that sits at a
 * careers address, is always sent. Those are few, they are the whole point, and
 * no saving is worth the chance of skipping one. The filter below exists for
 * the hundred and forty news pages and media centres that move every day and
 * say nothing — which is where the money actually goes.
 */
const alwaysJudge = new Set<string>();
for (const o of orgs) {
  for (const s of o.sources) {
    if (s.coopConfirmed === true || s.type === "careers_page" || s.type === "portal") {
      alwaysJudge.add(s.url);
    }
  }
}

/**
 * What each source is worth reading first.
 *
 * The budget below is finite, and without an order it is spent in whatever
 * sequence the sources happen to sit in. That would be actively harmful now
 * that every organisation is watched on its news page as well: a media centre
 * publishes something most days, so its hash moves every run, while the co-op
 * page it sits beside moves twice a year — and the pages that change constantly
 * would eat the budget in front of the one page this application exists to
 * read.
 *
 * So a page that has said it is about cooperative training is judged first,
 * then careers pages, then everything else.
 */
const sourceRank = new Map<string, number>();
for (const o of orgs) {
  for (const s of o.sources) {
    sourceRank.set(
      s.url,
      s.coopConfirmed === true ? 0
      : s.type === "careers_page" || s.type === "portal" ? 1
      : s.type === "announcement_page" ? 2
      : 3,
    );
  }
}

const owed = [...snapshotByUrl.values()]
  .filter((s) => (RECLASSIFY || s.pendingClassification) && textByUrl.has(s.sourceUrl))
  .sort((a, b) => (sourceRank.get(a.sourceUrl) ?? 3) - (sourceRank.get(b.sourceUrl) ?? 3));

/*
 * A dry run does not spend money either.
 *
 * The banner says "nothing will be written", which reads as "this costs
 * nothing" — and it did not: classification ran and was billed, only the files
 * were left alone. `--no-classify` is still there for the opposite case, where
 * the writing is wanted and the spending is not.
 */
if (DRY_RUN && owed.length > 0) {
  console.log(`\ndry run: ${owed.length} page(s) would be classified; no API call was made.`);
}

/*
 * A ceiling on what one run may spend.
 *
 * The person paying for this is a student, and the source list keeps growing:
 * every organisation is now watched on every channel it publishes, so a day
 * when many pages move is a day when many pages are classified. A runaway run
 * is not hypothetical — one badly-behaved page whose hash churns every six
 * hours would bill four times a day for ever.
 *
 * Hitting the ceiling is not a failure and nothing is lost. The pages that did
 * not fit keep `pendingClassification`, which is exactly the flag that means
 * "still owed a verdict", so the next run picks them up first. Override with
 * RASID_RUN_BUDGET_USD when a deliberate catch-up is wanted.
 */
const RUN_BUDGET_USD = Number(process.env.RASID_RUN_BUDGET_USD ?? 0.5);
let budgetStopped = 0;

if (!NO_CLASSIFY && !DRY_RUN) {
  for (const snap of owed) {
    if (costOf(spend) >= RUN_BUDGET_USD) {
      budgetStopped++;
      continue;
    }
    const text = textByUrl.get(snap.sourceUrl) ?? "";

    /*
     * Do not pay to be told "no".
     *
     * A hundred and forty of these sources are news pages and media centres.
     * They move every day — a new story, a rotated banner, a date — so every
     * round asked the model about each of them and every round it answered that
     * this is not a training announcement. At a cent a page that was two to
     * four dollars a day to hear "no" repeatedly, which is most of the bill and
     * all of the waste.
     *
     * A page whose changed text does not contain a single training word in
     * either language cannot be a training announcement, and that is a free
     * check. Three things keep it safe: confirmed co-op pages and careers pages
     * are never filtered, the vocabulary is deliberately loose enough that a
     * false positive is likelier than a false negative, and every skip is
     * counted and printed rather than passing in silence.
     *
     * `--reclassify` bypasses it, for a run that is meant to re-judge
     * everything regardless.
     */
    if (!RECLASSIFY && !alwaysJudge.has(snap.sourceUrl) && !MENTIONS_TRAINING.test(text)) {
      skippedByFilter++;
      // Nothing is owed a verdict that cannot contain one. Clearing the flag
      // stops the page being carried forward as an unpaid debt for ever.
      snap.pendingClassification = false;
      continue;
    }

    /*
     * Never pay twice for the same words.
     *
     * A page whose text returns to something already judged — a banner that
     * rotates between two states, a listing that reorders and reverts — moves
     * its hash every round and was billed every round for an answer already
     * known. The text is the whole input to the verdict, so identical text has
     * an identical answer, and looking it up is free.
     */
    const fingerprint = sha256(text).slice(0, 32);
    const remembered = verdicts.get(fingerprint);
    if (!RECLASSIFY && remembered !== undefined) {
      fromMemory++;
      snap.pendingClassification = false;
      if (remembered === null) {
        notAnnouncements++;
        continue;
      }
      const prior = priorOpportunities.find(
        (o) => o.orgId === snap.orgId && o.sourceUrl === snap.sourceUrl,
      );
      for (const [id, o] of opportunityById) {
        if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
      }
      const record = fromClassification({
        orgId: snap.orgId,
        sourceUrl: snap.sourceUrl,
        text,
        nowISO: now,
        prior,
        firstTime: prior
          ? prior.flags.includes("first_time_seen")
          : !orgsWithHistory.has(snap.orgId),
        c: remembered,
      });
      opportunityById.set(record.id, record);
      classified++;
      continue;
    }

    /*
     * One word before seventeen fields.
     *
     * Pages already known to be about training skip this and go straight to the
     * full question. Everything else is asked, in a form answerable in one
     * word, whether it is worth the expensive question at all.
     */
    if (!RECLASSIFY && !alwaysJudge.has(snap.sourceUrl)) {
      const first = await triage(text);
      spend.inputTokens += first.usage.inputTokens;
      spend.outputTokens += first.usage.outputTokens;
      if (!first.looksLikeAnnouncement) {
        triagedOut++;
        notAnnouncements++;
        snap.pendingClassification = false;
        verdicts.set(fingerprint, null);
        continue;
      }
    }

    const prior = priorOpportunities.find(
      (o) => o.orgId === snap.orgId && o.sourceUrl === snap.sourceUrl,
    );
    const common = {
      orgId: snap.orgId,
      sourceUrl: snap.sourceUrl,
      text,
      nowISO: now,
      prior,
      /*
       * Decided once, then carried. Records are rebuilt every run, so asking
       * "did this organisation have a record when this run started" answered
       * yes from the second run onward and the flag quietly vanished from an
       * announcement that really was an organisation's first. Whatever the
       * first sighting concluded is what stays true about that announcement.
       */
      firstTime: prior
        ? prior.flags.includes("first_time_seen")
        : !orgsWithHistory.has(snap.orgId),
    };

    const result = await classify(text);
    spend.inputTokens += result.usage.inputTokens;
    spend.outputTokens += result.usage.outputTokens;

    if (!result.ok) {
      const note = `${result.stage} — ${result.reason}`;
      /*
       * The hash stays, the debt stays, and nothing is scored.
       *
       * A previously valid verdict is not erased by a failed re-check: it is
       * kept and flagged, so the user still sees what the page last said while
       * knowing it could not be confirmed this run. Only a source that has
       * never been judged gets a bare placeholder. Either way exactly one
       * record exists per source.
       */
      const existing = [...opportunityById.values()].find(
        (o) => o.sourceUrl === snap.sourceUrl && !o.flags.includes("needs_manual_review"),
      );
      if (existing) {
        existing.flags = [...existing.flags, "needs_manual_review"];
        existing.relevanceReason = `${existing.relevanceReason} (لم يُتحقّق في آخر جولة: ${note})`;
      } else {
        for (const [id, o] of opportunityById) {
          if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
        }
        const record = asManualReview({ ...common, reason: note });
        opportunityById.set(record.id, record);
      }
      snap.pendingClassification = true;
      reviewQueue.push(`  ${snap.orgId.padEnd(14)} ${result.stage.padEnd(15)} ${result.reason}`);
      continue;
    }

    snap.pendingClassification = false;
    /*
     * One source, one current record.
     *
     * The id is a hash of the title, so a page whose wording shifts between
     * runs would mint a second id and leave the first behind: two entries for
     * one page, with two different scores, and no way for a reader to tell
     * which is live. The verdict just produced supersedes whatever this source
     * said before, so the old entry goes. `prior` has already carried
     * firstSeenISO across, so the record keeps its history.
     */
    /*
     * A negative verdict never deletes. It used to, and that was the worst bug
     * in this file.
     *
     * The delete loop ran *before* the isTrainingAnnouncement check, so any run
     * where a watched page stopped mentioning training threw the record away in
     * silence — and a page stops mentioning training for reasons that have
     * nothing to do with the announcement ending: a redesign, a cookie wall, a
     * maintenance banner, a soft 404 that answers 200, or the extractor
     * latching onto navigation. An audit proved it by destroying a seeded open
     * window, score 95, three seats, closing in eleven days, in a single round,
     * with no notification of any kind. He would simply have found it gone.
     *
     * So the record is kept, marked as no longer visible on its page, and the
     * disappearance is something the notifier can tell him about. Deletion now
     * requires a positive replacement, which is the only thing that proves the
     * page still holds an announcement.
     */
    // Remembered against the text that produced it, so identical text is never
    // paid for again — including the "no", which is most of what is bought.
    verdicts.set(
      sha256(text).slice(0, 32),
      result.value.isTrainingAnnouncement ? result.value : null,
    );

    if (!result.value.isTrainingAnnouncement) {
      notAnnouncements++;
      for (const [, o] of opportunityById) {
        if (o.sourceUrl === snap.sourceUrl && !o.flags.includes("vanished_from_source")) {
          o.flags = [...o.flags, "vanished_from_source"];
          o.lastConfirmedISO = o.lastConfirmedISO; // unchanged: it was not confirmed today
          vanished.push(`  ${snap.orgId.padEnd(14)} ${o.titleAr}`);
        }
      }
      continue;
    }

    /*
     * One source, one current record.
     *
     * The id is a hash of the title, so a page whose wording shifts between
     * runs would mint a second id and leave the first behind: two entries for
     * one page, with two different scores, and no way for a reader to tell
     * which is live. The verdict just produced supersedes whatever this source
     * said before, so the old entry goes. `prior` has already carried
     * firstSeenISO across, so the record keeps its history.
     */
    for (const [id, o] of opportunityById) {
      if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
    }
    const record = fromClassification({ ...common, c: result.value });
    opportunityById.set(record.id, record);
    classified++;
  }
}

/*
 * Every record's status is recomputed before anything is written.
 *
 * Not only the ones classified this run — every one. A record whose page has
 * not moved is never reclassified, and its window opens and closes on the
 * calendar regardless. Storing a status computed weeks ago and then never
 * revisiting it is what made a window that had been open for ten days still
 * read "أُعلن ولم يفتح", with no alert ever sent. The dates are the fact; the
 * status is a view of them at a moment, and the moment is now.
 */
let restated = 0;
for (const [id, o] of opportunityById) {
  const fresh = statusFor(o, Date.parse(now));
  if (fresh === o.status) continue;
  const flags = new Set(o.flags);
  if (fresh === "closing_soon") flags.add("closing_in_48h");
  else flags.delete("closing_in_48h");
  opportunityById.set(id, { ...o, status: fresh, flags: [...flags] });
  restated++;
}
if (restated > 0) console.log(`\n${restated} record(s) moved to a new window state by the calendar`);

if (VERBOSE) console.log(lines.sort().join("\n") + "\n");

const health = [...healthByUrl.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
const snapshots = [...snapshotByUrl.values()].sort((a, b) =>
  a.sourceUrl.localeCompare(b.sourceUrl),
);

/**
 * Written to a neighbouring file and renamed over the target.
 *
 * A rename within a directory is atomic on every filesystem this runs on, so a
 * reader either sees the whole previous file or the whole new one. A plain
 * write is neither: a crash, a full disk, or a machine going to sleep partway
 * through leaves truncated JSON, and `data/organisations.json` truncated is the
 * one file that stops every script and the app at once. The app fails loudly on
 * it, which is right, but it should not be possible to get there by accident.
 */
function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}

if (!DRY_RUN) {
  writeAtomic("data/health.json", JSON.stringify(health, null, 2) + "\n");
  writeAtomic("data/snapshots.json", JSON.stringify(snapshots, null, 2) + "\n");
  // Only rewritten when a promotion actually happened, so an ordinary run
  // never touches the dataset the whole project is built on.
  if (promotions.length > 0) {
    writeAtomic("data/organisations.json", JSON.stringify(orgs, null, 2) + "\n");
  }
  const opportunities = [...opportunityById.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeAtomic("data/opportunities.json", JSON.stringify(opportunities, null, 2) + "\n");

  /*
   * The verdict memory, bounded. Newest kept; the oldest fall off, because a
   * page whose text has not been seen in months will be re-read as new anyway
   * and there is no point carrying it for ever.
   */
  const MAX_REMEMBERED = 3_000;
  const kept = [...verdicts.entries()].slice(-MAX_REMEMBERED);
  writeAtomic(VERDICTS_FILE, JSON.stringify(Object.fromEntries(kept), null, 2) + "\n");
}

const byState = (s: HealthState): number => health.filter((h) => h.state === s).length;
console.log("run");
console.log(`  changed                ${String(tally.changed).padStart(3)}`);
console.log(`  unchanged              ${String(tally.unchanged).padStart(3)}`);
console.log(`  skipped by robots.txt  ${String(tally.robots_skip).padStart(3)}`);
console.log(`  no readable text       ${String(tally.unreadable).padStart(3)}`);
console.log(`  failed                 ${String(tally.failed).padStart(3)}`);
console.log("\nhealth file");
console.log(`  healthy                ${String(byState("healthy")).padStart(3)}`);
console.log(`  degraded               ${String(byState("degraded")).padStart(3)}`);
console.log(`  broken                 ${String(byState("broken")).padStart(3)}`);
// The spec's thresholds call a single failure "healthy", so a source can be
// green and still be carrying a live error. Print that separately rather than
// let the state column imply everything is fine.
const carryingError = health.filter((h) => h.lastError !== null).length;
console.log(`  carrying a live error  ${String(carryingError).padStart(3)}`);

// The fallback path keeps a source alive but its text is noisier, so knowing
// how much of the dataset rests on it is worth a line of its own.
const fallback = snapshots.filter((s) => s.extractionMethod === "body_fallback");
console.log("\nextraction");
console.log(
  `  readability            ${String(snapshots.length - fallback.length).padStart(3)}`,
);
console.log(`  body fallback          ${String(fallback.length).padStart(3)}`);

// Thin and unmoving for long enough to be worth a human glance. Not an error:
// a training page with nothing on it is the normal state out of season.
const silent = snapshots.filter(
  (s) => s.thinRuns >= SILENT_THIN_RUNS && (s.extractedChars ?? 0) < THIN_CHARS,
);
if (silent.length > 0) {
  console.log("\nsilent thin sources");
  for (const s of silent) {
    console.log(
      `  ${s.orgId.padEnd(14)} ${String(s.extractedChars).padStart(5)} chars, unchanged for ${s.thinRuns} runs`,
    );
  }
}

if (promotions.length > 0) {
  console.log("\npromoted to browser in CI");
  console.log(promotions.join("\n"));
}

console.log(`\nclassification (${NO_CLASSIFY ? "skipped" : CLASSIFIER_MODEL})`);
console.log(`  owed a verdict         ${String(owed.length).padStart(3)}`);
console.log(`  announcements          ${String(classified).padStart(3)}`);
console.log(`  not an announcement    ${String(notAnnouncements).padStart(3)}`);
console.log(`  needs manual review    ${String(reviewQueue.length).padStart(3)}`);
console.log(`\nwhat was not paid for`);
console.log(`  no training word       ${String(skippedByFilter).padStart(3)}  (never sent, free)`);
console.log(`  ruled out in one word  ${String(triagedOut).padStart(3)}  (asked cheaply, not judged in full)`);
console.log(`  answered from memory   ${String(fromMemory).padStart(3)}  (identical text already judged)`);
console.log(`  vanished from source   ${String(vanished.length).padStart(3)}`);
if (vanished.length > 0) {
  console.log("\nno longer visible on the page that announced them:");
  console.log(vanished.join("\n"));
}
console.log(
  `  tokens                 ${spend.inputTokens} in / ${spend.outputTokens} out = $${costOf(spend).toFixed(4)}`,
);
if (budgetStopped > 0) {
  console.log(
    `  budget                 stopped at $${RUN_BUDGET_USD}; ${budgetStopped} page(s) still owed a verdict and will be judged next run`,
  );
}

// Never a silent queue. Every unjudged source is named, with why it failed.
if (reviewQueue.length > 0) {
  console.log("\nneeds manual review");
  console.log(reviewQueue.join("\n"));
  console.log("  these keep their hash and stay queued for the next run.");
}
if (browserTargets.length > 0 && browserUnavailable()) {
  console.log(
    "\nheadless chromium never launched, so the rendered sources are recorded as degraded.\n" +
      'The static half of this run completed normally. Fix with "npx playwright install chromium".',
  );
}
if (DRY_RUN) console.log("\ndry run: data/health.json and data/snapshots.json were not touched.");
