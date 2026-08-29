/**
 * Fetch one source twice and show where the extracted text differs.
 *
 * A source that reports "changed" on every run defeats hash-based change
 * detection and would bill the classifier every six hours for nothing. This
 * tells you whether the page really changed or just carries a token, a
 * timestamp or a rotating banner.
 *
 *   npm run diff-source -- https://example.gov.sa/page
 */
import { extract } from "../src/pipeline/extract";
import { fetchPage } from "../src/pipeline/fetch";
import { PER_HOST_GAP_MS } from "../src/pipeline/agent";

const url = process.argv[2];
if (!url) {
  console.error("usage: npm run diff-source -- <url>");
  process.exit(1);
}

const grab = async (): Promise<string> => {
  const res = await fetchPage(url, PER_HOST_GAP_MS);
  if (!res.ok) throw new Error(res.error);
  return extract(res.html, url).text;
};

const a = await grab();
const b = await grab();

if (a === b) {
  console.log(`stable: both fetches extracted the same ${a.length} chars.`);
  process.exit(0);
}

let i = 0;
while (i < a.length && i < b.length && a[i] === b[i]) i++;
const window = 140;
console.log(`differs at char ${i} of ${a.length}/${b.length}\n`);
console.log(`run 1: ...${a.slice(Math.max(0, i - 40), i + window)}`);
console.log(`\nrun 2: ...${b.slice(Math.max(0, i - 40), i + window)}`);
