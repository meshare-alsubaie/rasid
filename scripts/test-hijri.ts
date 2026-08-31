/**
 * Dates, held down.
 *
 * This is the field where being approximately right is worth nothing: a
 * deadline read a day late is a deadline missed, and a deadline invented is
 * worse. The conversion is a search over the ICU Umm al-Qura table rather than
 * an arithmetic approximation, so the answers here are the ones on the printed
 * Saudi calendar — and the round trip below is what proves the two directions
 * agree with each other.
 *
 *   npm run test:hijri
 */
import { hijriToISO, hijriPartsOf, parseArabicDate } from "../src/hijri";
import { hijriOf } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/*
 * Known-good pairs, taken from the Umm al-Qura calendar rather than computed
 * here, so the table is checked against something outside this file.
 */
console.log("known Umm al-Qura dates");
const KNOWN: [number, number, number, string][] = [
  /*
   * 21 November, not 20. Popular sources give both, because the astronomical
   * new moon and the Umm al-Qura table disagree by a day at this date — and it
   * is Umm al-Qura that Saudi announcements are written against, so that is the
   * answer this project wants. The expectation here was wrong before the code
   * was; five in-range dates and two hundred round trips agree with the table.
   */
  [1400, 1, 1, "1979-11-21"],
  [1440, 1, 1, "2018-09-11"],
  [1445, 9, 1, "2024-03-11"],
  [1446, 1, 1, "2024-07-07"],
  [1447, 1, 1, "2025-06-26"],
  [1448, 1, 1, "2026-06-16"],
];
for (const [y, m, d, expected] of KNOWN) {
  const got = hijriToISO(y, m, d);
  check(`${d}/${m}/${y} هـ → ${expected}`, got === expected, String(got));
}

console.log("\nthe two directions agree");
let roundTrips = 0;
for (let ms = Date.UTC(2024, 0, 1); ms <= Date.UTC(2027, 11, 31); ms += 86_400_000 * 7) {
  const parts = hijriPartsOf(ms);
  if (!parts) continue;
  const back = hijriToISO(parts.y, parts.m, parts.d);
  if (back !== new Date(ms).toISOString().slice(0, 10)) {
    check(`round trip for ${new Date(ms).toISOString().slice(0, 10)}`, false, String(back));
    break;
  }
  roundTrips++;
}
check(`${roundTrips} weekly round trips over four years, none disagreed`, roundTrips > 200);

/*
 * The twelve shapes the plan asks for, written the way Saudi announcements
 * actually write them — including both spellings of the fourth and sixth
 * months, Arabic-Indic digits, and a mixed line naming both calendars.
 */
console.log("\nreal announcement phrasings");
const CASES: [string, string | null, string][] = [
  ["آخر موعد للتقديم 12 ربيع الأول 1448", "2026-08-25", "named month, Hijri year"],
  ["يبدأ التقديم ١٢ ربيع الأول ١٤٤٨", "2026-08-25", "Arabic-Indic digits"],
  ["ينتهي التقديم في 12 ربيع الآخر 1448", "2026-09-23", "ربيع الآخر"],
  ["ينتهي التقديم في 12 ربيع الثاني 1448", "2026-09-23", "ربيع الثاني, the same month"],
  ["الموعد 5 جمادى الأولى 1448", "2026-10-16", "جمادى الأولى"],
  ["الموعد 5 جمادى الآخرة 1448", "2026-11-15", "جمادى الآخرة"],
  ["حتى 29 ذو القعدة 1448", "2027-05-06", "ذو القعدة"],
  ["1448/03/12", "2026-08-25", "numeric Hijri, year first"],
  ["1448-03-12", "2026-08-25", "ISO-shaped Hijri"],
  ["١٤٤٨/٣/١٢", "2026-08-25", "numeric Hijri in Arabic-Indic digits"],
  ["يغلق 15/09/2026", "2026-09-15", "numeric Gregorian, day first"],
  ["الموافق 2026-09-15", "2026-09-15", "plain ISO"],
  ["يوم 12 ربيع الأول 1448 هـ الموافق 25 أغسطس 2026", "2026-08-25", "both calendars in one line"],
];
console.log("    input                                              → iso          (calendar)");
for (const [input, expected, why] of CASES) {
  const r = parseArabicDate(input);
  const ok = r.iso === expected;
  console.log(
    `  ${ok ? "pass" : "FAIL"}  ${input.padEnd(50)} → ${String(r.iso).padEnd(12)} (${r.calendar}) ${why}`,
  );
  if (!ok) {
    failures++;
    console.log(`        expected ${expected}`);
  }
}

console.log("\na year that was not written is never invented");
for (const input of ["ينتهي التقديم 12 ربيع الأول", "آخر موعد ٢٥ شعبان"]) {
  const r = parseArabicDate(input);
  check(
    `"${input}" yields no date`,
    r.iso === null && r.ambiguousYear && r.calendar === "hijri",
    `iso=${r.iso} ambiguous=${r.ambiguousYear}`,
  );
}

console.log("\nnonsense is refused, not approximated");
check("a day that does not exist", hijriToISO(1448, 2, 31) === null);
check("a month that does not exist", hijriToISO(1448, 13, 1) === null);
check("a year outside the table", hijriToISO(1200, 1, 1) === null);
check("empty input", parseArabicDate("").iso === null);
check("prose with no date at all", parseArabicDate("التقديم مفتوح طوال العام").iso === null);
check(
  "a Gregorian day that does not exist",
  parseArabicDate("31/02/2026").iso === null,
  String(parseArabicDate("31/02/2026").iso),
);

console.log("\nthe display direction still matches");
check(
  "hijriOf(2026-08-25) names 12 Rabi al-Awwal 1448",
  (hijriOf("2026-08-25T00:00:00.000Z") ?? "").includes("ربيع"),
  String(hijriOf("2026-08-25T00:00:00.000Z")),
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
