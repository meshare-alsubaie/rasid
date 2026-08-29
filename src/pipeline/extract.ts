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
const CHROME = "script,style,noscript,svg,template,nav,header,footer,aside";

function stripBody(document: Doc): string {
  for (const el of document.querySelectorAll(CHROME)) el.remove();
  return squash(document.body?.textContent ?? "");
}

/** Below this, Readability has almost certainly locked onto a nav block. */
const MIN_ARTICLE_CHARS = 200;

export function extract(html: string, url: string): Extracted {
  const { document } = parseHTML(html);
  const title = squash(document.title ?? "") || null;

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

  if (!text) text = stripBody(document);

  return { title, text, hash: sha256(text), method, chars: text.length };
}
