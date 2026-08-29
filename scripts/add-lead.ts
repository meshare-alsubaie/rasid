/**
 * Add a candidate url to an organisation, found by hand or by search.
 *
 * It enters as `reported` with no verification date, exactly like anything
 * else that has not been opened. `npm run verify-leads` then decides whether
 * it is real, and only that decision may set a verification date. Nothing here
 * can promote a link, which is the point: the person adding it is often the
 * person most convinced it is right.
 *
 *   npm run add-lead -- ejada https://careers.ejada.com/ar/ "found by search"
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Organisation, SourceType } from "../src/types";

const [id, url, why] = process.argv.slice(2);
if (!id || !url) {
  console.error('usage: npm run add-lead -- <orgId> <url> ["why"]');
  process.exit(1);
}

const FILE = "data/organisations.json";
const orgs = JSON.parse(readFileSync(FILE, "utf8").replace(/^﻿/, "")) as Organisation[];
const org = orgs.find((o) => o.id === id);
if (!org) {
  console.error(`no organisation with id "${id}"`);
  process.exit(1);
}
if (org.sources.some((s) => s.url === url)) {
  console.log(`${id}: already listed`);
  process.exit(0);
}

org.sources.push({
  url,
  provenance: "reported",
  verifiedAtISO: null,
  verifiedNote: why ?? "مرشّح من بحث، لم يُفتح بعد.",
  type: /career|job|coop|training|recruit/i.test(url) ? "careers_page" : "site_root",
  checkFrequencyHours: 12,
  renderMode: "static",
});

writeFileSync(FILE, JSON.stringify(orgs, null, 2) + "\n", "utf8");
console.log(`${id}: candidate added, unverified`);
