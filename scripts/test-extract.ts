/**
 * Extraction, against the pages that broke it.
 *
 * Every case here comes from a fault injection or a real page, not from
 * imagination: a ministry that answers 200 with a 404 title, a catalogue whose
 * 242 results were reduced to 431 characters of icon names, an entity bomb, and
 * a page whose whole content sits in a region that used to be stripped before
 * hashing.
 *
 *   npm run test:extract
 */
import { extract, isSoft404 } from "../src/pipeline/extract";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="ar"><head><title>${title}</title></head><body>${body}</body></html>`;

const ANNOUNCEMENT = `<article><h1>برنامج التدريب التعاوني</h1>
  <p>تعلن الجهة عن فتح باب التقديم في برنامج التدريب التعاوني لطلاب الجامعات.
     التخصصات: الأمن السيبراني وعلوم الحاسب. عدد المقاعد أربعة. المكافأة ثلاثة آلاف ريال.
     آخر موعد للتقديم 12 ربيع الأول 1448. المقر الرياض.</p></article>`;

console.log("a page that answers 200 and says it is missing");
for (const title of [
  "الصفحة غير موجودة 404",
  "404 Not Found",
  "Error 404 - Page not found",
  "عذراً، لم يتم العثور على الصفحة",
]) {
  check(`"${title}" is a soft 404`, isSoft404(title));
}
for (const title of [
  "برنامج التدريب التعاوني - سدايا",
  "الوظائف والتدريب",
  "Careers at Aramco",
  // The word "training" is not an error, and a page about 404 errors is rare
  // enough that a false negative here costs less than a false positive.
  "دليل التدريب على معالجة الأخطاء",
]) {
  check(`"${title}" is not`, !isSoft404(title));
}
check("no title at all is not a soft 404", !isSoft404(null));

console.log("\nthe fuller reading wins when the two disagree wildly");
/*
 * A listing page: a little prose that Readability will latch onto, and the
 * actual content — the listing — outside the article it picks.
 */
const listing = page(
  "دليل الدورات",
  `<article><p>${"تصفية النتائج ".repeat(20)}</p></article>` +
    `<section>${"إعلان التدريب التعاوني للفصل الدراسي الأول، التخصصات المطلوبة الأمن السيبراني. ".repeat(120)}</section>`,
);
const got = extract(listing, "https://example.gov.sa/catalogue");
check(
  "the listing is not reduced to its filter labels",
  got.chars > 2000,
  `${got.chars} chars via ${got.method}`,
);

console.log("\ncontent in regions that used to be stripped before hashing");
const inAside = page("أخبار الجهة", `<aside>${ANNOUNCEMENT}</aside>`);
const inHeader = page("أخبار الجهة", `<header>${ANNOUNCEMENT}</header>`);
check(
  "an announcement inside <aside> is read",
  extract(inAside, "https://example.gov.sa/").text.includes("التدريب التعاوني"),
);
check(
  "an announcement inside <header> is read",
  extract(inHeader, "https://example.gov.sa/").text.includes("التدريب التعاوني"),
);
check(
  "navigation is still dropped",
  !extract(page("x", `<nav>تسجيل الدخول الرئيسية اتصل بنا</nav>${ANNOUNCEMENT}`), "https://x.sa/")
    .text.includes("اتصل بنا"),
);

console.log("\nthe hash answers 'did this page move', and nothing else");
const a = extract(page("t", ANNOUNCEMENT), "https://example.gov.sa/");
const b = extract(page("t", ANNOUNCEMENT), "https://example.gov.sa/");
check("the same page twice hashes the same", a.hash === b.hash);
const moved = extract(
  page("t", ANNOUNCEMENT.replace("12 ربيع الأول 1448", "20 ربيع الأول 1448")),
  "https://example.gov.sa/",
);
check("a changed deadline changes the hash", a.hash !== moved.hash);
check(
  "a changed navigation menu does not",
  extract(page("t", `<nav>أ</nav>${ANNOUNCEMENT}`), "https://x.sa/").hash ===
    extract(page("t", `<nav>ب ج د</nav>${ANNOUNCEMENT}`), "https://x.sa/").hash,
);

console.log("\nhostile input");
const bomb =
  `<!doctype html><!DOCTYPE lolz [<!ENTITY lol "lol">` +
  `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
  `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>` +
  `<html><body><p>&lol3;</p></body></html>`;
const started = Date.now();
const bombed = extract(bomb, "https://x.sa/");
check(
  "an entity bomb does not expand and does not hang",
  bombed.chars < 10_000 && Date.now() - started < 3_000,
  `${bombed.chars} chars in ${Date.now() - started}ms`,
);
check("deeply nested markup survives", extract(page("t", "<div>".repeat(500) + "نص" + "</div>".repeat(500)), "https://x.sa/").text.includes("نص"));
check("an empty document does not throw", extract("", "https://x.sa/").chars === 0);
check("markup with no body does not throw", extract("<html><head></head></html>", "https://x.sa/").chars === 0);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
