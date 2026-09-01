/**
 * Send what the collection run made newly true.
 *
 * The "before" state comes from git, which is the point of committing the
 * dataset: the previous commit is the previous run, with no extra bookkeeping
 * and a full history behind it.
 *
 * Every channel is optional and every skip is printed. A missing key means
 * "this channel is off", never a silent no-op that looks like "there was
 * nothing to say".
 *
 *   npm run notify              send
 *   npm run notify -- --dry-run decide and print, send nothing
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";
import {
  decide,
  inQuietHours,
  split,
  LOG_RETENTION_DAYS,
  type Notice,
  type NoticeLogEntry,
} from "../src/pipeline/notify";
import type { Opportunity, Organisation, SourceHealth } from "../src/types";

const DRY = process.argv.includes("--dry-run");
/** Prove the whole chain works, without waiting for a real announcement. */
const TEST = process.argv.includes("--test");
const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

/**
 * The file as it stood before this run's data landed. Empty on the first run.
 *
 * Which commit that is depends on how the run was started, and getting it wrong
 * silenced the app completely. When the collection happened here, the new data
 * is still uncommitted, so `HEAD` is the previous state and is right. But the
 * machine that can actually reach the .gov.sa sites collects locally, commits,
 * and pushes — and the CI run that answers that push has the new data *in*
 * `HEAD`. Comparing `HEAD` to the working tree then compares a commit with
 * itself: every record looks unchanged, `decide` finds nothing newly true, and
 * not one notification is ever sent by the only collector that works.
 *
 * So the workflow passes the pre-push SHA in RASID_BEFORE_REF for that case.
 */
const BEFORE_REFS = [process.env.RASID_BEFORE_REF?.trim(), "HEAD~1", "HEAD"].filter(
  (r): r is string => Boolean(r),
);

function fromGit<T>(path: string): T[] {
  for (const ref of BEFORE_REFS) {
    try {
      return JSON.parse(
        execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" }),
      ) as T[];
    } catch {
      // A shallow clone may not hold the exact pre-push commit; the next ref is
      // still a truthful "before", and the sent-log below stops any repeat.
    }
  }
  return [];
}

const orgs = read<Organisation>("data/organisations.json");
const after = read<Opportunity>("data/opportunities.json");
const healthAfter = read<SourceHealth>("data/health.json");
const before = fromGit<Opportunity>("data/opportunities.json");
const healthBefore = fromGit<SourceHealth>("data/health.json");

const names = new Map(orgs.map((o) => [o.id, o.nameAr]));
const now = new Date();

const fresh = decide({
  before,
  after,
  healthBefore,
  healthAfter,
  nameOf: (id) => names.get(id) ?? id,
  threshold: Number(process.env.RASID_THRESHOLD ?? 60),
});

/*
 * Anything decided but not yet sent, carried over from earlier runs.
 *
 * This queue exists because of a bug that would have cost a real deadline.
 * `decide` compares this run against the previous commit, so a notice is only
 * ever produced once, on the run where the thing became true. During quiet
 * hours nothing is pushed — and by the next run the announcement was no longer
 * new, so the notice was never regenerated and simply vanished. An announcement
 * that opened at one in the morning would have been silently swallowed.
 *
 * So an undelivered notice is now kept until it is actually delivered. Sent
 * keys still guard against repeats, and the day-scoped keys mean a stale entry
 * eventually stops matching anything rather than nagging forever.
 */
const PENDING_FILE = "data/pending-notices.json";
/** A notice nobody could deliver for a week is stale news, not a pending one. */
const PENDING_TTL_MS = 7 * 86_400_000;
type Held = Notice & { queuedISO: string };

const carried = read<Held>(PENDING_FILE).filter(
  (n) => now.getTime() - Date.parse(n.queuedISO) < PENDING_TTL_MS,
);
const seen = new Set<string>();
const notices: Held[] = [...carried, ...fresh.map((n) => ({ ...n, queuedISO: now.toISOString() }))]
  .filter((n) => !seen.has(n.key) && seen.add(n.key));

const quietStart = Number(process.env.RASID_QUIET_START ?? 23);
const quietEnd = Number(process.env.RASID_QUIET_END ?? 7);
const quiet = inQuietHours(now, quietStart, quietEnd);

const log = read<NoticeLogEntry>("data/notifications.json");
const { push, digestOnly } =
  TEST
    ? {
        push: [
          {
            key: `test:${now.toISOString()}`,
            kind: "new_relevant" as const,
            title: "🟢 راصد يعمل",
            body: "هذه تجربة. حين تُفتح نافذة حقيقية سيصلك تنبيه بهذا الشكل.",
            weight: 1,
          },
        ],
        digestOnly: [],
      }
    : split(notices, log, now, quiet);

console.log(
  `notices: ${fresh.length} new, ${carried.length} carried over, ${push.length} to push, ${digestOnly.length} to digest`,
);
if (quiet) {
  console.log(
    `quiet hours ${quietStart}:00-${quietEnd}:00 Riyadh, nothing is pushed now; it is held, not dropped`,
  );
}
for (const n of [...push, ...digestOnly]) console.log(`  ${n.kind.padEnd(14)} ${n.title} — ${n.body}`);

/* ---------- web push ---------- */

const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const subscriptionRaw = process.env.RASID_PUSH_SUBSCRIPTION;
const contact = process.env.RASID_CONTACT;

/**
 * Returns the keys that actually went out, not how many.
 *
 * Counting was wrong in a way that lost mail in both directions: the caller
 * logged `push.slice(0, sent)`, so when the second of three sends failed, the
 * first two positions were logged — marking the failed one as delivered, never
 * to be retried — while the third, which did go out, was left unlogged and sent
 * again next run. Only the keys that succeeded are truthful.
 */
async function sendPush(items: Notice[]): Promise<string[]> {
  if (items.length === 0) return [];
  if (!vapidPublic || !vapidPrivate || !subscriptionRaw) {
    console.log("push: skipped, VAPID keys or the device subscription are not set");
    return [];
  }
  webpush.setVapidDetails(contact ? `mailto:${contact}` : "https://github.com/", vapidPublic, vapidPrivate);
  const subscription = JSON.parse(subscriptionRaw) as webpush.PushSubscription;

  const sent: string[] = [];
  for (const n of items) {
    try {
      if (!DRY) {
        /*
         * A tag per notice, not one for all of them.
         *
         * The service worker falls back to the constant tag "rasid", and a tag
         * is what the operating system uses to decide that a new notification
         * *replaces* an older one. Two alerts sent in the same second therefore
         * left one banner. On 30 August two went out together, and the one that
         * survived was the bank at relevance 65 — the cybersecurity programme
         * at 95 was the one it overwrote. The daily cap of six means nothing if
         * only the last of them is visible.
         */
        await webpush.sendNotification(
          subscription,
          JSON.stringify({ title: n.title, body: n.body, tag: n.key }),
        );
      }
      sent.push(n.key);
    } catch (err) {
      // A dead subscription is worth saying out loud: it means his phone has
      // stopped receiving and he would otherwise never find out.
      console.log(`push failed for ${n.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sent;
}

/* ---------- email digest ---------- */

async function sendDigest(items: Notice[]): Promise<boolean> {
  if (items.length === 0) return false;
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) {
    console.log("digest: skipped, RESEND_API_KEY or NOTIFY_EMAIL is not set");
    return false;
  }
  const body = items.map((n) => `<p><strong>${n.title}</strong><br>${n.body}</p>`).join("");
  if (DRY) return true;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "RASID <onboarding@resend.dev>",
      to: [to],
      subject: `راصد — ${items.length} تحديث`,
      html: `<div dir="rtl" lang="ar">${body}</div>`,
    }),
  });
  if (!res.ok) {
    console.log(`digest failed: HTTP ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

const pushedKeys = await sendPush(push);
const digested = await sendDigest(digestOnly);
console.log(
  `sent: ${pushedKeys.length} push, ${digested ? "1" : "0"} digest${DRY ? " (dry run)" : ""}`,
);

/* Only what actually went out is logged, so a failed send is retried next run. */
if (!DRY && !TEST) {
  const sentKeys = new Set([
    ...pushedKeys,
    ...(digested ? digestOnly.map((n) => n.key) : []),
  ]);
  /*
   * `via` separates the two channels in the log, because the daily cap in
   * `split` counts entries for today and the cap is six *pushes*. Before this,
   * a quiet night that emailed nine items filled the day's budget and demoted
   * every real push the next morning to the digest.
   */
  const pushedSet = new Set(pushedKeys);
  const merged = [
    ...log,
    ...[...sentKeys].map((key) => ({
      key,
      sentISO: now.toISOString(),
      via: pushedSet.has(key) ? ("push" as const) : ("digest" as const),
    })),
  ]
    // Kept strictly longer than ANNOUNCE_WINDOW_DAYS, so a notice can never be
    // proposed again after the entry proving it was sent has been pruned.
    .filter((e) => Date.now() - Date.parse(e.sentISO) < LOG_RETENTION_DAYS * 86_400_000);
  writeFileSync("data/notifications.json", JSON.stringify(merged, null, 2) + "\n", "utf8");

  // Whatever did not go out waits for the next run rather than evaporating.
  const stillWaiting = notices.filter((n) => !sentKeys.has(n.key));
  writeFileSync(PENDING_FILE, JSON.stringify(stillWaiting, null, 2) + "\n", "utf8");
  if (stillWaiting.length > 0) {
    console.log(`held for the next run: ${stillWaiting.length}`);
  }
}
