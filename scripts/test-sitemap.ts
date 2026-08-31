/**
 * The sitemap reader, and the one judgement it makes on its own.
 *
 * It decides nothing about whether a page is an announcement — that stays with
 * the classifier, and a candidate still has to be opened by `verify-leads`
 * before it counts. The only call it makes alone is "is this url worth
 * opening", and that call has a history: an earlier version of the same idea
 * matched `co-?op` anywhere and pulled two ministries' international-cooperation
 * pages into the dataset as training links. In Arabic the trap is the same
 * shape — التعاوني is the training, التعاون is diplomacy.
 *
 *   npm run test:sitemap
 */
import { looksLikeTraining, MAX_URLS_PER_SITEMAP, TRAINING_PATH } from "../src/pipeline/sitemap";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("urls worth opening");
for (const url of [
  "https://sdaia.gov.sa/ar/coop",
  "https://athkax.sdaia.gov.sa/coop",
  "https://x.gov.sa/ar/التدريب-التعاوني",
  "https://x.gov.sa/ar/تدريب-تعاوني/2026",
  "https://x.gov.sa/en/co-op-programme",
  "https://x.gov.sa/en/internship",
  "https://x.gov.sa/ar/careers/jobs",
  "https://x.gov.sa/ar/وظائف",
  "https://x.gov.sa/ar/برنامج-المتدربين",
  "https://x.gov.sa/ar/فرص-الطلاب",
]) {
  check(url, looksLikeTraining(url));
}

console.log("\nurls that must be left alone");
for (const url of [
  // The exact false positive that reached production once.
  "https://www.saso.gov.sa/ar/eservices/Pages/international_cooperation.aspx",
  "https://www.sfda.gov.sa/ar/international-cooperation",
  "https://x.gov.sa/ar/التعاون-الدولي",
  "https://x.gov.sa/ar/cooperation-agreements",
  "https://x.gov.sa/ar/about-us",
  "https://x.gov.sa/ar/media-center/news/2093",
  "https://x.gov.sa/ar/contact",
  "https://x.gov.sa/",
]) {
  check(url, !looksLikeTraining(url));
}

console.log("\nsafety");
check(
  "a url with no path at all does not match",
  !looksLikeTraining("https://example.gov.sa"),
);
check(
  "a malformed url does not throw",
  (() => {
    try {
      looksLikeTraining("not a url at all");
      return true;
    } catch {
      return false;
    }
  })(),
);
check(
  "only the path is examined, never the host",
  !looksLikeTraining("https://training-institute.example.com/about"),
  "otherwise every page of a company with 'training' in its name qualifies",
);
check("the per-sitemap cap is finite and sane", MAX_URLS_PER_SITEMAP > 0 && MAX_URLS_PER_SITEMAP <= 20_000);
check("the pattern is anchored on co-op and not cooperation", !TRAINING_PATH.test("/cooperation"));

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
