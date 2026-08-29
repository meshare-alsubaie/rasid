/**
 * RASID data spine validator.
 *
 * Two layers:
 *   1. Schema  - shape and enums, from `schemas/*.json`.
 *   2. Honesty - the rules a schema cannot express: a value must never exist
 *                without a provenance, a published rule must carry its exact
 *                wording, a graduate-development record must never surface as
 *                open, health state must match the failure count.
 *
 * Errors fail the build. Warnings are coverage debt: fields we have not
 * verified yet. They are printed loudly on purpose - an unverified link is a
 * known gap, not a silent one.
 *
 * Usage: npm run validate  [--verbose]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { MAX_BROWSER_SOURCES, SILENT_THIN_RUNS, THIN_CHARS } from "../src/types";
import type {
  AggregatorSource,
  LinkProvenance,
  Opportunity,
  Organisation,
  SourceHealth,
  SourceSnapshot,
  VerificationAttempt,
} from "../src/types";

/* ajv and ajv-formats ship both CJS and ESM builds; normalise the default. */
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule;
const addFormats = ((addFormatsModule as unknown as { default?: unknown })
  .default ?? addFormatsModule) as typeof addFormatsModule;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Issue {
  severity: "error" | "warning";
  check: string;
  where: string;
  message: string;
}
const issues: Issue[] = [];
const err = (check: string, where: string, message: string): void => {
  issues.push({ severity: "error", check, where, message });
};
const warn = (check: string, where: string, message: string): void => {
  issues.push({ severity: "warning", check, where, message });
};

function readJson(relPath: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(root, relPath), "utf8");
  } catch {
    err("file_missing", relPath, "file not found");
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    err("invalid_json", relPath, (e as Error).message);
    return undefined;
  }
}

const ajv = new Ajv({ allErrors: true, strict: "log" });
addFormats(ajv);

/** Validates one data file against one schema. Returns the data only if it passed. */
function checkSchema<T>(dataPath: string, schemaPath: string): T[] | undefined {
  const data = readJson(dataPath);
  const schema = readJson(schemaPath);
  if (data === undefined || schema === undefined) return undefined;

  const validate = ajv.compile(schema as object);
  if (validate(data)) return data as T[];

  for (const e of validate.errors ?? []) {
    err("schema", `${dataPath}${e.instancePath}`, `${e.message ?? "invalid"}`);
  }
  return undefined;
}

const orgs = checkSchema<Organisation>(
  "data/organisations.json",
  "schemas/organisation.schema.json",
);
const aggregators = checkSchema<AggregatorSource>(
  "data/aggregators.json",
  "schemas/aggregator.schema.json",
);
const opportunities = checkSchema<Opportunity>(
  "data/opportunities.json",
  "schemas/opportunity.schema.json",
);
const health = checkSchema<SourceHealth>(
  "data/health.json",
  "schemas/health.schema.json",
);
const snapshots = checkSchema<SourceSnapshot>(
  "data/snapshots.json",
  "schemas/snapshot.schema.json",
);
const attempts = checkSchema<VerificationAttempt>(
  "data/verification.json",
  "schemas/verification.schema.json",
);

/**
 * The rules that make a stored link trustworthy.
 *
 * `mustBeVerified` marks a link the user is handed directly. An unopened lead
 * there is an error, not a warning: it is the exact failure mode this project
 * exists to avoid.
 */
interface LinkLike {
  provenance: LinkProvenance;
  verifiedAtISO: string | null;
  verifiedNote?: string;
}
function checkLink(
  at: string,
  label: string,
  link: LinkLike,
  opts: { mustBeVerified?: boolean; requireNote?: boolean } = {},
): void {
  if (link.provenance === "email_channel") {
    // An address is not a page. There is nothing to open, now or ever.
    if (link.verifiedAtISO !== null) {
      err("link_provenance", at, `${label} is an email channel and can never carry a verification date`);
    }
    return;
  }
  if (link.provenance === "official" && link.verifiedAtISO === null) {
    err("link_provenance", at, `${label} claims official provenance but was never opened`);
  }
  if (link.provenance === "reported" && link.verifiedAtISO !== null) {
    err("link_provenance", at, `${label} carries a verification date but is still marked reported`);
  }
  if (link.verifiedAtISO !== null) {
    if (opts.requireNote !== false && !link.verifiedNote) {
      err("link_note", at, `${label} was verified but nothing records what was seen`);
    }
    if (Date.parse(link.verifiedAtISO) > Date.now()) {
      err("link_future", at, `${label} carries a verification date in the future`);
    }
  } else if (opts.mustBeVerified) {
    err("unopened_link", at, `${label} was never opened and must not be handed to the user`);
  }
}

/* ------------------------------------------------------------------ */
/* Honesty checks                                                      */
/* ------------------------------------------------------------------ */

const orgIds = new Set<string>();

if (orgs) {
  for (const o of orgs) {
    const at = `org:${o.id}`;
    if (orgIds.has(o.id)) err("duplicate_id", at, "id appears more than once");
    orgIds.add(o.id);

    const z = o.requiresZeroCourses;
    if (z.value === true && !z.quote) {
      err(
        "rule_without_quote",
        at,
        "requiresZeroCourses is true but the exact published wording is missing",
      );
    }
    if (z.value === null && z.provenance !== "unknown") {
      err(
        "provenance_mismatch",
        at,
        `requiresZeroCourses has no value but provenance is "${z.provenance}"`,
      );
    }
    if (z.value !== null && z.provenance === "unknown") {
      err(
        "provenance_mismatch",
        at,
        "requiresZeroCourses has a value with unknown provenance, which makes it a guess",
      );
    }
    if (z.provenance === "official" && !z.sourceUrl) {
      warn(
        "official_without_source",
        at,
        "requiresZeroCourses is marked official but no sourceUrl backs it",
      );
    }

    const s = o.stipend;
    if (s.amountSAR !== null && s.provenance === "unknown") {
      err("provenance_mismatch", at, "stipend amount present with unknown provenance");
    }
    if (s.amountSAR === null && s.provenance !== "unknown") {
      err(
        "provenance_mismatch",
        at,
        `stipend amount is null but provenance is "${s.provenance}"`,
      );
    }

    o.historicalWindows.forEach((w, i) => {
      const wat = `${at}.historicalWindows[${i}]`;
      if ((w.openedISO !== null || w.closedISO !== null) && w.provenance === "unknown") {
        err("provenance_mismatch", wat, "window carries dates with unknown provenance");
      }
      if (w.openedISO && w.closedISO && w.closedISO < w.openedISO) {
        err("window_order", wat, "window closes before it opens");
      }
    });

    const urls = o.sources.map((x) => x.url);
    if (new Set(urls).size !== urls.length) {
      err("duplicate_source", at, "the same source url is listed twice");
    }
    o.sources.forEach((s, i) => {
      checkLink(at, `sources[${i}]`, s);
      if (s.verifiedAtISO === null) {
        warn("unopened_source", at, `sources[${i}] is an unopened lead, the pipeline will skip it`);
      }
    });

    const via = o.applyVia;
    if (via === null) {
      warn("no_apply_channel", at, "no application channel yet");
    } else {
      checkLink(at, "applyVia", via, { requireNote: false });
      if (via.method === "email") {
        if (!EMAIL.test(via.target)) {
          err("apply_target", at, `method is email but target "${via.target}" is not an address`);
        }
        if (via.provenance !== "email_channel") {
          err("apply_provenance", at, `an email channel must carry provenance "email_channel", not "${via.provenance}"`);
        }
      } else {
        if (!/^https?:\/\//.test(via.target)) {
          err("apply_target", at, `method is ${via.method} but target "${via.target}" is not an http url`);
        }
        if (via.provenance === "email_channel") {
          err("apply_provenance", at, `method is ${via.method} but provenance says email_channel`);
        }
        // An address can never be "opened", so only web channels can be stale.
        if (via.verifiedAtISO === null) {
          warn("unopened_apply_channel", at, "application channel is an unconfirmed lead");
        }
      }
    }

    if (o.manualCheckUrl === null) {
      warn("no_manual_check_url", at, "no verified link for the user to check manually");
    } else {
      checkLink(at, "manualCheckUrl", o.manualCheckUrl, { mustBeVerified: true });
    }
    if (o.sources.length === 0) {
      warn("no_sources", at, "no source at all, the pipeline cannot watch this one");
    }
  }
}

if (aggregators) {
  const ids = new Set<string>();
  for (const a of aggregators) {
    const at = `aggregator:${a.id}`;
    if (ids.has(a.id)) err("duplicate_id", at, "id appears more than once");
    ids.add(a.id);
    if (a.link === null) {
      warn("no_aggregator_url", at, "no url at all yet");
    } else {
      checkLink(at, "link", a.link);
      if (a.link.verifiedAtISO === null) {
        warn("unopened_aggregator_url", at, "url is an unopened lead");
      }
    }
    if (a.applyVia !== null) {
      checkLink(at, "applyVia", a.applyVia, { requireNote: false });
      if (a.applyVia.method === "email" && !EMAIL.test(a.applyVia.target)) {
        err("apply_target", at, `method is email but target "${a.applyVia.target}" is not an address`);
      }
    }
  }
}

if (orgs) {
  // The browser path is an exception the dataset has to keep earning.
  const rendered = orgs.flatMap((o) =>
    o.sources.filter((s) => s.renderMode === "browser").map((s) => ({ org: o.id, source: s })),
  );
  if (rendered.length > MAX_BROWSER_SOURCES) {
    err(
      "browser_cap",
      "sources",
      `${rendered.length} sources are set to render, and the cap is ${MAX_BROWSER_SOURCES}`,
    );
  }
  for (const { org, source } of rendered) {
    if (source.verifiedAtISO === null) {
      err(
        "unverified_render",
        `org:${org}`,
        `${source.url} asks for the browser but was never opened; rendering is granted after a check, not before`,
      );
    }
  }
}

if (snapshots) {
  // Every verified source url in the dataset, so a snapshot cannot point at a
  // page the pipeline was never allowed to fetch.
  const watchable = new Set(
    (orgs ?? []).flatMap((o) =>
      o.sources.filter((s) => s.verifiedAtISO !== null).map((s) => s.url),
    ),
  );
  const aggregatorIds = new Set((aggregators ?? []).map((a) => a.id));
  for (const s of snapshots) {
    const at = `snapshot:${s.orgId}`;
    if (orgs && !orgIds.has(s.orgId) && !aggregatorIds.has(s.orgId)) {
      err("unknown_org", at, `orgId "${s.orgId}" is in neither organisations nor aggregators`);
    }
    if (orgs && orgIds.has(s.orgId) && !watchable.has(s.sourceUrl)) {
      err("unwatchable_snapshot", at, `${s.sourceUrl} is not a verified source of this org`);
    }
    if (s.contentHash !== null && s.extractedChars === null) {
      err("snapshot_shape", at, "a hash exists but the extracted length is null");
    }
    if (s.lastChangedISO !== null && Date.parse(s.lastChangedISO) > Date.now()) {
      err("snapshot_future", at, "lastChangedISO is in the future");
    }
    if (s.extractedChars !== null && s.extractedChars < THIN_CHARS) {
      // Both stay warnings. A training page with nothing on it is the normal
      // state outside an application window, and failing the build on an
      // external site's silence teaches people to ignore the build.
      if (s.thinRuns >= SILENT_THIN_RUNS) {
        warn(
          "silent_thin_source",
          at,
          `only ${s.extractedChars} chars and unchanged for ${s.thinRuns} runs; check by hand that this is the real page`,
        );
      } else {
        warn(
          "thin_extract",
          at,
          `only ${s.extractedChars} chars extracted, the page may be javascript-rendered`,
        );
      }
    }
  }
}

if (attempts) {
  for (const a of attempts) {
    const at = `verification:${a.targetId}`;
    if (a.outcome !== "not_found" && a.urlTried === null) {
      err("attempt_shape", at, `outcome "${a.outcome}" requires the url that was opened`);
    }
    if (a.outcome === "not_found" && a.urlTried !== null) {
      err("attempt_shape", at, "not_found means nothing was opened, so urlTried must be null");
    }
    if (Date.parse(a.checkedAtISO) > Date.now()) {
      err("attempt_future", at, "attempt is dated in the future");
    }
  }
}

if (opportunities) {
  for (const p of opportunities) {
    const at = `opportunity:${p.id}`;
    if (orgs && !orgIds.has(p.orgId)) {
      err("unknown_org", at, `orgId "${p.orgId}" is not in organisations.json`);
    }
    if (p.product === "graduate_dev") {
      if (p.status === "open" || p.status === "closing_soon") {
        err("wrong_product_open", at, "a graduate-development record must never surface as open");
      }
      if (p.relevanceScore !== 0 && p.relevanceScore !== null) {
        err("wrong_product_score", at, "graduate_dev must score 0, the user cannot apply");
      }
      if (!p.flags.includes("wrong_product")) {
        err("missing_flag", at, "graduate_dev must carry the wrong_product flag");
      }
    }
    if (p.seats !== null && p.seats <= 5 && !p.flags.includes("few_seats")) {
      err("missing_flag", at, "seats <= 5 but the few_seats flag is missing");
    }
    if (p.relevanceScore === null && !p.flags.includes("needs_manual_review")) {
      err("missing_flag", at, "an unscored record must carry needs_manual_review, never be dropped");
    }
    if (p.opensISO && p.closesISO && p.closesISO < p.opensISO) {
      err("window_order", at, "window closes before it opens");
    }
  }
}

if (health) {
  for (const h of health) {
    const at = `health:${h.orgId}`;
    if (orgs && !orgIds.has(h.orgId)) {
      err("unknown_org", at, `orgId "${h.orgId}" is not in organisations.json`);
    }
    // Tightened from the spec's ">1": one failure is already worth showing.
    const expected =
      h.consecutiveFailures > 5 ? "broken" : h.consecutiveFailures >= 1 ? "degraded" : "healthy";
    if (h.state !== expected) {
      err(
        "health_state",
        at,
        `${h.consecutiveFailures} consecutive failures implies "${expected}" but state is "${h.state}"`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const line = (s = ""): void => console.log(s);
const count = (n: number, total: number): string =>
  `${String(n).padStart(3)}/${total}  (${String(Math.round((n / total) * 100)).padStart(3)}%)`;

line("RASID data spine validation");
line("===========================");
line();
line("files");
line(`  data/organisations.json   ${String(orgs?.length ?? "FAILED").padStart(3)} records`);
line(`  data/aggregators.json     ${String(aggregators?.length ?? "FAILED").padStart(3)} records`);
line(`  data/opportunities.json   ${String(opportunities?.length ?? "FAILED").padStart(3)} records`);
line(`  data/health.json          ${String(health?.length ?? "FAILED").padStart(3)} records`);
line(`  data/snapshots.json       ${String(snapshots?.length ?? "FAILED").padStart(3)} records`);
line(`  data/verification.json    ${String(attempts?.length ?? "FAILED").padStart(3)} records`);

if (orgs) {
  const t = orgs.length;
  const by = (f: (o: Organisation) => boolean): number => orgs.filter(f).length;
  line();
  line("tiers");
  for (const tier of ["S", "A", "B", "C"] as const) {
    const n = by((o) => o.tier === tier);
    if (n > 0) line(`  tier ${tier}                    ${String(n).padStart(3)}`);
  }
  line();
  line("origin (a verified record and a bulk import must never read alike)");
  for (const s of ["spec", "coop_pdf_2021", "manual"] as const) {
    const n = by((o) => o.importSource === s);
    if (n > 0) line(`  ${s.padEnd(24)}${String(n).padStart(3)}`);
  }
  line();
  line("verification coverage (warnings above are these gaps)");
  line(
    `  source opened and kept    ${count(by((o) => o.sources.some((s) => s.verifiedAtISO !== null)), t)}`,
  );
  line(`  source held as a lead     ${count(by((o) => o.sources.some((s) => s.verifiedAtISO === null)), t)}`);
  line(`  has manualCheckUrl        ${count(by((o) => o.manualCheckUrl !== null), t)}`);
  line(`  has an apply channel      ${count(by((o) => o.applyVia !== null), t)}`);
  line(`  zero-courses rule known   ${count(by((o) => o.requiresZeroCourses.value !== null), t)}`);
  line(`  major acceptance known    ${count(by((o) => o.acceptsUserMajor !== null), t)}`);
  line(`  offers co-op known        ${count(by((o) => o.offersCoopProduct !== null), t)}`);
  line(`  stipend known             ${count(by((o) => o.stipend.amountSAR !== null), t)}`);
  line(`  has past windows          ${count(by((o) => o.historicalWindows.length > 0), t)}`);
}

if (attempts && orgs && aggregators) {
  const outcome = (k: VerificationAttempt["outcome"]): number =>
    attempts.filter((a) => a.outcome === k).length;
  const verified = outcome("verified");
  const rejected = outcome("rejected");
  const notFound = outcome("not_found");
  const unreachable = outcome("unreachable");

  const targets = [...orgs.map((o) => o.id), ...aggregators.map((a) => a.id)];
  const attempted = new Set(attempts.map((a) => a.targetId));
  const untouched = targets.filter((id) => !attempted.has(id)).length;

  line();
  line("link verification rounds");
  line(`  links verified            ${String(verified).padStart(3)}`);
  line(
    `  links failed              ${String(rejected + notFound + unreachable).padStart(3)}   (rejected ${rejected}, not found ${notFound}, unreachable ${unreachable})`,
  );
  line(
    `  still unknown             ${String(untouched).padStart(3)}   of ${targets.length} targets never attempted`,
  );
}

/* The work queue for the next round, in the order it should be worked. */
if (orgs) {
  // Tier first, then how close the sector sits to cybersecurity and IT, so a
  // bank never outranks a security or data body inside the same tier.
  const sectorRank = ["tech", "gov", "semi_gov", "industrial", "consulting", "bank", "health", "startup"];
  const gaps = orgs
    .filter((o) => o.manualCheckUrl === null)
    .sort(
      (a, b) =>
        "SABC".indexOf(a.tier) - "SABC".indexOf(b.tier) ||
        sectorRank.indexOf(a.sector) - sectorRank.indexOf(b.sector) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 10);
  line();
  line("closest to the user's field, still with no verified link");
  for (const o of gaps) {
    const held = o.sources.length > 0 ? "lead" : o.applyVia !== null ? "email" : "nothing";
    line(`  ${o.tier}  ${o.id.padEnd(14)} ${held.padEnd(8)} ${o.nameAr}`);
  }
}

const errors = issues.filter((i) => i.severity === "error");
const warnings = issues.filter((i) => i.severity === "warning");

function group(list: Issue[], label: string): void {
  line();
  line(`${label} (${list.length})`);
  if (list.length === 0) {
    line("  none");
    return;
  }
  const byCheck = new Map<string, Issue[]>();
  for (const i of list) {
    const bucket = byCheck.get(i.check);
    if (bucket) bucket.push(i);
    else byCheck.set(i.check, [i]);
  }
  for (const [check, list2] of [...byCheck.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const first = list2[0];
    if (!first) continue;
    line(`  ${check} x${list2.length}: ${first.message}`);
    const shown = verbose ? list2 : list2.slice(0, 6);
    for (const i of shown) line(`      ${i.where}`);
    if (!verbose && list2.length > shown.length) {
      line(`      ... and ${list2.length - shown.length} more (run with --verbose)`);
    }
  }
}

group(errors, "ERRORS");
group(warnings, "WARNINGS");

line();
if (errors.length > 0) {
  line(`FAILED: ${errors.length} error(s).`);
  process.exit(1);
}
line(`PASSED: schema clean, ${warnings.length} unverified field(s) reported above.`);
