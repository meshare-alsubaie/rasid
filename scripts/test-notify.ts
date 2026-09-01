/**
 * The notification rules, exercised against made-up runs.
 *
 * What is being defended here is the user's attention. A notifier that repeats
 * itself, or wakes someone for a programme he cannot apply to, gets muted, and
 * a muted app misses the seven-day window it exists to catch.
 *
 *   npm run test:notify
 */
import { decide, inQuietHours, split, BAND, DAILY_PUSH_CAP, type Notice } from "../src/pipeline/notify";
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

const health = (
  state: SourceHealth["state"],
  sourceUrl = "https://example.gov.sa/a",
): SourceHealth => ({
  sourceUrl,
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

/*
 * A page is very often seen before it can be judged: the classifier fails, the
 * round runs out of budget, or the text is not readable on the first pass. That
 * sighting stores a record with a null score, which is rightly not announced.
 *
 * The rule used to be "announce a row that was not here last time", so once the
 * next round produced a verdict the row was no longer new and nothing was ever
 * sent. Two announcements scoring 95, both an exact match for his major, were
 * found sitting in the data in exactly that state: never queued, never sent.
 */
check(
  "a record judged only on a later round is still announced",
  run([opp({ relevanceScore: null })], [opp({ relevanceScore: 95 })]).some(
    (n) => n.kind === "new_relevant" && n.weight === BAND.newRelevant + 95,
  ),
  "seen first, judged second, is the normal path — not an edge case",
);
check(
  "and it is announced under the same key, so it can only go out once",
  run([opp({ relevanceScore: null })], [opp({ relevanceScore: 95 })]).find(
    (n) => n.kind === "new_relevant",
  )?.key === "new:x",
);
check(
  "and one that becomes judgeable but scores low is still not announced",
  run([opp({ relevanceScore: null })], [opp({ relevanceScore: 20 })]).length === 0,
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
/*
 * Repetition is prevented by the sent log, not by `decide` guessing whether a
 * row looks new. `decide` proposes the same notice every round on purpose, so
 * that a record which arrives at a verdict late — the normal case, not an edge
 * case — is still announced. `split` is what refuses a key that has gone out.
 * That is the guarantee worth testing, so it is tested through both.
 */
check(
  "an unchanged announcement is proposed again",
  run([opp({})], [opp({})]).some((n) => n.key === "new:x"),
  "proposing is free; the sent log is what decides",
);
check(
  "but it is not delivered twice",
  split(
    run([opp({})], [opp({})]),
    [{ key: "new:x", sentISO: "2026-08-31T06:00:00.000Z", via: "push" }],
    new Date("2026-09-01T09:00:00.000Z"),
    false,
  ).push.length === 0,
);
check(
  "and one that was never sent still goes out, however old the record is",
  split(
    run([opp({})], [opp({})]),
    [],
    new Date("2026-09-01T09:00:00.000Z"),
    false,
  ).push.some((n) => n.key === "new:x"),
  "this is what recovers a record the old newness rule silently skipped",
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
 * A classifier that stops must be as loud as a crawler that stops. It was not:
 * `decide` skips a record it could not score, so an expired key meant no
 * notification would ever be sent again, from a system whose sources all looked
 * perfectly healthy.
 */
console.log("\nthe classifier going down is itself news");
const unjudged = (n: number): Opportunity[] =>
  Array.from({ length: n }, (_, i) =>
    opp({ id: `u${i}`, relevanceScore: null, flags: ["needs_manual_review"] }),
  );

const outage = run([], unjudged(5));
check(
  "five unjudged pages raise the alarm",
  outage.some((n) => n.kind === "classifier_down"),
  outage.map((n) => n.kind).join(",") || "none",
);
check(
  "one unjudged page does not",
  !run([], unjudged(1)).some((n) => n.kind === "classifier_down"),
);
check(
  "and it is said once a day, not once a round",
  new Set(run([], unjudged(5)).concat(run([], unjudged(9))).filter((n) => n.kind === "classifier_down").map((n) => n.key)).size === 1,
);
check(
  "an unjudged record still never becomes an opportunity notice",
  !outage.some((n) => n.kind === "new_relevant" || n.kind === "opened"),
);

console.log("\ntwo in one round, and neither is swallowed");
const pair: Notice[] = [
  { key: "new:nca", kind: "new_relevant", title: "أ", body: "b", weight: 95 },
  { key: "new:snb", kind: "new_relevant", title: "ب", body: "b", weight: 65 },
];
const both = split(pair, [], now, false);
check("both are pushed", both.push.length === 2, String(both.push.length));
check(
  "and they carry different keys, so the device cannot collapse them into one banner",
  new Set(both.push.map((n) => n.key)).size === 2,
);
check(
  "the more relevant one goes first",
  both.push[0]!.key === "new:nca",
  both.push.map((n) => n.key).join(","),
);

/*
 * A deadline is not allowed to wait for morning.
 *
 * Quiet hours exist so the app does not wake him for news that keeps. A window
 * closing inside forty-eight hours does not keep: held from 02:00 to 07:00 it
 * loses five of them, and if the digest is configured it is emailed instead and
 * never pushed at all. The whole product exists to prevent exactly this, so the
 * one notice kind that is about a deadline overrides the silence.
 */
console.log("\na deadline overrides quiet hours");
const atThree = new Date("2026-09-01T00:00:00.000Z"); // 03:00 in Riyadh
const deadline: Notice[] = [
  { key: "closing:x", kind: "closing_soon", title: "t", body: "b", weight: 300 },
  { key: "new:y", kind: "new_relevant", title: "t", body: "b", weight: 80 },
];
const night = split(deadline, [], atThree, true);
check(
  "a closing_soon notice is pushed at three in the morning",
  night.push.some((n) => n.kind === "closing_soon"),
  `push=[${night.push.map((n) => n.kind).join(",")}] digest=[${night.digestOnly.map((n) => n.kind).join(",")}]`,
);
check(
  "and everything that can wait still waits",
  !night.push.some((n) => n.kind === "new_relevant") &&
    night.digestOnly.some((n) => n.kind === "new_relevant"),
);
check(
  "a deadline already sent is still not sent twice, override or not",
  split(deadline, [{ key: "closing:x", sentISO: atThree.toISOString(), via: "push" }], atThree, true)
    .push.length === 0,
);

/*
 * Written as UTC instants, deliberately. Riyadh is UTC+3 and never moves, so
 * each of these is one unambiguous moment, and the test now says the same thing
 * on the owner's machine and on a runner in another timezone — which is the
 * whole point of the fix it guards.
 */
/*
 * The exact mix that exposed the inversion, replayed.
 *
 * Twelve sources had stopped loading and the classifier had failed on a batch,
 * which is an ordinary bad morning. Every one of those alarms outweighed an
 * opportunity, so the six push slots went to housekeeping and two co-op
 * announcements scoring 95 — both an exact match for his major — were ranked
 * into the digest. The digest is email, and email is not configured.
 *
 * An alarm about the tool is worth saying. It is never worth saying instead of
 * an opening.
 */
console.log("\na bad morning for the tool never buries an opening");
{
  const broken = Array.from({ length: 12 }, (_, i) =>
    health("broken", `https://example.gov.sa/dead-${i}`),
  );
  const wasBroken = broken.map((h) => ({ ...h, state: "degraded" as const }));
  const twoMatches = [
    opp({ id: "gold-a", relevanceScore: 95, sourceUrl: "https://example.gov.sa/a" }),
    opp({ id: "gold-b", relevanceScore: 95, sourceUrl: "https://example.gov.sa/b" }),
  ];
  const unjudged = Array.from({ length: 9 }, (_, i) =>
    opp({ id: `u${i}`, relevanceScore: null, flags: ["needs_manual_review"] }),
  );

  const notices = run([], [...twoMatches, ...unjudged], wasBroken, broken);
  const { push, digestOnly } = split(notices, [], new Date("2026-09-01T09:00:00.000Z"), false);
  const pushed = new Set(push.map((n) => n.key));

  check(
    "both 95s are pushed, not digested",
    pushed.has("new:gold-a") && pushed.has("new:gold-b"),
    `pushed: ${[...pushed].join(", ")}`,
  );
  check(
    "and they go first",
    push[0]!.key.startsWith("new:gold") && push[1]!.key.startsWith("new:gold"),
  );
  check(
    "the classifier alarm still gets a slot",
    push.some((n) => n.kind === "classifier_down"),
  );
  check(
    "broken sources fill what is left, and the rest wait in the digest",
    push.filter((n) => n.kind === "source_broken").length === DAILY_PUSH_CAP - 3 &&
      digestOnly.filter((n) => n.kind === "source_broken").length === 12 - (DAILY_PUSH_CAP - 3),
  );
}

console.log("\nthe order of the bands, stated once so it cannot drift");
{
  const at = (kind: string, list: Notice[]): number => list.find((n) => n.kind === kind)?.weight ?? -1;
  const deadline = run([opp({ closesISO: new Date(Date.now() + 36 * 3600_000).toISOString() })], [opp({ closesISO: new Date(Date.now() + 36 * 3600_000).toISOString() })]);
  const opened = run([opp({ status: "announced_not_open" })], [opp({ status: "open" })]);
  const fresh = run([], [opp({})]);
  const down = run([], Array.from({ length: 9 }, (_, i) => opp({ id: `d${i}`, relevanceScore: null, flags: ["needs_manual_review"] })));
  const dead = run([], [], [health("degraded")], [health("broken")]);
  check(
    "closing > opened > new > classifier_down > source_broken",
    at("closing_soon", deadline) > at("opened", opened) &&
      at("opened", opened) > at("new_relevant", fresh) &&
      at("new_relevant", fresh) > at("classifier_down", down) &&
      at("classifier_down", down) > at("source_broken", dead),
    `${at("closing_soon", deadline)} > ${at("opened", opened)} > ${at("new_relevant", fresh)} > ${at("classifier_down", down)} > ${at("source_broken", dead)}`,
  );
  check(
    "the lowest-scoring opening still outranks the tool complaining about itself",
    at("new_relevant", run([], [opp({ relevanceScore: 60 })])) > at("source_broken", dead),
  );
}

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
