/**
 * Turning a classifier verdict into a stored Opportunity.
 *
 * Two constructors, and the split is the point. `fromClassification` builds a
 * record the classifier actually judged. `asManualReview` builds one it could
 * not, with `relevanceScore: null` and a `needs_manual_review` flag. There is
 * deliberately no path that produces a scored record without a verdict behind
 * it, so a failure can never be read as "not relevant".
 */
import { createHash } from "node:crypto";
import type { Classification } from "./classify";
import { endOfDeadline, hijriOf, startOfDay } from "../types";
import type { Opportunity, OpportunityFlag, OpportunityStatus } from "../types";

const HOURS_48 = 48 * 60 * 60 * 1000;

const idFor = (orgId: string, titleAr: string, firstSeenISO: string): string =>
  createHash("sha256").update(`${orgId}|${titleAr}|${firstSeenISO}`).digest("hex").slice(0, 16);

/**
 * Only dates justify a window state. With neither an opening nor a closing
 * date, the honest answer is "unknown": a page can name a programme without
 * ever saying when it takes applications, and calling that "open" is the one
 * guess that would cost the user a semester.
 */
function statusOf(c: Classification, nowISO: string): OpportunityStatus {
  const now = Date.parse(nowISO);
  const opens = c.opensISO === null ? null : startOfDay(c.opensISO);
  const closes = c.closesISO === null ? null : endOfDeadline(c.closesISO);

  /*
   * A graduate-development programme is never "open" here, whatever dates it
   * publishes. It is not the product this app tracks, and spec 8.5 forbids the
   * state outright — which the validator enforced by failing the run, throwing
   * away a whole collection, any genuine announcement in it, and the deploy.
   * Refusing the state at the source is the fix; the validator stays as the
   * backstop it was meant to be.
   */
  if (c.product === "graduate_dev") return "unknown";

  if (closes !== null && closes < now) return "closed";
  if (opens !== null && opens > now) return "announced_not_open";
  if (closes !== null && closes - now <= HOURS_48) return "closing_soon";
  if (opens !== null || closes !== null) return "open";
  return "unknown";
}

function flagsFor(c: Classification, status: OpportunityStatus, firstTime: boolean): OpportunityFlag[] {
  const flags: OpportunityFlag[] = [];
  if (c.product === "graduate_dev") flags.push("wrong_product");
  if (c.relevanceScore >= 90) flags.push("exact_major_match");
  if (c.seats !== null && c.seats <= 5) flags.push("few_seats");
  if (c.stipendSAR !== null && c.stipendSAR > 0) flags.push("has_stipend");
  if (status === "closing_soon") flags.push("closing_in_48h");
  // Records absence, nothing more. The system prompt is explicit that no such
  // rule being published is not evidence that the organisation is flexible.
  if (!c.statesZeroCoursesRule) flags.push("no_course_condition");
  if (firstTime) flags.push("first_time_seen");
  return flags;
}

interface Common {
  orgId: string;
  sourceUrl: string;
  text: string;
  nowISO: string;
  /** The matching record from a previous run, if this announcement is known. */
  prior: Opportunity | undefined;
  firstTime: boolean;
}

/**
 * The model reads an apply link off the page, so it arrives however the page
 * wrote it: "/careers/apply", "apply.aspx", sometimes a sentence. Resolving it
 * against the page it was found on turns the first two into real addresses, and
 * anything that still is not http(s) is dropped rather than stored — a broken
 * apply link on a deadline is worse than no link, because the user taps it.
 */
function absoluteApplyUrl(candidate: string | null, sourceUrl: string): string | null {
  const raw = candidate?.trim();
  if (!raw) return null;

  /*
   * A relative resolve accepts almost anything, which is the trap: the model
   * sometimes answers with a sentence — "قدّم عبر البوابة" — and `new URL` will
   * happily turn that into `https://host/careers/%D9%82...`, a link that goes
   * nowhere and that the user would tap on a deadline. Only something built
   * from url characters is treated as a url at all.
   */
  const looksLikePath = /^[A-Za-z0-9._~!$&'()*+,;=:@%/?#[\]-]+$/.test(raw);
  if (!looksLikePath) return null;

  try {
    const resolved = new URL(raw, sourceUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
}

export function fromClassification(args: Common & { c: Classification }): Opportunity {
  const { orgId, sourceUrl, text, nowISO, prior, firstTime, c } = args;
  const firstSeenISO = prior?.firstSeenISO ?? nowISO;
  const status = statusOf(c, nowISO);
  // classify() refuses an announcement without a title, so by the time a
  // record is built this is a real string.
  const titleAr = c.titleAr ?? "";

  return {
    id: idFor(orgId, titleAr, firstSeenISO),
    orgId,
    titleAr,
    detectedISO: prior?.detectedISO ?? nowISO,
    firstSeenISO,
    lastConfirmedISO: nowISO,
    status,
    opensISO: c.opensISO,
    closesISO: c.closesISO,
    closesHijri: hijriOf(c.closesISO),
    product: c.product,
    majors: c.majors,
    seats: c.seats,
    stipendSAR: c.stipendSAR,
    durationWeeks: c.durationWeeks,
    cities: c.cities,
    relevanceScore: c.relevanceScore,
    relevanceReason: c.relevanceReason,
    statesZeroCoursesRule: c.statesZeroCoursesRule,
    zeroCoursesQuote: c.zeroCoursesQuote,
    flags: flagsFor(c, status, firstTime),
    sourceUrl,
    applyUrl: absoluteApplyUrl(c.applyUrl, sourceUrl),
    rawExcerpt: text.slice(0, 400),
  };
}

export function asManualReview(args: Common & { reason: string }): Opportunity {
  const { orgId, sourceUrl, text, nowISO, prior, reason } = args;
  const titleAr = "لم يُصنَّف بعد";
  const firstSeenISO = prior?.firstSeenISO ?? nowISO;

  return {
    id: idFor(orgId, titleAr, firstSeenISO),
    orgId,
    titleAr,
    detectedISO: prior?.detectedISO ?? nowISO,
    firstSeenISO,
    lastConfirmedISO: nowISO,
    // Not "open", not "closed". We did not read this page's meaning at all.
    status: "unknown",
    opensISO: null,
    closesISO: null,
    closesHijri: null,
    product: "unknown",
    majors: [],
    seats: null,
    stipendSAR: null,
    durationWeeks: null,
    cities: [],
    // The whole point. Zero would mean "not relevant to him"; null means
    // "nobody has judged this yet", and the flag keeps it in the queue.
    relevanceScore: null,
    relevanceReason: `تعذّر التصنيف: ${reason}`,
    // Nobody read the page, so nothing is claimed about its conditions.
    statesZeroCoursesRule: false,
    zeroCoursesQuote: null,
    flags: ["needs_manual_review"],
    sourceUrl,
    applyUrl: null,
    rawExcerpt: text.slice(0, 400),
  };
}
