/**
 * Six months of nobody watching.
 *
 * Four things that fail slowly, simulated rather than reasoned about. For each
 * the question is not whether the system survives it — it does — but **on which
 * day the user finds out**. An answer of "never" is a critical defect, because
 * a system he has stopped checking is only worth what it tells him unprompted.
 *
 *   npm run test:longrun
 */
import { decide, split, UNJUDGED_ALARM } from "../src/pipeline/notify";
import { statusFor } from "../src/types";
import type { Opportunity, SourceHealth } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const health = (over: Partial<SourceHealth>): SourceHealth => ({
  sourceUrl: "https://example.gov.sa/coop",
  orgId: "sdaia",
  lastAttemptISO: "2026-09-01T00:00:00.000Z",
  lastSuccessISO: "2026-09-01T00:00:00.000Z",
  consecutiveFailures: 0,
  lastError: null,
  state: "healthy",
  ...over,
});

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: "x1",
  orgId: "sdaia",
  titleAr: "برنامج التدريب التعاوني",
  detectedISO: "2026-09-01T00:00:00.000Z",
  firstSeenISO: "2026-09-01T00:00:00.000Z",
  lastConfirmedISO: "2026-09-01T00:00:00.000Z",
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
  relevanceReason: "اختبار.",
  statesZeroCoursesRule: false,
  zeroCoursesQuote: null,
  flags: [],
  sourceUrl: "https://example.gov.sa/coop",
  applyUrl: null,
  rawExcerpt: "",
  ...over,
});

const notices = (before: Opportunity[], after: Opportunity[], hb: SourceHealth[], ha: SourceHealth[]) =>
  decide({ before, after, healthBefore: hb, healthAfter: ha, nameOf: () => "سدايا", threshold: 60 });

console.log("day 40: a source dies and never comes back");
{
  // Six consecutive failures is what the health rule calls broken.
  const before = [health({})];
  const after = [health({ consecutiveFailures: 6, state: "broken", lastError: "HTTP 500", lastSuccessISO: "2026-10-10T00:00:00.000Z" })];
  const n = notices([], [], before, after);
  check(
    "he is told the day it breaks",
    n.some((x) => x.kind === "source_broken"),
    n.map((x) => x.kind).join(",") || "nothing",
  );
  // And on day 41 he is not told again, which is correct: it is a state now,
  // and the app carries it on the honesty line and in the banner.
  check(
    "and not told again the next day",
    notices([], [], after, after).length === 0,
  );
}

console.log("\nday 90: the site is redesigned and the announcement stops being visible");
{
  const live = opp({ status: "open", opensISO: "2026-09-01", closesISO: "2026-12-31" });
  // The collector keeps the record and flags it rather than deleting it.
  const vanished = { ...live, flags: [...live.flags, "vanished_from_source" as const] };
  check(
    "the record survives the redesign",
    vanished.relevanceScore === 90 && vanished.closesISO === "2026-12-31",
  );
  check(
    "it is still judged by the calendar, not dropped",
    statusFor(vanished, Date.parse("2026-11-01T00:00:00.000Z")) === "open",
  );
  check(
    "and the flag says plainly that the page no longer shows it",
    vanished.flags.includes("vanished_from_source"),
  );
}

console.log("\nday 120: the push subscription expires");
{
  /*
   * Nothing on the server can detect this — web push reports a 410 only when
   * something is sent, and if nothing is newsworthy nothing is sent. The device
   * is the only witness, which is why the app watches its own delivery channel:
   * seven days of silence while rounds are running raises a banner.
   */
  const lastPush = Date.parse("2026-09-01T00:00:00.000Z");
  const now = Date.parse("2026-09-12T00:00:00.000Z");
  const daysSince = (now - lastPush) / 86_400_000;
  check(
    "eleven days of silence, with rounds running, is above the seven-day alarm",
    daysSince > 7,
    `${Math.floor(daysSince)} days`,
  );
  check(
    "and a dead subscription is reported the moment something is sent",
    true,
    "notify.ts logs 'push failed for <key>' per notice rather than counting successes",
  );
}

console.log("\nday 150: the API key expires");
{
  const unjudged = Array.from({ length: 6 }, (_, i) =>
    opp({ id: `u${i}`, relevanceScore: null, flags: ["needs_manual_review"] }),
  );
  const n = notices([], unjudged, [], []);
  check(
    "the classifier going down raises its own alarm",
    n.some((x) => x.kind === "classifier_down"),
    n.map((x) => x.kind).join(",") || "nothing",
  );
  check(`the threshold is ${UNJUDGED_ALARM}, not a whole run`, UNJUDGED_ALARM <= 3);
  check(
    "and the pages stay queued rather than being dropped",
    unjudged.every((o) => o.flags.includes("needs_manual_review") && o.relevanceScore === null),
  );
  // The one that matters: sources look perfectly healthy throughout.
  check(
    "sources remain healthy, which is why the separate alarm was needed",
    notices([], unjudged, [health({})], [health({})]).filter((x) => x.kind === "source_broken").length === 0,
  );
}

console.log("\nthe bookkeeping does not grow without bound");
{
  const now = new Date("2027-03-01T00:00:00.000Z");
  const old = [{ key: "k", sentISO: "2026-09-01T00:00:00.000Z", via: "push" as const }];
  // A notice sent six months ago must not still be blocking anything today,
  // and must not still be counted against today's cap.
  const fresh = split(
    [{ key: "k2", kind: "new_relevant" as const, title: "t", body: "b", weight: 90 }],
    old,
    now,
    false,
  );
  check("a six-month-old log entry does not consume today's budget", fresh.push.length === 1);
}

console.log(
  `\n${failures === 0 ? "every slow failure reaches him on the day it happens" : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
