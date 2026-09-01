/**
 * Deciding what is worth waking someone for.
 *
 * Kept as a pure function over the old and new datasets so the rules can be
 * read, tested, and argued with in one place, separate from the sending.
 *
 * The bar is spec section 5.4: something has to be *newly* true. A window that
 * was open yesterday and is open today is not news, and an app that says so
 * every six hours teaches its user to swipe the notifications away, which is
 * the same failure as a stale green light wearing a different coat.
 */
import { endOfDeadline, hijriOf } from "../types";
import type { Opportunity, SourceHealth } from "../types";

export type NoticeKind =
  | "new_relevant"
  | "opened"
  | "closing_soon"
  | "few_seats"
  | "source_broken"
  /**
   * The classifier could not judge what was read.
   *
   * A crawler that stops is loud; a classifier that stops was silent, and it is
   * the more dangerous of the two. `decide` skips any record with a null score,
   * so a revoked key or an outage means every changed page becomes unjudgeable
   * and *nothing is ever pushed again* — while every source stays green,
   * because fetching them worked perfectly. The only trace was a small counter
   * on a screen nobody had a reason to open. This is that failure, said aloud.
   */
  | "classifier_down";

export interface Notice {
  /** Stable across runs, so the log can prove a thing was said only once. */
  key: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** Higher goes out first when the daily cap bites. */
  weight: number;
}

export interface NoticeLogEntry {
  key: string;
  sentISO: string;
  /**
   * Which channel carried it. The cap below is six *pushes*, so a digest entry
   * must not eat the budget — before this field existed, one quiet night with
   * nine emailed items left no room to push anything the following day.
   * Absent on entries written before the distinction existed; those are counted
   * as pushes, which is the cautious reading.
   */
  via?: "push" | "digest";
}

/** Spec 5.4: never more than six pushes in a day. The rest goes to the digest. */
export const DAILY_PUSH_CAP = 6;

/**
 * What outranks what when only six can go out.
 *
 * These were ad-hoc numbers, and the ordering they produced was backwards in a
 * way that cost exactly what this project exists to protect. A broken source
 * weighed 150 and an opportunity weighed its relevance score, at most 100 — so
 * twelve "this page stopped loading" alarms and one "the classifier is down"
 * filled every slot, and two co-op announcements scoring 95, both an exact match
 * for his major, were ranked below them and pushed into the digest. The digest
 * is email, and email is not configured, so they would have reached him nowhere
 * at all.
 *
 * The ordering that follows is by what missing the notice actually costs him:
 *
 *   a window about to shut      cannot be recovered once it passes
 *   a window that just opened   he can act on today
 *   seats running out           the same window, with less time
 *   a new match                 the thing he asked to be told about
 *   the classifier is blind     he must check by hand until it is fixed
 *   one source stopped loading  one page of a hundred and fifteen, in the app
 *
 * Housekeeping sits at the bottom on purpose. An alarm about the tool is worth
 * saying; it is never worth saying *instead of* an opening.
 */
/**
 * How long the sent log remembers, and how long a record may keep asking.
 *
 * These two exist as a pair because they constrain each other. `decide` now
 * proposes a new-opportunity notice every round and lets the sent log refuse
 * the repeat — which is what recovers a record that reaches a verdict late.
 * But the log is pruned, and a proposal that outlives its own log entry comes
 * back as a fresh notice: the same opening announced again a month later, with
 * nothing wrong-looking anywhere to explain it.
 *
 * So the window in which a record may still be announced is kept strictly
 * shorter than the log's memory. Fourteen days is far longer than the delay
 * this is meant to survive — a round that failed, a budget that ran out, a page
 * that was not readable yet — and a record still unjudged after two weeks means
 * the classifier has been down that long, which raises its own alarm every day.
 */
export const ANNOUNCE_WINDOW_DAYS = 14;
export const LOG_RETENTION_DAYS = 31;

export const BAND = {
  closingSoon: 500,
  opened: 400,
  fewSeats: 300,
  newRelevant: 200,
  classifierDown: 250,
  sourceBroken: 150,
} as const;

const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * The body of a notice, as spec 5.4 asks: role, city, seats, days remaining and
 * the Hijri date.
 *
 * It used to be the title and the relevance score, which is the one number a
 * person cannot act on. Every part is dropped when it was not published rather
 * than filled with a plausible default — an alert is the last place to guess.
 */
function details(o: Opportunity): string {
  const parts = [o.titleAr];
  if (o.cities.length > 0) parts.push(o.cities.join("، "));
  if (o.seats !== null) parts.push(`${o.seats} مقعداً`);
  if (o.closesISO !== null) {
    const days = Math.max(0, Math.ceil(hoursUntil(o.closesISO) / 24));
    parts.push(`يغلق بعد ${days} يوم`);
    const hijri = o.closesHijri ?? hijriOf(o.closesISO);
    if (hijri !== null) parts.push(hijri);
  }
  return parts.join(" · ");
}
/* To the end of the published day in Riyadh — see `endOfDeadline`. Measured
 * from midnight UTC instead, the 48-hour alert fired a day early and then went
 * silent through the whole of the final day. */
const hoursUntil = (iso: string): number => (endOfDeadline(iso) - Date.now()) / 3_600_000;

export interface DecideInput {
  before: Opportunity[];
  after: Opportunity[];
  healthBefore: SourceHealth[];
  healthAfter: SourceHealth[];
  nameOf: (orgId: string) => string;
  threshold: number;
}

/** More than this many unjudged pages in one round is an outage, not bad luck. */
export const UNJUDGED_ALARM = 3;

export function decide(input: DecideInput): Notice[] {
  const { before, after, healthBefore, healthAfter, nameOf, threshold } = input;
  const prior = new Map(before.map((o) => [o.id, o]));
  const priorHealth = new Map(healthBefore.map((h) => [h.sourceUrl, h.state]));
  const out: Notice[] = [];

  for (const o of after) {
    const was = prior.get(o.id);
    const org = nameOf(o.orgId);
    const score = o.relevanceScore;

    // A record we could not judge is never announced as an opportunity. It is
    // surfaced in the app's review queue instead: waking someone for a thing
    // we cannot describe is noise, not diligence.
    if (score === null) continue;
    if (o.flags.includes("wrong_product")) continue;

    /*
     * Announce anything worth announcing, every round, and let the sent log
     * decide what has already gone out.
     *
     * This used to ask whether the row was absent last round — and that was the
     * exact failure this project exists to prevent. A page is very often seen
     * before it can be judged: the classifier fails, the round hits its budget,
     * or the text is not readable on the first pass. That sighting stores a
     * record with `relevanceScore: null`, which is rightly skipped above. The
     * next round produces a verdict, but by then the row is no longer new, so
     * no notice was ever emitted. The record sat in the file at 95 with nothing
     * in the queue and nothing in the log.
     *
     * It was not hypothetical. Two co-op announcements scoring 95, both an
     * exact match for his major, were found in precisely that state — never
     * queued, never sent, while a 65 waited in the queue ahead of them.
     *
     * Nothing about "was it new" is trustworthy enough to gate a notification
     * on, because there are as many ways to arrive late as there are ways for a
     * round to go wrong. `split` already refuses any key in the sent log, and
     * that log is the only real answer to "has he been told". So the condition
     * is simply whether it deserves telling; emitting it again next round is
     * free and costs one set lookup, while missing it once costs a semester.
     * This also heals every record that was skipped while the old rule stood.
     */
    const daysKnown = (Date.now() - Date.parse(o.firstSeenISO)) / 86_400_000;
    if (score >= Math.max(60, threshold) && daysKnown <= ANNOUNCE_WINDOW_DAYS) {
      out.push({
        key: `new:${o.id}`,
        kind: "new_relevant",
        title: `🟢 إعلان جديد — ${org}`,
        body: details(o),
        weight: BAND.newRelevant + score,
      });
    }

    if (was !== undefined && was.status !== "open" && o.status === "open") {
      out.push({
        key: `opened:${o.id}`,
        kind: "opened",
        title: `🟢 فتح التقديم — ${org}`,
        body: details(o),
        weight: BAND.opened + score,
      });
    }

    if (o.closesISO !== null && hoursUntil(o.closesISO) <= 48 && hoursUntil(o.closesISO) > 0) {
      out.push({
        key: `closing:${o.id}:${dayOf(o.closesISO)}`,
        kind: "closing_soon",
        title: `⏳ يغلق قريباً — ${org}`,
        body: `${o.titleAr} · تبقّى ${Math.ceil(hoursUntil(o.closesISO))} ساعة${o.cities.length > 0 ? ` · ${o.cities.join("، ")}` : ""}${o.seats !== null ? ` · ${o.seats} مقعداً` : ""}`,
        weight: BAND.closingSoon + score,
      });
    }

    if (o.seats !== null && o.seats <= 5 && score >= 70 && was?.seats !== o.seats) {
      out.push({
        key: `seats:${o.id}:${o.seats}`,
        kind: "few_seats",
        title: `⚠ مقاعد قليلة — ${org}`,
        body: `${o.titleAr} · ${o.seats} مقاعد`,
        weight: BAND.fewSeats + score,
      });
    }
  }

  // A source we can no longer read is the one alarm that is about us, not
  // about an opening. He asked to rely on this app, so it owes him the moment
  // it stops being able to see.
  for (const h of healthAfter) {
    if (h.state === "broken" && priorHealth.get(h.sourceUrl) !== "broken") {
      out.push({
        key: `broken:${h.sourceUrl}`,
        kind: "source_broken",
        title: `🔴 مصدر توقّف — ${nameOf(h.orgId)}`,
        body: "لم يعد يُقرأ آلياً. افحص الصفحة بنفسك.",
        weight: BAND.sourceBroken,
      });
    }
  }

  /*
   * The alarm for the judge, not the eyes.
   *
   * Counted over the whole run rather than per source, because that is the
   * shape the failure has: a key expires and every page in the round becomes
   * unjudgeable at once. Keyed by the day so a persistent outage says so once
   * each morning instead of four times a day, and so it says it again tomorrow
   * if nobody has fixed it.
   */
  const unjudged = after.filter((o) => o.flags.includes("needs_manual_review"));
  if (unjudged.length >= UNJUDGED_ALARM) {
    const day = new Date().toISOString().slice(0, 10);
    out.push({
      key: `classifier:${day}`,
      kind: "classifier_down",
      title: "🟠 التصنيف متوقّف",
      body: `قُرئت الصفحات لكن تعذّر الحكم على ${unjudged.length} منها. لن تصل تنبيهات عن فرص جديدة حتى يعود التصنيف — افحص الجهات المهمة بنفسك.`,
      weight: BAND.classifierDown,
    });
  }

  return out;
}

/**
 * Quiet hours are inclusive of the start hour and exclusive of the end, and are
 * always measured in Riyadh, never in the clock of whatever machine is running.
 *
 * This ran on the process clock first, which meant two different answers for
 * the same moment: the scheduled task on the owner's machine kept Saudi time,
 * while the GitHub runner keeps UTC and shifted the quiet window three hours
 * back — silencing eleven in the morning and pushing at two. The user is in one
 * place, so there is only one right answer, and it does not depend on where the
 * code happens to run.
 */
export const QUIET_HOURS_ZONE = "Asia/Riyadh";

export function hourIn(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now),
  );
}

export function inQuietHours(
  now: Date,
  startHour: number,
  endHour: number,
  timeZone: string = QUIET_HOURS_ZONE,
): boolean {
  const h = hourIn(now, timeZone);
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

export interface Split {
  push: Notice[];
  digestOnly: Notice[];
}

/**
 * Everything already sent is dropped, then the cap is applied by weight.
 * What does not fit is not discarded: it goes to the daily email instead.
 */
/**
 * The kinds that are allowed to wake him.
 *
 * Quiet hours exist so the app does not ring at three in the morning for news
 * that will read the same at seven. A window closing inside forty-eight hours
 * is not that news. Holding it costs five hours of a deadline that has fewer
 * than forty-eight left, and once the email digest is configured it is emailed
 * instead of pushed and then marked as sent — so it is never pushed at all.
 * That is the exact failure this whole application was built to prevent, so
 * this one kind ignores the silence.
 */
const URGENT: ReadonlySet<NoticeKind> = new Set<NoticeKind>(["closing_soon"]);

export function split(
  notices: Notice[],
  log: NoticeLogEntry[],
  now: Date,
  quiet: boolean,
): Split {
  const alreadySent = new Set(log.map((e) => e.key));
  const fresh = notices.filter((n) => !alreadySent.has(n.key));
  if (quiet) {
    const urgent = fresh.filter((n) => URGENT.has(n.kind));
    return { push: urgent, digestOnly: fresh.filter((n) => !URGENT.has(n.kind)) };
  }

  const sentToday = log.filter(
    (e) => dayOf(e.sentISO) === dayOf(now.toISOString()) && (e.via ?? "push") === "push",
  ).length;
  const room = Math.max(0, DAILY_PUSH_CAP - sentToday);
  const ranked = [...fresh].sort((a, b) => b.weight - a.weight);
  return { push: ranked.slice(0, room), digestOnly: ranked.slice(room) };
}
