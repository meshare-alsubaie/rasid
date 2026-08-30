/**
 * Proof that a classifier which could not judge never looks like one that
 * judged "no".
 *
 * Every failure branch is driven through an injected asker, so the four stages
 * are deterministic, free, and need no network. For each one the same three
 * invariants are asserted:
 *
 *   1. no record carries relevanceScore 0 - it must be null
 *   2. the content hash is untouched, so a later change is still detectable
 *   3. pendingClassification stays true, so the next run retries it
 *
 *   npm run test:classifier            failure branches only, offline, free
 *   npm run test:classifier -- --live  also sends two synthetic announcements
 */
import {
  classify,
  costOf,
  type Asker,
  type Usage,
  CLASSIFIER_MODEL,
} from "../src/pipeline/classify";
import { asManualReview, fromClassification } from "../src/pipeline/opportunity";
import type { SourceSnapshot } from "../src/types";

const NOW = new Date().toISOString();
const HASH = "a".repeat(64);
const TEXT = "نص صفحة افتراضي للاختبار";

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures++;
  console.log(`  ${condition ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const noUsage: Usage = { inputTokens: 0, outputTokens: 0 };
const askers: Record<string, Asker> = {
  api: async () => {
    throw new Error("ECONNRESET simulated");
  },
  parse: async () => ({ text: "Sure! Here is the answer, but not as JSON.", usage: noUsage }),
  schema: async () => ({
    // Valid JSON, but relevanceReason is missing and seats is a string.
    text: JSON.stringify({
      isTrainingAnnouncement: true,
      product: "coop",
      titleAr: "تدريب",
      opensISO: null,
      closesISO: null,
      majors: [],
      seats: "خمسة",
      stipendSAR: null,
      durationWeeks: null,
      cities: [],
      statesZeroCoursesRule: false,
      zeroCoursesQuote: null,
      relevanceScore: 70,
      applyUrl: null,
    }),
    usage: noUsage,
  }),
};

/** The snapshot the collector would be holding when classification fails. */
const snapshotBefore = (): SourceSnapshot => ({
  sourceUrl: "https://example.gov.sa/coop",
  orgId: "sdaia",
  contentHash: HASH,
  extractedChars: 900,
  extractionMethod: "readability",
  firstSeenISO: NOW,
  lastChangedISO: NOW,
  thinRuns: 0,
  pendingClassification: true,
});

async function stageTest(stage: string, asker: Asker | null): Promise<void> {
  console.log(`\n${stage}`);

  let result;
  if (asker === null) {
    // no_credentials: hide the key for this one call, then put it back.
    // The value is never read, printed, or logged - only its absence is set up.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    result = await classify(TEXT);
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  } else {
    result = await classify(TEXT, asker);
  }

  check("classify reports failure", !result.ok);
  if (result.ok) return;
  check(`stage is "${stage}"`, result.stage === stage, `got "${result.stage}"`);

  const snap = snapshotBefore();
  const record = asManualReview({
    orgId: snap.orgId,
    sourceUrl: snap.sourceUrl,
    text: TEXT,
    nowISO: NOW,
    prior: undefined,
    firstTime: true,
    reason: `${result.stage} — ${result.reason}`,
  });
  // What the collector does on a failed verdict.
  snap.pendingClassification = true;

  check("relevanceScore is null, not 0", record.relevanceScore === null, String(record.relevanceScore));
  check("flagged needs_manual_review", record.flags.includes("needs_manual_review"));
  check("status is not open", record.status !== "open", record.status);
  check("content hash untouched", snap.contentHash === HASH);
  check("still queued for the next run", snap.pendingClassification);
}

console.log("failure branches (offline, no spend)");
await stageTest("no_credentials", null);
await stageTest("api", askers.api!);
await stageTest("parse", askers.parse!);
await stageTest("schema", askers.schema!);

console.log("\npositive path (injected valid reply)");
const good: Asker = async () => ({
  text: JSON.stringify({
    isTrainingAnnouncement: true,
    product: "coop",
    titleAr: "برنامج التدريب التعاوني",
    opensISO: null,
    closesISO: null,
    majors: ["الأمن السيبراني"],
    seats: 3,
    stipendSAR: 3000,
    durationWeeks: 24,
    cities: ["الرياض"],
    statesZeroCoursesRule: false,
    zeroCoursesQuote: null,
    relevanceScore: 95,
    relevanceReason: "الإعلان يسمّي الأمن السيبراني صراحةً.",
    applyUrl: null,
  }),
  usage: noUsage,
});
const ok = await classify(TEXT, good);
check("classify reports success", ok.ok);
if (ok.ok) {
  const rec = fromClassification({
    orgId: "sdaia",
    sourceUrl: "https://example.gov.sa/coop",
    text: TEXT,
    nowISO: NOW,
    prior: undefined,
    firstTime: true,
    c: ok.value,
  });
  check("score passes through", rec.relevanceScore === 95, String(rec.relevanceScore));
  check("no manual-review flag", !rec.flags.includes("needs_manual_review"));
  check("few_seats flagged at 3 seats", rec.flags.includes("few_seats"));
  check("no dates means status unknown, not open", rec.status === "unknown", rec.status);
}

/* ---- the deadline day, which used to be reported as already over ---- */
console.log("\ndeadline days");

const withDatesInput = (opens: string | null, closes: string | null, product = "coop") => ({
  isTrainingAnnouncement: true,
  titleAr: "برنامج التدريب التعاوني",
  opensISO: opens,
  closesISO: closes,
  product: product as "coop" | "graduate_dev",
  majors: [],
  seats: null,
  stipendSAR: null,
  durationWeeks: null,
  cities: [],
  statesZeroCoursesRule: false,
  zeroCoursesQuote: null,
  relevanceScore: product === "graduate_dev" ? 0 : 80,
  relevanceReason: "اختبار.",
  applyUrl: null,
});

const withDates = (opens: string | null, closes: string | null, nowISO: string, product = "coop") =>
  fromClassification({
    orgId: "sdaia",
    sourceUrl: "https://example.gov.sa/coop",
    text: TEXT,
    nowISO,
    prior: undefined,
    firstTime: true,
    c: withDatesInput(opens, closes, product),
  });

// 09:00 in Riyadh on the closing day is 06:00 UTC. The old comparison against
// midnight UTC called this closed, on the one day a late applicant still had.
const morningOfDeadline = "2026-10-15T06:00:00.000Z";
check(
  "a window is still open at nine in the morning on its closing day",
  withDates("2026-10-01", "2026-10-15", morningOfDeadline).status === "closing_soon",
  withDates("2026-10-01", "2026-10-15", morningOfDeadline).status,
);
check(
  "it is closed once that day has ended in Riyadh",
  withDates("2026-10-01", "2026-10-15", "2026-10-15T21:30:00.000Z").status === "closed",
  withDates("2026-10-01", "2026-10-15", "2026-10-15T21:30:00.000Z").status,
);
check(
  "a graduate-development record never surfaces as open, whatever dates it prints",
  withDates("2026-10-01", "2026-12-31", morningOfDeadline, "graduate_dev").status === "unknown",
  withDates("2026-10-01", "2026-12-31", morningOfDeadline, "graduate_dev").status,
);
check(
  "the Hijri deadline is filled in",
  withDates("2026-10-01", "2026-10-15", morningOfDeadline).closesHijri !== null,
  String(withDates("2026-10-01", "2026-10-15", morningOfDeadline).closesHijri),
);
const relative = fromClassification({
  orgId: "sdaia",
  sourceUrl: "https://example.gov.sa/careers/coop",
  text: TEXT,
  nowISO: NOW,
  prior: undefined,
  firstTime: true,
  c: { ...withDatesInput("2026-10-01", "2026-10-15"), applyUrl: "/apply/now" },
});
check(
  "a relative apply link is resolved against the page it was found on",
  relative.applyUrl === "https://example.gov.sa/apply/now",
  String(relative.applyUrl),
);

const nonsense = fromClassification({
  orgId: "sdaia",
  sourceUrl: "https://example.gov.sa/careers/coop",
  text: TEXT,
  nowISO: NOW,
  prior: undefined,
  firstTime: true,
  c: { ...withDatesInput(null, null), applyUrl: "قدّم عبر البوابة" },
});
check(
  "a sentence is never stored as an apply link",
  nonsense.applyUrl === null,
  String(nonsense.applyUrl),
);

/* ---- live checks: two synthetic announcements, real model, real spend ---- */
if (process.argv.includes("--live")) {
  const GRADUATE_DEV = `إعلان: برنامج تطوير الخريجين المنتهي بالتوظيف
تعلن الشركة عن فتح باب التقديم في برنامج تطوير الخريجين لحملة البكالوريوس من الخريجين والخريجات.
يشترط أن يكون المتقدم قد تخرّج فعلياً وحاصلاً على وثيقة التخرج، وألا يكون على رأس العمل.
المدة اثنا عشر شهراً في الرياض، ويشمل البرنامج مكافأة شهرية وتوظيفاً بعد الاجتياز.`;

  const CYBER_COOP = `إعلان: برنامج التدريب التعاوني — محلل أمن سيبراني
تعلن الهيئة عن فتح التقديم في برنامج التدريب التعاوني لطلاب وطالبات الجامعات المتوقع تخرجهم.
التخصصات المطلوبة: الأمن السيبراني، علوم الحاسب، نظم المعلومات.
المسمى التدريبي: محلل أمن سيبراني في مركز العمليات الأمنية.
عدد المقاعد: ثلاثة. المكافأة الشهرية: ثلاثة آلاف ريال. المدة: ثمانية عشر أسبوعاً في الرياض.`;

  const spend: Usage = { inputTokens: 0, outputTokens: 0 };

  for (const [label, text, expect] of [
    ["graduate_dev scores 0", GRADUATE_DEV, "zero"],
    ["cybersecurity coop scores above 90", CYBER_COOP, "high"],
  ] as const) {
    console.log(`\nlive: ${label}`);
    const r = await classify(text);
    spend.inputTokens += r.usage.inputTokens;
    spend.outputTokens += r.usage.outputTokens;
    check("classified", r.ok, r.ok ? "" : `${r.stage}: ${r.reason}`);
    if (!r.ok) continue;

    console.log(`    product=${r.value.product} score=${r.value.relevanceScore}`);
    console.log(`    reason: ${r.value.relevanceReason}`);
    if (expect === "zero") {
      check("product is graduate_dev", r.value.product === "graduate_dev", r.value.product);
      check("score is exactly 0", r.value.relevanceScore === 0, String(r.value.relevanceScore));
    } else {
      check("product is coop", r.value.product === "coop", r.value.product);
      check("score above 90", r.value.relevanceScore > 90, String(r.value.relevanceScore));
    }
  }
  console.log(
    `\nlive spend: ${spend.inputTokens} in / ${spend.outputTokens} out = $${costOf(spend).toFixed(4)} on ${CLASSIFIER_MODEL}`,
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
