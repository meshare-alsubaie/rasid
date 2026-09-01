/**
 * The filter that decides which pages are worth paying to have judged.
 *
 * It exists because a hundred and forty news pages were being sent to the model
 * every six hours to be told, correctly, that a story about a ribbon-cutting is
 * not a training announcement — two to four dollars a day to hear "no".
 *
 * It is also the most dangerous thing in the pipeline, because a false negative
 * here is exactly the failure this whole project was built to prevent: a real
 * announcement that is never even looked at. So the tests are weighted
 * accordingly. Every real announcement phrasing must pass; a page that is
 * genuinely about something else may be skipped. When in doubt the filter must
 * let it through and cost a cent.
 *
 *   npm run test:costfilter
 */
import { readFileSync } from "node:fs";

/** Read from the collector itself, so the test cannot drift from the code. */
const source = readFileSync("scripts/collect.ts", "utf8");
const match = /const MENTIONS_TRAINING =\s*(\/.+?\/i);/s.exec(source);
if (!match?.[1]) {
  console.log("could not find MENTIONS_TRAINING in scripts/collect.ts");
  process.exit(1);
}
// eslint-disable-next-line no-eval -- reading the live pattern is the point
const MENTIONS_TRAINING = eval(match[1]) as RegExp;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("every real announcement must get through");
const REAL = [
  "تعلن الهيئة عن فتح باب التقديم في برنامج التدريب التعاوني لطلاب الجامعات",
  "برنامج التدريب التعاوني للفصل الدراسي الأول",
  "فرص تدريب تعاوني في مجال الأمن السيبراني",
  "برنامج المتدربين لعام 2026",
  "يعلن المصرف عن حاجته لمتدربين في إدارة تقنية المعلومات",
  "التدريب على رأس العمل للخريجين",
  "برنامج تمهير",
  "فتح التسجيل في برنامج تطوير الخريجين",
  "الوظائف والتدريب",
  "تُعلن الشركة عن توفر فرص للطلاب والطالبات",
  "Cooperative Training Program now open",
  "COOP training applications are open for university students",
  "Summer internship programme 2026",
  "Graduate development programme applications",
  "We are hiring trainees for our security operations centre",
  "Careers at SDAIA — student opportunities",
  // The hardest kind: an announcement that never says "coop" at all.
  "فرصة للطلاب المتوقع تخرجهم للانضمام إلى فريق العمل لمدة فصل دراسي",
  "نبحث عن طالب جامعي للانضمام إلينا هذا الفصل ضمن برنامج تأهيل",
];
for (const text of REAL) check(text.slice(0, 62), MENTIONS_TRAINING.test(text));

console.log("\npages that are genuinely about something else may be skipped");
const NOISE = [
  "نائب أمير المنطقة يلتقي مدير الفرع لبحث سبل التعاون المشترك",
  "الهلال الأحمر يسلّم شهادة الامتثال لأحد المستشفيات",
  "افتتاح المعرض السنوي بحضور معالي الوزير",
  "إطلاق الخدمة الإلكترونية الجديدة لإصدار التصاريح",
  "تقرير الأداء السنوي للربع الثالث",
  "Board approves the annual financial statements",
  "The authority signs a memorandum of understanding",
  "Quarterly results announcement for investors",
];
let skipped = 0;
for (const text of NOISE) {
  const wouldSkip = !MENTIONS_TRAINING.test(text);
  if (wouldSkip) skipped++;
  console.log(`  ${wouldSkip ? "skip" : "sent"}  ${text.slice(0, 62)}`);
}
check(
  `at least half the noise is skipped (${skipped} of ${NOISE.length})`,
  skipped >= NOISE.length / 2,
  "sending some noise costs a cent; skipping an announcement costs a semester",
);

console.log("\nthe pages that matter are never filtered at all");
check(
  "a confirmed co-op page bypasses the filter",
  /coopConfirmed === true/.test(source) && /alwaysJudge/.test(source),
);
check(
  "so does a careers page",
  /s\.type === "careers_page"/.test(source),
);
check(
  "and --reclassify bypasses it entirely",
  /!RECLASSIFY && !alwaysJudge/.test(source),
);
check(
  "every skip is counted and printed, never silent",
  /skippedByFilter\+\+/.test(source) && /no training word/.test(source),
);
check(
  "and so is every page ruled out by the one-word question",
  /triagedOut\+\+/.test(source) && /ruled out in one word/.test(source),
);
check(
  "and every verdict answered from memory",
  /fromMemory\+\+/.test(source) && /answered from memory/.test(source),
);
check(
  "a failed one-word question never hides a page",
  /looksLikeAnnouncement: true/.test(readFileSync("src/pipeline/classify.ts", "utf8")),
  "triage returns yes on any error, so it can only ever save money",
);
check(
  "a skipped page is not left owing a verdict for ever",
  /skippedByFilter\+\+;[\s\S]{0,300}pendingClassification = false/.test(source),
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
