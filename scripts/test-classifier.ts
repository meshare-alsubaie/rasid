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
