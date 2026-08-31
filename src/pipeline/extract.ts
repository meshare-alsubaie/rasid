/**
 * Readable text out of a page, plus the hash that drives change detection.
 *
 * Spec section 5.2: hash the extracted main text per source and only send it on
 * when the hash changes, so quiet days cost nothing at the classifier.
 *
 * Readability is tried first because it strips navigation, cookie banners and
 * footers, which is exactly the boilerplate that would otherwise churn the hash
 * on every run. Many Saudi government portals render their content with
 * JavaScript and defeat it, so a stripped-body fallback keeps those sources
 * usable rather than silently dropping them. Which path ran is recorded: text
 * from the fallback is noisier, and a reader should know that.
 */
import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** linkedom's document. The DOM lib is not loaded, so this is the honest type. */
type Doc = ReturnType<typeof parseHTML>["document"];

export interface Extracted {
  title: string | null;
  text: string;
  hash: string;
  method: "readability" | "body_fallback";
  chars: number;
  /**
   * The page split into blocks, for working out what actually changed.
   *
   * Taken from the stripped body rather than from `text`, deliberately. Which
   * extractor won is a property of this run, not of the page: a page hovering
   * around the Readability threshold flips between the two and every block
   * looks new, which both churns the hash and re-bills the classifier for a
   * page that never moved. The stripped body is the same text either way.
   */
  blocks: string[];
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Chrome that is not the page's content, dropped before hashing.
 *
 * This is not cosmetic. `mim` reported a change on every single run while its
 * page text was byte-identical between two back-to-back fetches, because the
 * fallback path hashes the whole document: a rotating news strip or a nav
 * counter is enough to churn the hash and, in Phase 3, to re-bill the
 * classifier every six hours for a page that never moved.
 */
/*
 * `header` and `aside` were on this list and have been taken off.
 *
 * They were removed for the same churn reason, but Saudi portals routinely put
 * "آخر الأخبار" and the announcement strip itself in an `<aside>`, and several
 * put the seasonal banner in the `<header>`. Stripping them meant an
 * announcement could appear on a watched page and change nothing we could see —
 * the exact failure this whole pipeline exists to prevent. Churn is now handled
 * where it belongs, by only sending the blocks that changed, so a rotating news
 * strip costs one small block instead of a whole page.
 */
const CHROME = "script,style,noscript,svg,template,nav,footer";

function stripBody(document: Doc): string {
  for (const el of document.querySelectorAll(CHROME)) el.remove();
  return squash(document.body?.textContent ?? "");
}

/**
 * Split into sentence-sized pieces for change detection.
 *
 * Blank lines are gone by the time text reaches here, so this splits on
 * sentence enders in both scripts and keeps the pieces long enough to be
 * meaningful on their own. Very short fragments are dropped: a lone number or a
 * menu word carries no announcement and only adds noise to the comparison.
 */
export function blocksOf(text: string): string[] {
  return text
    .split(/(?<=[.!?۔؟])\s+|\s*[|·•]\s*/u)
    .map((b) => b.trim())
    .filter((b) => b.length >= 25);
}

/** Below this, Readability has almost certainly locked onto a nav block. */
const MIN_ARTICLE_CHARS = 200;

/**
 * A page that answers 200 and says it is missing.
 *
 * `moj.gov.sa/…/JobsAndTraining.aspx` returns HTTP 200 with the title
 * "الصفحة غير موجودة 404". Nothing in the transport is wrong, so the source is
 * recorded healthy, the text hashes and classifies as not-an-announcement, and
 * the page stays green for ever while showing nothing. The status code is the
 * server's claim; the title is the page's own.
 */
const SOFT_404 =
  /^\s*(?:404|error)\b|\b404\b.*\b(?:not found|error)\b|not found|page (?:not|cannot be) found|الصفحة غير موجودة|الصفحة غير متوفرة|عذرا.{0,20}لم يتم العثور/i;

export function isSoft404(title: string | null): boolean {
  return title !== null && SOFT_404.test(title);
}

const EMPTY: Extracted = {
  title: null,
  text: "",
  hash: sha256(""),
  method: "body_fallback",
  chars: 0,
  blocks: [],
};

export function extract(html: string, url: string): Extracted {
  /*
   * An empty or headless body is a page, not an exception.
   *
   * linkedom's `document.title` reaches through `documentElement`, which is
   * null when there is no markup at all — so an empty response threw a
   * TypeError out of `extract` and took the whole round with it, from a fetch
   * that had succeeded. A server answering 200 with nothing is unusual and not
   * rare, and it deserves an empty extract and a recorded failure, not a crash.
   */
  if (typeof html !== "string" || html.trim() === "") return EMPTY;

  const { document } = parseHTML(html);
  let title: string | null;
  try {
    title = squash(document.title ?? "") || null;
  } catch {
    title = null;
  }

  /*
   * Hashed and blocked from the stripped body, always, whichever extractor
   * ends up supplying the text below. Change detection has to answer "did this
   * page move", and that answer must not depend on which of our two readers
   * happened to win this run.
   */
  const stable = stripBody(parseHTML(html).document);

  let text = "";
  let method: Extracted["method"] = "body_fallback";

  try {
    // Readability mutates the document, so hand it a copy the fallback outlives.
    const clone = parseHTML(html).document;
    // It reads these to resolve relative links; linkedom leaves them unset.
    for (const prop of ["baseURI", "documentURI"] as const) {
      if (!(prop in clone)) Object.defineProperty(clone, prop, { value: url });
    }
    // `as never` because @mozilla/readability is typed against the DOM lib,
    // which this project does not load. Casting beats pulling in all of DOM.
    const article = new Readability(clone as never).parse();
    const candidate = squash(article?.textContent ?? "");
    if (candidate.length >= MIN_ARTICLE_CHARS) {
      text = candidate;
      method = "readability";
    }
  } catch {
    // A parser quirk is not a fetch failure. Fall through to the body text.
  }

  /*
   * Readability can win with a fragment and throw the page away.
   *
   * It is accepted whenever it clears 200 characters, and on a listing page it
   * happily returns the facet labels: the ministry's catalogue of 242 courses
   * yielded 431 characters of icon names and not one result, while the stripped
   * body held 23,905. Losing 98% of a page is not a cleaner extraction, it is a
   * different page — so when the two disagree by that much, the fuller one is
   * the one that was actually published.
   */
  if (text && stable.length > text.length * 5 && stable.length > MIN_ARTICLE_CHARS) {
    text = stable;
    method = "body_fallback";
  }

  if (!text) text = stable;

  return {
    title,
    text,
    hash: sha256(stable),
    method,
    chars: text.length,
    blocks: blocksOf(stable),
  };
}
