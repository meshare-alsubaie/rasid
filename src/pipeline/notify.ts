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
import { endOfDeadline } from "../types";
import type { Opportunity, SourceHealth } from "../types";

export type NoticeKind =
  | "new_relevant"
  | "opened"
  | "closing_soon"
  | "few_seats"
  | "source_broken";

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

const dayOf = (iso: string): string => iso.slice(0, 10);
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

    if (was === undefined && score >= Math.max(60, threshold)) {
      out.push({
        key: `new:${o.id}`,
        kind: "new_relevant",
        title: `🟢 إعلان جديد — ${org}`,
        body: `${o.titleAr} · درجة الصلة ${score}`,
        weight: score,
      });
    }

    if (was !== undefined && was.status !== "open" && o.status === "open") {
      out.push({
        key: `opened:${o.id}`,
        kind: "opened",
        title: `🟢 فتح التقديم — ${org}`,
        body: o.closesISO
          ? `${o.titleAr} · يغلق بعد ${Math.max(0, Math.ceil(hoursUntil(o.closesISO) / 24))} يوم`
          : o.titleAr,
        weight: score + 100,
      });
    }

    if (o.closesISO !== null && hoursUntil(o.closesISO) <= 48 && hoursUntil(o.closesISO) > 0) {
      out.push({
        key: `closing:${o.id}:${dayOf(o.closesISO)}`,
        kind: "closing_soon",
        title: `⏳ يغلق قريباً — ${org}`,
        body: `${o.titleAr} · تبقّى ${Math.ceil(hoursUntil(o.closesISO))} ساعة`,
        weight: score + 200,
      });
    }

    if (o.seats !== null && o.seats <= 5 && score >= 70 && was?.seats !== o.seats) {
      out.push({
        key: `seats:${o.id}:${o.seats}`,
        kind: "few_seats",
        title: `⚠ مقاعد قليلة — ${org}`,
        body: `${o.titleAr} · ${o.seats} مقاعد`,
        weight: score + 50,
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
        weight: 150,
      });
    }
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
export function split(
  notices: Notice[],
  log: NoticeLogEntry[],
  now: Date,
  quiet: boolean,
): Split {
  const alreadySent = new Set(log.map((e) => e.key));
  const fresh = notices.filter((n) => !alreadySent.has(n.key));
  if (quiet) return { push: [], digestOnly: fresh };

  const sentToday = log.filter(
    (e) => dayOf(e.sentISO) === dayOf(now.toISOString()) && (e.via ?? "push") === "push",
  ).length;
  const room = Math.max(0, DAILY_PUSH_CAP - sentToday);
  const ranked = [...fresh].sort((a, b) => b.weight - a.weight);
  return { push: ranked.slice(0, room), digestOnly: ranked.slice(room) };
}
