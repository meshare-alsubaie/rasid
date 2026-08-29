/**
 * Refuse to publish a person.
 *
 * This repository is public and is meant to be shown to recruiters. It is
 * about organisations; exactly one thing in it is about its owner, and that
 * belongs in `.profile.local` and a repository secret, never in a commit.
 *
 * Git remembers. A personal detail pushed once is public even after it is
 * deleted, so this runs before the push and not after: it scans every tracked
 * file and exits non-zero on a match.
 *
 *   npm run audit:privacy
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Rule {
  name: string;
  pattern: RegExp;
  why: string;
  /** Files where a match is expected and harmless. */
  allow?: RegExp;
}

const RULES: Rule[] = [
  {
    name: "personal email",
    // Anything that is not an organisation's published contact address. Those
    // are business addresses that belong in the dataset; a personal mailbox
    // does not.
    pattern: /\b[\w.+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|proton(?:mail)?)\.[a-z.]+/gi,
    why: "a personal mailbox in a public repository is scraped within days",
  },
  {
    name: "grade point average",
    pattern: /\bGPA\s*[:\s]*\d|معدل\s+المستخدم|معدل\s+الطالب\s*\d/g,
    why: "the owner's grades are not part of a tool about organisations",
    // Organisations publish their own minimum GPA, which is a fact about them.
    allow: /^data\/(organisations|opportunities)\.json$/,
  },
  {
    name: "personal credentials",
    pattern: /First Class Honours|Security\+\s*certified|Zero-Trust SOC/g,
    why: "identifies the owner; belongs in the profile secret",
  },
  {
    name: "personal circumstances",
    pattern: /سكن مجاني|free accommodation|evening lecture courses/g,
    why: "describes the owner's life, not an organisation",
    allow: /^\.profile\.example$/,
  },
];

/*
 * This file is skipped, because a scanner necessarily contains the strings it
 * scans for. Skipping it is the only honest option: weakening the patterns so
 * they do not match here would weaken them everywhere else too.
 */
const SELF = "scripts/audit-privacy.ts";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && f !== SELF);

let hits = 0;
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary, such as the icons
  }
  for (const rule of RULES) {
    if (rule.allow?.test(file)) continue;
    const found = text.match(rule.pattern);
    if (!found) continue;
    hits += found.length;
    const line = text.slice(0, text.indexOf(found[0]!)).split("\n").length;
    console.log(`  ${file}:${line}  ${rule.name}`);
    console.log(`      ${JSON.stringify(found.slice(0, 3))}`);
    console.log(`      ${rule.why}`);
  }
}

console.log(
  hits === 0
    ? `privacy: ${files.length} tracked files, nothing personal found`
    : `\nprivacy: ${hits} match(es). Do not push until these are gone from the working tree AND from history.`,
);
process.exit(hits === 0 ? 0 : 1);
