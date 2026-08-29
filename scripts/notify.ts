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
import { decide, inQuietHours, split, type Notice, type NoticeLogEntry } from "../src/pipeline/notify";
import type { Opportunity, Organisation, SourceHealth } from "../src/types";

const DRY = process.argv.includes("--dry-run");
const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

/** The same file as it stood at the last commit. Empty on the first ever run. */
function fromGit<T>(path: string): T[] {
  try {
    return JSON.parse(execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" })) as T[];
  } catch {
    return [];
  }
}

const orgs = read<Organisation>("data/organisations.json");
const after = read<Opportunity>("data/opportunities.json");
const healthAfter = read<SourceHealth>("data/health.json");
const before = fromGit<Opportunity>("data/opportunities.json");
const healthBefore = fromGit<SourceHealth>("data/health.json");

const names = new Map(orgs.map((o) => [o.id, o.nameAr]));
const now = new Date();

const notices = decide({
  before,
  after,
  healthBefore,
  healthAfter,
  nameOf: (id) => names.get(id) ?? id,
  threshold: Number(process.env.RASID_THRESHOLD ?? 60),
});

const quietStart = Number(process.env.RASID_QUIET_START ?? 23);
const quietEnd = Number(process.env.RASID_QUIET_END ?? 7);
const quiet = inQuietHours(now, quietStart, quietEnd);

const log = read<NoticeLogEntry>("data/notifications.json");
const { push, digestOnly } = split(notices, log, now, quiet);

console.log(`notices: ${notices.length} new, ${push.length} to push, ${digestOnly.length} to digest`);
if (quiet) console.log(`quiet hours ${quietStart}:00-${quietEnd}:00, nothing is pushed now`);
for (const n of [...push, ...digestOnly]) console.log(`  ${n.kind.padEnd(14)} ${n.title} — ${n.body}`);

/* ---------- web push ---------- */

const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const subscriptionRaw = process.env.RASID_PUSH_SUBSCRIPTION;
const contact = process.env.RASID_CONTACT;

async function sendPush(items: Notice[]): Promise<number> {
  if (items.length === 0) return 0;
  if (!vapidPublic || !vapidPrivate || !subscriptionRaw) {
    console.log("push: skipped, VAPID keys or the device subscription are not set");
    return 0;
  }
  webpush.setVapidDetails(contact ? `mailto:${contact}` : "https://github.com/", vapidPublic, vapidPrivate);
  const subscription = JSON.parse(subscriptionRaw) as webpush.PushSubscription;

  let sent = 0;
  for (const n of items) {
    try {
      if (!DRY) {
        await webpush.sendNotification(subscription, JSON.stringify({ title: n.title, body: n.body }));
      }
      sent++;
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

const pushed = await sendPush(push);
const digested = await sendDigest(digestOnly);
console.log(`sent: ${pushed} push, ${digested ? "1" : "0"} digest${DRY ? " (dry run)" : ""}`);

/* Only what actually went out is logged, so a failed send is retried next run. */
if (!DRY) {
  const sentKeys = [
    ...push.slice(0, pushed).map((n) => n.key),
    ...(digested ? digestOnly.map((n) => n.key) : []),
  ];
  const merged = [...log, ...sentKeys.map((key) => ({ key, sentISO: now.toISOString() }))]
    // Keep a month. Long enough that nothing repeats, short enough to stay small.
    .filter((e) => Date.now() - Date.parse(e.sentISO) < 31 * 86_400_000);
  writeFileSync("data/notifications.json", JSON.stringify(merged, null, 2) + "\n", "utf8");
}
