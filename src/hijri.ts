/**
 * Reading a Saudi date, in code.
 *
 * Dates were the model's job, and they should not have been. An audit put a
 * real announcement in front of it and it returned the stipend correctly and
 * dropped the seat count, the duration and the city from the same sentence —
 * and a date is the one field where being approximately right is worthless. So
 * the model now reports the date *as the page wrote it*, and this file decides
 * what it means. Same input, same answer, every time, and a test can hold it.
 *
 * The conversion itself is not arithmetic. There are several Hijri calendars
 * and they disagree by a day or two; Saudi civil dates follow Umm al-Qura, and
 * `Intl` ships it as `islamic-umalqura` — the same table the printed calendar
 * comes from. Going Hijri → Gregorian is a search over that table rather than a
 * formula, which is slower and correct, and both of those matter more than
 * speed for four dates a day.
 *
 * The rule that governs everything here: when the year is not written, nothing
 * is guessed at. A wrong deadline is the one error this application must never
 * make.
 */

/** The window the search covers. 1400 AH is 1979; 1500 AH is 2076. */
const FIRST_YEAR = 1400;
const LAST_YEAR = 1500;
const DAY_MS = 86_400_000;

const umalqura = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
});

/** The Umm al-Qura year, month and day for a Gregorian instant. */
export function hijriPartsOf(ms: number): { y: number; m: number; d: number } | null {
  try {
    const parts = umalqura.formatToParts(new Date(ms));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    const y = get("year");
    const m = get("month");
    const d = get("day");
    return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? { y, m, d } : null;
  } catch {
    return null;
  }
}

const rank = (y: number, m: number, d: number): number => y * 10_000 + m * 100 + d;

/**
 * The Gregorian day a Hijri date falls on, as `YYYY-MM-DD`, or null.
 *
 * A binary search over the ICU table. A Hijri year is about 354 days, so an
 * estimate is close enough to bound the search tightly, and the loop settles in
 * a handful of steps. Null when the date does not exist in the calendar at all
 * — the thirtieth of a twenty-nine-day month is a typo, not a deadline.
 */
export function hijriToISO(hy: number, hm: number, hd: number): string | null {
  if (hy < FIRST_YEAR || hy > LAST_YEAR) return null;
  if (hm < 1 || hm > 12 || hd < 1 || hd > 30) return null;

  const target = rank(hy, hm, hd);
  // 1 Muharram 1400 fell on 21 November 1979; from there a Hijri year averages
  // 354.367 days. The estimate only has to land within the search window.
  const estimate = Date.UTC(1979, 10, 21) + (hy - FIRST_YEAR) * 354.367 * DAY_MS;
  let lo = estimate - 400 * DAY_MS;
  let hi = estimate + 400 * DAY_MS;

  for (let step = 0; step < 64 && hi - lo > DAY_MS / 2; step++) {
    const mid = lo + Math.floor((hi - lo) / 2 / DAY_MS) * DAY_MS;
    const parts = hijriPartsOf(mid);
    if (!parts) return null;
    if (rank(parts.y, parts.m, parts.d) < target) lo = mid + DAY_MS;
    else hi = mid;
  }

  const found = hijriPartsOf(hi);
  if (!found || rank(found.y, found.m, found.d) !== target) return null;
  return new Date(hi).toISOString().slice(0, 10);
}

/**
 * Month names as Saudi pages actually write them.
 *
 * Both spellings of the fourth and sixth months are in use — ربيع الآخر and
 * ربيع الثاني name the same month — and a page picks one without warning.
 * Accepting only one of each pair would silently drop a sixth of all dates.
 */
/*
 * Each pattern consumes the *whole* month name, and that is not cosmetic.
 *
 * The first version stopped at the stem — "ربيع الآخ" out of "ربيع الآخر" — and
 * the leftover letter then sat between the month and the year, so the year was
 * never found and four of the twelve months silently produced no date at all.
 * They failed as "no year written", which is the one failure mode that looks
 * legitimate, so nothing about it was suspicious.
 *
 * The ordering matters too: the longer, more specific alternative comes first
 * in each pair, or ربيع الأول would swallow the beginning of ربيع الآخر.
 */
const MONTHS: [RegExp, number][] = [
  [/محرّ?م/, 1],
  [/صفر/, 2],
  [/ربيع\s*(?:ال)?(?:آخر|أخر|اخر|ثاني(?:ة)?)/, 4],
  [/ربيع\s*(?:ال)?(?:أول|اول|أوّل)/, 3],
  [/جمادى\s*(?:ال)?(?:آخرة|أخرة|اخرة|ثاني(?:ة)?)/, 6],
  [/جمادى\s*(?:ال)?(?:أولى|اولى|أُولى)/, 5],
  [/رجب/, 7],
  [/شعبان/, 8],
  [/رمضان/, 9],
  [/شوّ?ال/, 10],
  [/(?:ذو|ذي|ذا)\s*ال?قعدة/, 11],
  [/(?:ذو|ذي|ذا)\s*ال?حجّ?ة/, 12],
];

/** ٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹ are digits too. */
function westernDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) =>
    String(((c.codePointAt(0)! - 0x0660) % 16).toString(10).slice(-1)),
  );
}

export interface ParsedDate {
  /** The Gregorian day, or null when it could not be determined. */
  iso: string | null;
  /** "hijri" | "gregorian" — what the page was writing. */
  calendar: "hijri" | "gregorian" | null;
  /** True when a day and month were read but no year was written. */
  ambiguousYear: boolean;
  /** What was matched, so a reader can check the reading. */
  matched: string | null;
}

const NONE: ParsedDate = { iso: null, calendar: null, ambiguousYear: false, matched: null };

/**
 * Read one date out of a phrase, as the page wrote it.
 *
 * Handles the shapes these announcements actually use: `12 ربيع الأول 1448`,
 * `١٤٤٨/٣/١٢`, `1448-03-12`, `12/03/2026`, `2026-09-15`, and a named Hijri month
 * with no year at all.
 *
 * A year that is not written is not invented. It would be easy to assume "the
 * next occurrence", and it would be wrong the first time a page republished an
 * old announcement — so the day and month are reported with `ambiguousYear` and
 * no ISO date, and the deadline alarm stays quiet rather than firing on a guess.
 */
export function parseArabicDate(input: string): ParsedDate {
  if (typeof input !== "string" || input.trim() === "") return NONE;
  const text = westernDigits(input).replace(/‏|‎/g, "");

  /* 1. A named month: "12 ربيع الأول 1448" or "غرة رمضان 1448". */
  for (const [re, month] of MONTHS) {
    const at = re.exec(text);
    if (!at) continue;
    const before = text.slice(Math.max(0, at.index - 12), at.index);
    const after = text.slice(at.index + at[0].length, at.index + at[0].length + 14);
    const day = /(\d{1,2})\s*$/.exec(before)?.[1];
    // "هـ", "ه", "من عام", a comma — a few Arabic letters may stand between the
    // month and its year without meaning the year is absent.
    const year = /^[\s\p{L}ـ.،,]{0,10}?(\d{4})/u.exec(after)?.[1];
    if (!day) continue;

    // Hijri years are four digits starting 14; anything else beside an Arabic
    // month name is a Gregorian year written in an Arabic sentence.
    if (year && /^1[34]\d\d$/.test(year)) {
      const iso = hijriToISO(Number(year), month, Number(day));
      return { iso, calendar: "hijri", ambiguousYear: false, matched: `${day} ${at[0]} ${year}` };
    }
    return {
      iso: null,
      calendar: "hijri",
      ambiguousYear: true,
      matched: `${day} ${at[0]}`,
    };
  }

  /* 2. Numeric, in either calendar: 1448/03/12, 1448-03-12, 12/03/1448. */
  const numeric = /(\d{2,4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,4})/.exec(text);
  if (numeric) {
    const [, a, b, c] = numeric as unknown as [string, string, string, string];
    const first = Number(a);
    const last = Number(c);

    // Year first when the first field is four digits, else year last.
    const [y, m, d] =
      a.length === 4 ? [first, Number(b), last] : [last, Number(b), first];

    if (y >= FIRST_YEAR && y <= LAST_YEAR) {
      return { iso: hijriToISO(y, m, d), calendar: "hijri", ambiguousYear: false, matched: numeric[0] };
    }
    if (y >= 1900 && y <= 2200) {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const ok = !Number.isNaN(Date.parse(iso)) && new Date(iso).getUTCDate() === d;
      return { iso: ok ? iso : null, calendar: "gregorian", ambiguousYear: false, matched: numeric[0] };
    }
    return { ...NONE, matched: numeric[0] };
  }

  /* 3. A bare ISO date the classifier already resolved. */
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    return { iso: iso[0], calendar: "gregorian", ambiguousYear: false, matched: iso[0] };
  }

  return NONE;
}
