/**
 * Find organisations that are probably the same body, and propose nothing more.
 *
 * A wrong merge loses a real organisation, and losing one is exactly the
 * failure this whole project exists to prevent — so this prints a list and
 * stops. The decision is a person's. It is a report, deliberately, and there is
 * no flag that makes it write.
 *
 * Three signals, because any one alone is wrong often enough to matter: a
 * shared domain (a centre inside a ministry), a shared application address, and
 * a nearly-identical Arabic name once the honorifics are stripped.
 *
 *   npm run merges
 */
import { readFileSync } from "node:fs";
import type { Organisation } from "../src/types";

const orgs = JSON.parse(
  readFileSync("data/organisations.json", "utf8").replace(/^﻿/, ""),
) as Organisation[];

/** The registered domain, so `careers.x.gov.sa` and `x.gov.sa` are one host. */
function registered(url: string): string | null {
  try {
    return new URL(url).hostname.split(".").slice(-3).join(".").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Arabic names compared without the parts that vary by house style: the
 * definite article, tatweel, diacritics, and the interchangeable alif and ya
 * forms that the same body's own pages spell both ways.
 */
function normalise(name: string): string {
  return name
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\bال/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cheap edit distance, enough to tell a spelling variant from a different body. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        corner + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      corner = here;
    }
  }
  return prev[b.length]!;
}

interface Pair {
  a: Organisation;
  b: Organisation;
  reasons: string[];
}

const pairs: Pair[] = [];

for (let i = 0; i < orgs.length; i++) {
  for (let j = i + 1; j < orgs.length; j++) {
    const a = orgs[i]!;
    const b = orgs[j]!;
    const reasons: string[] = [];

    const domainsA = new Set(
      a.sources.map((s) => registered(s.url)).filter((d): d is string => d !== null),
    );
    const domainsB = new Set(
      b.sources.map((s) => registered(s.url)).filter((d): d is string => d !== null),
    );
    const shared = [...domainsA].filter((d) => domainsB.has(d));
    if (shared.length > 0) reasons.push(`نطاق مشترك: ${shared.join(", ")}`);

    const sharedUrls = new Set(a.sources.map((s) => s.url)).size;
    const overlap = b.sources.filter((s) => a.sources.some((x) => x.url === s.url)).length;
    if (overlap >= 2) reasons.push(`${overlap} رابطاً متطابقاً حرفياً من ${sharedUrls}`);

    const mailA = a.applyVia?.target?.split("@")[1]?.toLowerCase();
    const mailB = b.applyVia?.target?.split("@")[1]?.toLowerCase();
    if (mailA && mailA === mailB) reasons.push(`عنوان التقديم على النطاق نفسه: @${mailA}`);

    const nameGap = distance(normalise(a.nameAr), normalise(b.nameAr));
    if (nameGap <= 2) reasons.push(`الاسم العربي شبه متطابق (فرق ${nameGap} حرفاً)`);

    // One weak signal is a coincidence; two is worth a person's attention.
    if (reasons.length >= 2 || overlap >= 3) pairs.push({ a, b, reasons });
  }
}

if (pairs.length === 0) {
  console.log("no duplicate organisations proposed.");
} else {
  console.log(`${pairs.length} pair(s) worth a human decision. Nothing has been changed.\n`);
  for (const { a, b, reasons } of pairs) {
    const keep = a.sources.length >= b.sources.length ? a : b;
    const drop = keep === a ? b : a;
    console.log(`  ${a.id} (${a.tier}) — ${a.nameAr}`);
    console.log(`  ${b.id} (${b.tier}) — ${b.nameAr}`);
    for (const r of reasons) console.log(`      · ${r}`);
    console.log(
      `      يقترَح الإبقاء على "${keep.id}" (${keep.sources.length} مصدراً) ودمج "${drop.id}" (${drop.sources.length}) فيه.`,
    );
    console.log("");
  }
  console.log(
    "This script never merges. A wrong merge deletes a real organisation, and that is the\n" +
      "one mistake this project is built to avoid — so the decision stays with a person.",
  );
}
