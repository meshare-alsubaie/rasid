/**
 * Phase 3: ask Claude whether a changed page is an announcement this student
 * can actually apply to.
 *
 * The whole module is built around one rule: a classifier that could not judge
 * must never look like a classifier that judged "no". Spec section 5.3 sets the
 * failure path, and the three ways to get it quietly wrong are all closed here:
 *
 *   - a response that will not parse is NOT scored 0, it is a failure
 *   - an API call that never returned is NOT "no announcement", it is a failure
 *   - a missing field is NOT filled with a plausible default, it is a failure
 *
 * Zero means "not relevant to him". It never means "we could not tell".
 * Every failure comes back as `ok: false` and the caller is expected to store
 * the record with `relevanceScore: null` and a `needs_manual_review` flag.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Ajv } from "ajv";

/**
 * The spec named claude-sonnet-4-6; the owner moved it to claude-sonnet-5,
 * which is the newer model in the same tier and cheaper per token. Nothing
 * else in this file depends on which one runs.
 */
export const CLASSIFIER_MODEL = "claude-sonnet-5";

/** Spec section 5.3: send only the changed text block, at most 6000 chars. */
export const MAX_EXCERPT_CHARS = 6000;

export interface Classification {
  isTrainingAnnouncement: boolean;
  product: "coop" | "graduate_dev" | "professional_experience" | "unknown";
  /**
   * DEVIATION FROM SPEC section 5.3, which types this as `string`.
   * A page that carries no announcement has no title, and the model correctly
   * returned null for one. Rejecting that put a page reading "لا توجد نتائج"
   * in the manual-review queue on every run, forever, at two API calls a time.
   * Null is accepted, and the cross-field check below still refuses a titleless
   * announcement - so the strictness stays exactly where it earns its keep.
   */
  titleAr: string | null;
  opensISO: string | null;
  closesISO: string | null;
  /**
   * The dates exactly as the page wrote them, before anyone interpreted them.
   *
   * The model used to be asked to convert Hijri to Gregorian itself. It is
   * good at it and that is not the point: the conversion has one right answer,
   * a table defines it, and a field where being a day out costs a semester
   * should not depend on a model being careful this time. So the model copies
   * the characters and `parseArabicDate` decides what they mean — and because
   * the raw string is kept, a reader can check the reading.
   */
  opensRaw: string | null;
  closesRaw: string | null;
  /**
   * Whether the page carries other distinct announcements besides this one.
   *
   * The pipeline keeps exactly one record per source — the delete-then-insert
   * in `collect.ts` guarantees it — so a careers page listing four open
   * programmes yields one, and the other three are invisible. That is a real
   * limit and it is common: portals list a co-op programme, a summer
   * programme, and a graduate scheme on the same page.
   *
   * Capturing all of them would mean an array in this schema and a different
   * identity scheme for records. Short of that, the honest thing is to know
   * that more exists and say so, so the user opens the page himself instead of
   * trusting a list that is quietly partial.
   */
  moreOnPage: boolean;
  majors: string[];
  seats: number | null;
  stipendSAR: number | null;
  durationWeeks: number | null;
  cities: string[];
  statesZeroCoursesRule: boolean;
  zeroCoursesQuote: string | null;
  relevanceScore: number;
  relevanceReason: string;
  applyUrl: string | null;
}

/**
 * Prices verified against platform.claude.com/docs/en/about-claude/pricing on
 * 2026-08-29, not from memory. The page also states that the $2/$10 launch
 * pricing for Sonnet 5 is now the standard price and the increase to $3/$15
 * that had been scheduled for 2026-09-01 will not happen.
 */
export const PRICE_PER_MTOK = { input: 2, output: 10 } as const;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const costOf = (u: Usage): number =>
  (u.inputTokens * PRICE_PER_MTOK.input + u.outputTokens * PRICE_PER_MTOK.output) / 1_000_000;

export type ClassifyResult =
  | { ok: true; value: Classification; attempts: number; usage: Usage }
  | {
      ok: false;
      /** Where it broke, so health reporting can tell a bad key from a bad reply. */
      stage: "no_credentials" | "no_profile" | "api" | "parse" | "schema";
      reason: string;
      attempts: number;
      /** Tokens are still billed for a reply that failed to parse. */
      usage: Usage;
    };

/**
 * The one call to the model, isolated so tests can drive every failure branch
 * without a network or a bill. Production passes `liveAsk`.
 */
export type Asker = (excerpt: string, insist: boolean) => Promise<{ text: string; usage: Usage }>;

/**
 * The student profile is the one piece of this repository that describes a
 * person: university, GPA, certification, and the hours he is in class. The
 * repository is public, so it does not live here.
 *
 * It is read at runtime from `RASID_STUDENT_PROFILE`, or from a gitignored
 * `.profile.local` for convenience on a development machine. The prompt is
 * still assembled verbatim per spec section 5.3; only the storage moved.
 *
 * If neither exists, classification fails with `no_profile` rather than
 * running against a blank or invented profile. Judging a student's chances
 * against the wrong student is worse than not judging at all.
 */
export function studentProfile(): string | null {
  const fromEnv = process.env.RASID_STUDENT_PROFILE?.trim();
  if (fromEnv) return fromEnv;
  try {
    const local = readFileSync(".profile.local", "utf8").trim();
    return local || null;
  } catch {
    return null;
  }
}

/** Spec section 5.3, used verbatim. Do not paraphrase: it is the contract. */
export const buildSystemPrompt = (profile: string): string =>
  `You classify Saudi training announcements for one specific student.

STUDENT PROFILE
${profile}

Return ONLY valid JSON, no markdown fences, matching this schema:

{
  "isTrainingAnnouncement": boolean,
  "product": "coop" | "graduate_dev" | "professional_experience" | "unknown",
  "titleAr": string,
  "opensISO": string | null,
  "closesISO": string | null,
  "opensRaw": string | null,
  "closesRaw": string | null,
  "moreOnPage": boolean,
  "majors": string[],
  "seats": number | null,
  "stipendSAR": number | null,
  "durationWeeks": number | null,
  "cities": string[],
  "statesZeroCoursesRule": boolean,
  "zeroCoursesQuote": string | null,
  "relevanceScore": number,
  "relevanceReason": string,
  "applyUrl": string | null
}

RULES
- Extract only what the text actually states. Never infer a date or amount.
  If it is not written, return null.
- statesZeroCoursesRule is true ONLY if the text explicitly forbids registered
  courses or demands full-time availability as a condition. Copy the exact
  wording into zeroCoursesQuote. Absence of such a rule is NOT evidence of
  flexibility — it is simply absence.
- relevanceScore: 0 if product is "graduate_dev" (he cannot apply).
  90–100 if the role names cybersecurity, SOC, information security, or
  security analysis. 60–85 for networks, systems, IT, software, data.
  20–50 for general technical. 0–15 for unrelated fields.
- relevanceReason: one short Arabic sentence explaining the score.
- opensISO / closesISO: a Gregorian ISO date (YYYY-MM-DD) ONLY if the page
  itself gives one. Otherwise null. Do not convert a Hijri date yourself.
- opensRaw / closesRaw: the date exactly as the page writes it, copied
  verbatim — "12 ربيع الأول 1448", "١٤٤٨/٣/١٢", "15 سبتمبر 2026". Null if the
  page states no such date. Copy the characters; do not interpret them.

- moreOnPage: true when the page carries other distinct training announcements
  besides the one you described — a second programme, a different season, a
  separate track. Only one is recorded per page, so this is how the reader
  learns to open the page and look for the rest.

Dates are converted afterwards, in code, against the Umm al-Qura calendar. Your
job with a date is to find it and repeat it, not to work out what it means: a
deadline read a day wrong costs the reader a semester, and this is the one field
where a careful guess is worse than none.`;

/** Kept for tests and for anyone reading the contract without a profile set. */
export const SYSTEM_PROMPT_SHAPE = buildSystemPrompt("<RASID_STUDENT_PROFILE>");

/**
 * additionalProperties is false and every field is required on purpose. A
 * reply missing `closesISO` is a reply we cannot trust, not a reply with no
 * closing date: null has to be stated, never assumed.
 */
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isTrainingAnnouncement",
    "product",
    "titleAr",
    "opensISO",
    "closesISO",
    "opensRaw",
    "closesRaw",
    "moreOnPage",
    "majors",
    "seats",
    "stipendSAR",
    "durationWeeks",
    "cities",
    "statesZeroCoursesRule",
    "zeroCoursesQuote",
    "relevanceScore",
    "relevanceReason",
    "applyUrl",
  ],
  properties: {
    isTrainingAnnouncement: { type: "boolean" },
    product: {
      type: "string",
      enum: ["coop", "graduate_dev", "professional_experience", "unknown"],
    },
    titleAr: { type: ["string", "null"] },
    opensISO: { type: ["string", "null"] },
    closesISO: { type: ["string", "null"] },
    opensRaw: { type: ["string", "null"] },
    closesRaw: { type: ["string", "null"] },
    moreOnPage: { type: "boolean" },
    majors: { type: "array", items: { type: "string" } },
    seats: { type: ["integer", "null"], minimum: 0 },
    stipendSAR: { type: ["number", "null"], minimum: 0 },
    durationWeeks: { type: ["number", "null"], minimum: 0 },
    cities: { type: "array", items: { type: "string" } },
    statesZeroCoursesRule: { type: "boolean" },
    zeroCoursesQuote: { type: ["string", "null"] },
    relevanceScore: { type: "number", minimum: 0, maximum: 100 },
    relevanceReason: { type: "string", minLength: 1 },
    applyUrl: { type: ["string", "null"] },
  },
} as const;

const validate = new Ajv({ allErrors: true }).compile(schema);

let client: Anthropic | null = null;
const getClient = (): Anthropic => (client ??= new Anthropic());

/** Models are told not to fence. Stripping one is formatting, not invention. */
function unfence(raw: string): string {
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? raw).trim();
}

export const liveAsk: Asker = async (excerpt, insist) => {
  const profile = studentProfile();
  if (profile === null) throw new Error("RASID_STUDENT_PROFILE is not set");

  const response = await getClient().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(profile),
    messages: [
      {
        role: "user",
        content: insist ? `${excerpt}\n\nReturn valid JSON only.` : excerpt,
      },
    ],
  });

  return {
    text: response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(""),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
};

/**
 * One word, before the seventeen fields.
 *
 * Measured: a full classification returns about seven hundred output tokens,
 * and output is seven-tenths of the bill. Nineteen pages in twenty are not
 * announcements, and paying seven hundred tokens to be told so — four times a
 * day, on a hundred and forty news pages — is where the money went.
 *
 * This asks the same model the same question in a form that can be answered in
 * one word, at roughly a thirtieth of the cost, and only the pages that say yes
 * are asked the expensive question.
 *
 * The instruction is deliberately biased. "If in doubt, say yes" is not
 * hedging: a false yes costs one cent, and a false no is an announcement nobody
 * ever looks at, which is the failure this whole application exists to prevent.
 * Pages already known to be about training skip this stage entirely.
 */
export const TRIAGE_PROMPT = `أنت تفحص نصّ صفحة من موقع جهة سعودية.

السؤال الوحيد: هل تحتوي هذه الصفحة على إعلان عن فرصة تدريب أو تدريب تعاوني أو
برنامج للطلاب أو الخريجين؟

أجب بكلمة واحدة فقط: نعم أو لا.

إن ترددت، أو كان النصّ ناقصاً، أو احتمل الأمرين — قل نعم. كلفة "نعم" الخاطئة
لا شيء، وكلفة "لا" الخاطئة أن يفوت الطالب فرصته.`;

export interface TriageResult {
  looksLikeAnnouncement: boolean;
  usage: Usage;
}

/**
 * The cheap first pass. Any answer that is not a clear "no" counts as yes,
 * including an error: this stage may only ever save money, never lose a page.
 */
/**
 * Enough of a page to answer one word, and no more.
 *
 * The first version sent the whole six-thousand-character excerpt to a question
 * whose answer is "yes" or "no", and input then accounted for three-quarters of
 * what the cheap stage cost. A yes/no does not need the whole page: it needs
 * the top, where announcements announce themselves, and the neighbourhood of
 * whatever training word got the page this far — because the free filter
 * already established there is one, and a page whose only mention is buried at
 * the bottom is exactly the page a naive head-slice would lose.
 */
const TRIAGE_HEAD = 1_200;
const TRIAGE_AROUND = 600;

export function triageExcerpt(text: string): string {
  const head = text.slice(0, TRIAGE_HEAD);
  const at = text.search(/تدريب|تعاون|متدرب|تمهير|co-?op|intern|trainee|training/i);
  if (at < 0 || at < TRIAGE_HEAD) return head;
  const from = Math.max(0, at - TRIAGE_AROUND / 2);
  return `${head}\n…\n${text.slice(from, from + TRIAGE_AROUND)}`;
}

export async function triage(text: string): Promise<TriageResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return { looksLikeAnnouncement: true, usage };

  try {
    const response = await getClient().messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 8,
      system: TRIAGE_PROMPT,
      messages: [{ role: "user", content: triageExcerpt(text) }],
    });
    usage.inputTokens = response.usage.input_tokens;
    usage.outputTokens = response.usage.output_tokens;

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    /*
     * Only an unambiguous no is a no. Anything else goes on to be judged.
     *
     * No `\b` after the Arabic: a word boundary in JavaScript is defined
     * against [A-Za-z0-9_], so the position after لا is only a boundary when a
     * Latin letter follows it. "لا" on its own, or "لا." — the two things the
     * model actually replies — did not match, and every Arabic no was read as a
     * yes. The filter saved nothing and nobody would have noticed except by the
     * bill.
     */
    return { looksLikeAnnouncement: !/^\s*(لا|no\b)/i.test(answer), usage };
  } catch {
    // A failed triage must not be able to hide a page. It costs a cent to be
    // wrong in this direction and a semester to be wrong in the other.
    return { looksLikeAnnouncement: true, usage };
  }
}

export async function classify(text: string, ask: Asker = liveAsk): Promise<ClassifyResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  /*
   * Falsy, not `undefined`. GitHub Actions substitutes an unconfigured secret
   * with the empty string, so the loud, designed `no_credentials` failure never
   * fired in CI — it went to the API with an empty key and came back as an
   * opaque transport error instead of saying plainly that the key was missing.
   */
  if (ask === liveAsk && !process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      ok: false,
      stage: "no_credentials",
      reason: "ANTHROPIC_API_KEY is not set, so nothing was classified",
      attempts: 0,
      usage,
    };
  }
  if (ask === liveAsk && studentProfile() === null) {
    return {
      ok: false,
      stage: "no_profile",
      reason:
        "RASID_STUDENT_PROFILE is not set and .profile.local is missing; nothing was classified, because a verdict for the wrong student is worse than none",
      attempts: 0,
      usage,
    };
  }

  const excerpt = text.slice(0, MAX_EXCERPT_CHARS);
  let last: { stage: "api" | "parse" | "schema"; reason: string } = {
    stage: "api",
    reason: "not attempted",
  };

  // Spec section 5.3: one retry, with "Return valid JSON only." appended.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      const reply = await ask(excerpt, attempt === 2);
      raw = reply.text;
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
    } catch (err) {
      // The SDK already retried 429s and 5xx. Reaching here means the call
      // genuinely failed, and a failed call is not an absence of news.
      const reason =
        err instanceof Anthropic.APIError
          ? `${err.constructor.name} ${err.status ?? ""}: ${err.message}`.trim()
          : err instanceof Error
            ? err.message
            : String(err);
      last = { stage: "api", reason };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(raw));
    } catch {
      last = { stage: "parse", reason: `reply was not JSON: ${raw.slice(0, 160)}` };
      continue;
    }

    if (!validate(parsed)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ");
      last = { stage: "schema", reason: `reply did not match the schema: ${detail}` };
      continue;
    }

    // An announcement without a title is not a reply we can store: the title
    // is what the user reads in the list. A non-announcement may omit it.
    const value = parsed as Classification;
    if (value.isTrainingAnnouncement && !value.titleAr?.trim()) {
      last = {
        stage: "schema",
        reason: "reply claims an announcement but gives no titleAr",
      };
      continue;
    }

    return { ok: true, value, attempts: attempt, usage };
  }

  return { ok: false, stage: last.stage, reason: last.reason, attempts: 2, usage };
}
