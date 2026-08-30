/**
 * The notification rules, exercised against made-up runs.
 *
 * What is being defended here is the user's attention. A notifier that repeats
 * itself, or wakes someone for a programme he cannot apply to, gets muted, and
 * a muted app misses the seven-day window it exists to catch.
 *
 *   npm run test:notify
 */
import { decide, inQuietHours, split, DAILY_PUSH_CAP, type Notice } from "../src/pipeline/notify";
import type { Opportunity, SourceHealth } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: "x",
  orgId: "sdaia",
  titleAr: "برنامج التدريب التعاوني",
  detectedISO: "2026-08-01T00:00:00.000Z",
  firstSeenISO: "2026-08-01T00:00:00.000Z",
  lastConfirmedISO: "2026-08-01T00:00:00.000Z",
  status: "unknown",
  opensISO: null,
  closesISO: null,
  closesHijri: null,
  product: "coop",
  majors: [],
  seats: null,
  stipendSAR: null,
  durationWeeks: null,
  cities: [],
  relevanceScore: 90,
  relevanceReason: "مطابق",
  statesZeroCoursesRule: false,
  zeroCoursesQuote: null,
  flags: [],
  sourceUrl: "https://example.gov.sa/a",
  applyUrl: null,
  rawExcerpt: "",
  ...over,
});

const health = (state: SourceHealth["state"]): SourceHealth => ({
  sourceUrl: "https://example.gov.sa/a",
  orgId: "sdaia",
  lastAttemptISO: new Date().toISOString(),
  lastSuccessISO: null,
  consecutiveFailures: state === "broken" ? 6 : 0,
  lastError: state === "broken" ? "gone" : null,
  state,
});

const run = (before: Opportunity[], after: Opportunity[], hb: SourceHealth[] = [], ha: SourceHealth[] = []): Notice[] =>
  decide({ before, after, healthBefore: hb, healthAfter: ha, nameOf: () => "سدايا", threshold: 60 });

console.log("what earns a notification");
check("a new relevant announcement does", run([], [opp({})]).some((n) => n.kind === "new_relevant"));
check(
  "a low-relevance one does not",
  run([], [opp({ relevanceScore: 20 })]).length === 0,
);
check(
  "a graduate-development one never does",
  run([], [opp({ product: "graduate_dev", flags: ["wrong_product"] })]).length === 0,
);
check(
  "an unclassified record never does",
  run([], [opp({ relevanceScore: null, flags: ["needs_manual_review"] })]).length === 0,
  "null is not a score, and it is not news either",
);
check(
  "an unchanged announcement does not repeat",
  run([opp({})], [opp({})]).length === 0,
);
check(
  "a status turning open does",
  run([opp({ status: "announced_not_open" })], [opp({ status: "open" })]).some((n) => n.kind === "opened"),
);
check(
  "a close within 48 hours does",
  run([], [opp({ closesISO: new Date(Date.now() + 30 * 3600_000).toISOString() })]).some(
    (n) => n.kind === "closing_soon",
  ),
);
check(
  "a close in two weeks does not",
  !run([], [opp({ closesISO: new Date(Date.now() + 14 * 86_400_000).toISOString() })]).some(
    (n) => n.kind === "closing_soon",
  ),
);
check(
  "a source going broken does",
  run([], [], [health("healthy")], [health("broken")]).some((n) => n.kind === "source_broken"),
);
check(
  "a source that was already broken does not",
  run([], [], [health("broken")], [health("broken")]).length === 0,
);

console.log("\nthe daily cap and quiet hours");
const many: Notice[] = Array.from({ length: 9 }, (_, i) => ({
  key: `k${i}`,
  kind: "new_relevant",
  title: "t",
  body: "b",
  weight: i,
}));
const now = new Date("2026-09-01T12:00:00.000Z");

const capped = split(many, [], now, false);
check(`only ${DAILY_PUSH_CAP} are pushed`, capped.push.length === DAILY_PUSH_CAP, String(capped.push.length));
check("the rest go to the digest, not the bin", capped.digestOnly.length === 3, String(capped.digestOnly.length));
check("the most urgent are the ones pushed", capped.push[0]!.weight === 8);

const quiet = split(many, [], now, true);
check("quiet hours push nothing", quiet.push.length === 0);
check("quiet hours still digest everything", quiet.digestOnly.length === 9);

const repeat = split(many, many.map((n) => ({ key: n.key, sentISO: now.toISOString() })), now, false);
check("nothing already sent is sent twice", repeat.push.length === 0 && repeat.digestOnly.length === 0);

/*
 * The cap counts pushes, not deliveries.
 *
 * A quiet night routes everything to the email digest, and every digested item
 * was written to the same log the cap reads. Nine emailed items at three in the
 * morning therefore left no room to push anything at all the next day: the real
 * announcements were silently demoted to email, on the morning they mattered.
 */
const emailedLastNight = Array.from({ length: 9 }, (_, i) => ({
  key: `old${i}`,
  sentISO: now.toISOString(),
  via: "digest" as const,
}));
const morningAfter = split(many, emailedLastNight, now, false);
check(
  "a night of digests does not eat the next day's push budget",
  morningAfter.push.length === DAILY_PUSH_CAP,
  String(morningAfter.push.length),
);

const pushedAlready = emailedLastNight.map((e) => ({ ...e, via: "push" as const }));
check(
  "pushes do still count against it",
  split(many, pushedAlready, now, false).push.length === 0,
);

/* An entry written before the channel was recorded is counted as a push, which
   is the cautious reading: it can only ever hold notifications back, never let
   extra ones through. */
const legacy = emailedLastNight.map(({ key, sentISO }) => ({ key, sentISO }));
check(
  "a log entry with no channel recorded is treated as a push",
  split(many, legacy, now, false).push.length === 0,
);

/*
 * Written as UTC instants, deliberately. Riyadh is UTC+3 and never moves, so
 * each of these is one unambiguous moment, and the test now says the same thing
 * on the owner's machine and on a runner in another timezone — which is the
 * whole point of the fix it guards.
 */
console.log("\nquiet-hour boundaries (Riyadh)");
const riyadh = (hhmmZ: string): Date => new Date(`2026-09-01T${hhmmZ}:00.000Z`);
check("23:00 Riyadh is quiet when quiet starts at 23", inQuietHours(riyadh("20:00"), 23, 7));
check("07:00 Riyadh is not quiet when quiet ends at 7", !inQuietHours(riyadh("04:00"), 23, 7));
check("03:00 Riyadh is quiet across midnight", inQuietHours(riyadh("00:00"), 23, 7));
check("12:00 Riyadh is never quiet", !inQuietHours(riyadh("09:00"), 23, 7));
check(
  "the runner's own timezone does not change the answer",
  inQuietHours(riyadh("20:00"), 23, 7) && !inQuietHours(riyadh("20:00"), 23, 7, "UTC"),
  "20:00Z is 23:00 in Riyadh but 20:00 in UTC",
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
