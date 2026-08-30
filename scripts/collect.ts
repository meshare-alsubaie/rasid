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
import { readFileSync, writeFileSync } from "node:fs";
import { HAS_CONTACT, USER_AGENT } from "../src/pipeline/agent";
import { browserUnavailable, closeBrowser, renderPage } from "../src/pipeline/browser";
import { CLASSIFIER_MODEL, classify, costOf, type Usage } from "../src/pipeline/classify";
import { asManualReview, fromClassification } from "../src/pipeline/opportunity";
import { extract, sha256 } from "../src/pipeline/extract";
import { fetchPage, paced } from "../src/pipeline/fetch";
import { checkFinalUrl, checkRobots } from "../src/pipeline/robots";
import { MAX_BROWSER_SOURCES, SILENT_THIN_RUNS, THIN_CHARS } from "../src/types";
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
const browserTargets = targets.filter((t) => t.renderMode === "browser");

if (browserTargets.length > MAX_BROWSER_SOURCES) {
  console.error(
    `${browserTargets.length} sources ask for the browser, and the cap is ${MAX_BROWSER_SOURCES}.\n` +
      "That many javascript-only pages means the source list needs revisiting, not a bigger cap.",
  );
  process.exit(1);
}

const now = new Date().toISOString();
const healthByUrl = new Map(priorHealth.map((h) => [h.sourceUrl, h]));
const snapshotByUrl = new Map(priorSnapshots.map((s) => [s.sourceUrl, s]));

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

// robots.txt first, one fetch per origin, in sequence. Warming the cache this
// way keeps a run from opening with a burst of parallel robots requests.
for (const origin of new Set(targets.map((t) => new URL(t.url).origin))) {
  await checkRobots(origin);
}

// Every source is awaited, and a rejection here would be a bug in this file
// rather than a bad page: collect() converts page failures into health records.
await Promise.all(staticTargets.map((t) => collect(t)));

// Rendered sources run strictly one at a time, after the cheap work is done.
for (const t of browserTargets) await collect(t);

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
let classified = 0;
let notAnnouncements = 0;

const owed = [...snapshotByUrl.values()].filter(
  (s) => (RECLASSIFY || s.pendingClassification) && textByUrl.has(s.sourceUrl),
);

if (!NO_CLASSIFY) {
  for (const snap of owed) {
    const text = textByUrl.get(snap.sourceUrl) ?? "";
    const prior = priorOpportunities.find(
      (o) => o.orgId === snap.orgId && o.sourceUrl === snap.sourceUrl,
    );
    const common = {
      orgId: snap.orgId,
      sourceUrl: snap.sourceUrl,
      text,
      nowISO: now,
      prior,
      firstTime: !orgsWithHistory.has(snap.orgId),
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
    for (const [id, o] of opportunityById) {
      if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
    }
    if (!result.value.isTrainingAnnouncement) {
      notAnnouncements++;
      continue;
    }
    const record = fromClassification({ ...common, c: result.value });
    opportunityById.set(record.id, record);
    classified++;
  }
}

if (VERBOSE) console.log(lines.sort().join("\n") + "\n");

const health = [...healthByUrl.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
const snapshots = [...snapshotByUrl.values()].sort((a, b) =>
  a.sourceUrl.localeCompare(b.sourceUrl),
);

if (!DRY_RUN) {
  writeFileSync("data/health.json", JSON.stringify(health, null, 2) + "\n", "utf8");
  writeFileSync("data/snapshots.json", JSON.stringify(snapshots, null, 2) + "\n", "utf8");
  // Only rewritten when a promotion actually happened, so an ordinary run
  // never touches the dataset the whole project is built on.
  if (promotions.length > 0) {
    writeFileSync("data/organisations.json", JSON.stringify(orgs, null, 2) + "\n", "utf8");
  }
  const opportunities = [...opportunityById.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync("data/opportunities.json", JSON.stringify(opportunities, null, 2) + "\n", "utf8");
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
console.log(
  `  tokens                 ${spend.inputTokens} in / ${spend.outputTokens} out = $${costOf(spend).toFixed(4)}`,
);

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
